import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,writeFile,rm,readFile,readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { Store,MIGRATION_LOCK_KEY } from '../src/store.js';
import { requireCloudTestDatabase } from './cloud-guard.js';

const unused='postgresql://unused:unused@cloud-test.invalid/unused';
const isDdl=(sql:string)=>/^(CREATE|ALTER|REVOKE|GRANT|DO)\b/i.test(sql.trim());

async function temporaryMigrations(files:Record<string,string>){
  const directory=await mkdtemp(join(tmpdir(),'super-agent-migrations-'));
  for(const [name,sql] of Object.entries(files))await writeFile(join(directory,name),sql);
  return{directory,url:pathToFileURL(directory+'/'),cleanup:()=>rm(directory,{recursive:true,force:true})};
}

// A narrow SQL boundary double: filesystem discovery/checksums, migration
// selection, transaction ordering and error propagation use the real Store.
function fakeStore(){
  const store=new Store(unused),queries:string[]=[],ledger=new Map<string,string>();
  let schema=false,table=false;
  const client={release(){},async query(sql:string,values?:unknown[]){
    queries.push(sql);
    if(sql.includes('AS schema_owner'))return{rows:schema?[{schema_owner:'owner',table_owner:table?'owner':null,table_id:table?1:null,caller:'owner'}]:[]};
    if(sql.startsWith('CREATE SCHEMA'))schema=true;
    if(sql.startsWith('CREATE TABLE super_agent_private.schema_migrations'))table=true;
    if(sql.startsWith('SELECT name,checksum'))return{rows:[...ledger].map(([name,checksum])=>({name,checksum}))};
    if(sql.startsWith('INSERT INTO super_agent_private.schema_migrations'))ledger.set(String(values![0]),String(values![1]));
    return{rows:[]};
  }};
  store.pool.connect=(async()=>client) as any;
  return{store,queries,ledger};
}

test('versioned migration sorts files and a second invocation performs no DDL or migration writes',async()=>{
  const files=await temporaryMigrations({'002_second.sql':"SELECT 'second migration';",'001_first.sql':"SELECT 'first migration';"}),fake=fakeStore();
  try{
    await fake.store.migrate(files.url);
    assert.ok(fake.queries.indexOf("SELECT 'first migration';")<fake.queries.indexOf("SELECT 'second migration';"));
    assert.equal(fake.ledger.size,2);assert.ok(fake.queries.some(sql=>sql.startsWith('REVOKE ALL ON SCHEMA')));
    fake.queries.length=0;await fake.store.migrate(files.url);
    assert.equal(fake.queries.some(isDdl),false);assert.equal(fake.queries.some(sql=>sql.startsWith('INSERT')),false);
    assert.equal(fake.queries.includes("SELECT 'first migration';"),false);
    assert.equal(fake.queries[1],'SELECT pg_advisory_xact_lock($1)');assert.equal(fake.queries.at(-1),'COMMIT');
  }finally{await fake.store.close();await files.cleanup();}
});

test('changed applied migration checksum fails before executing SQL and rolls back',async()=>{
  const files=await temporaryMigrations({'001_first.sql':"SELECT 'original';"}),fake=fakeStore();
  try{
    await fake.store.migrate(files.url);const original=fake.ledger.get('001_first.sql');
    await writeFile(join(files.directory,'001_first.sql'),"SELECT 'modified';");fake.queries.length=0;
    await assert.rejects(()=>fake.store.migrate(files.url),/Applied migration checksum mismatch: 001_first.sql/);
    assert.equal(fake.ledger.get('001_first.sql'),original);assert.equal(fake.queries.includes("SELECT 'modified';"),false);
    assert.equal(fake.queries.at(-1),'ROLLBACK');
  }finally{await fake.store.close();await files.cleanup();}
});

test('tenant obtains the shared migration gate before roles or business queries and rejects nested transactions',async()=>{
  const fake=fakeStore();
  try{
    await fake.store.tenant(randomUUID(),async tx=>{
      assert.deepEqual(fake.queries.slice(0,3),['BEGIN','SELECT pg_advisory_xact_lock_shared($1)','SET LOCAL ROLE super_agent_app']);
      await assert.rejects(()=>fake.store.tenant(tx.tenant,async()=>null),/Nested tenant transactions/);
    });
    assert.equal(fake.queries.filter(q=>q==='BEGIN').length,1);assert.equal(fake.queries.at(-1),'COMMIT');
  }finally{await fake.store.close();}
});

const databaseUrl=process.env.TEST_DATABASE_URL,migrationUrl=process.env.TEST_MIGRATION_DATABASE_URL;
if(databaseUrl)requireCloudTestDatabase(databaseUrl,migrationUrl);
test('cloud migration ledger is owner-private, repeat/concurrent calls do not run DDL, and its gate excludes tenant work', {skip:!databaseUrl,timeout:60000},async()=>{
  const owner=new Store(migrationUrl!),app=new Store(databaseUrl!);
  let releaseTenant:()=>void=()=>{},tenantWork:Promise<unknown>|undefined;
  try{
    // Never bootstrap a live database from this test. An operator must first
    // stop the legacy API, back up, and apply the ledger-enabled migration.
    const ready=await owner.pool.query("SELECT to_regclass('super_agent_private.schema_migrations') AS ledger");
    assert.ok(ready.rows[0].ledger,'Apply the migration ledger during the coordinated maintenance window before cloud tests');
    const before=(await owner.pool.query('SELECT name,checksum,applied_at FROM super_agent_private.schema_migrations ORDER BY name')).rows;
    const queries:string[]=[],connect=owner.pool.connect.bind(owner.pool);
    owner.pool.connect=(async()=>{
      const c=await connect();
      return{query:async(sql:string,values?:unknown[])=>{queries.push(sql);return c.query(sql,values);},release:()=>c.release()};
    }) as any;
    await Promise.all([owner.migrate(),owner.migrate()]);
    owner.pool.connect=connect as any;
    assert.equal(queries.some(isDdl),false);assert.equal(queries.some(sql=>sql.startsWith('INSERT')),false);
    assert.deepEqual((await owner.pool.query('SELECT name,checksum,applied_at FROM super_agent_private.schema_migrations ORDER BY name')).rows,before);
    const permissions=await app.pool.query("SELECT has_schema_privilege(current_user,'super_agent_private','USAGE') AS usage");assert.equal(permissions.rows[0].usage,false);
    await assert.rejects(()=>app.pool.query('SELECT name FROM super_agent_private.schema_migrations'),(error:any)=>error.code==='42501');

    const source=new URL('../migrations/',import.meta.url),contents:Record<string,string>={};
    for(const name of await readdir(source))if(name.endsWith('.sql'))contents[name]=await readFile(new URL(name,source),'utf8');
    contents[before[0].name]+='\n-- intentionally changed only in a temporary test directory\n';
    const files=await temporaryMigrations(contents);
    try{await assert.rejects(()=>owner.migrate(files.url),/checksum mismatch/);}finally{await files.cleanup();}
    let entered:()=>void=()=>{};const active=new Promise<void>(resolve=>{entered=resolve;}),release=new Promise<void>(resolve=>{releaseTenant=resolve;});
    tenantWork=app.tenant(randomUUID(),async()=>{entered();await release;});await active;
    const probe=await connect();
    try{
      await probe.query('BEGIN');
      assert.equal((await probe.query('SELECT pg_try_advisory_xact_lock($1) AS acquired',[MIGRATION_LOCK_KEY])).rows[0].acquired,false,'DDL gate must wait for the active tenant transaction');
      releaseTenant();await tenantWork;tenantWork=undefined;
      // Other test processes may already be waiting for this same exclusive
      // lock. Wait our turn instead of treating legitimate contention as a bug.
      await probe.query('SELECT pg_advisory_xact_lock($1)',[MIGRATION_LOCK_KEY]);
      assert.equal((await probe.query("SELECT EXISTS(SELECT 1 FROM pg_locks WHERE pid=pg_backend_pid() AND locktype='advisory' AND classid=0 AND objid=$1 AND mode='ExclusiveLock' AND granted) AS acquired",[MIGRATION_LOCK_KEY])).rows[0].acquired,true);
      let tenantEntered=false;const waiting=app.tenant(randomUUID(),async()=>{tenantEntered=true;});tenantWork=waiting;
      // Observe the actual blocked shared lock in PostgreSQL, without timing
      // sleeps or changing any ledger rows.
      let blocked=false;
      for(let attempt=0;attempt<50&&!blocked;attempt++){
        blocked=(await probe.query("SELECT EXISTS(SELECT 1 FROM pg_locks WHERE locktype='advisory' AND classid=0 AND objid=$1 AND mode='ShareLock' AND NOT granted) AS blocked",[MIGRATION_LOCK_KEY])).rows[0].blocked;
        if(!blocked)await new Promise(resolve=>setTimeout(resolve,10));
      }
      assert.equal(blocked,true,'Tenant shared lock waits in PostgreSQL behind the exclusive migration gate');assert.equal(tenantEntered,false);
      await probe.query('COMMIT');await waiting;tenantWork=undefined;assert.equal(tenantEntered,true);
    }finally{await probe.query('ROLLBACK');probe.release();}
  }finally{releaseTenant();if(tenantWork)await tenantWork;await owner.close();await app.close();}
});
