import pg, { type PoolClient } from 'pg';
import { randomUUID, createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { AsyncLocalStorage } from 'node:async_hooks';

export const MIGRATION_LOCK_KEY = 787425192;
const MIGRATION_SCHEMA = 'super_agent_private';
const MIGRATION_TABLE = `${MIGRATION_SCHEMA}.schema_migrations`;
const migrationsDirectory = new URL('../migrations/',import.meta.url);
const tenantContext = new AsyncLocalStorage<boolean>();

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string, public retryable = false) { super(message); }
}
export function isDatabaseUnavailable(error:unknown):boolean{
  if(!error||typeof error!=='object')return false;
  const value=error as {code?:unknown;message?:unknown};
  return typeof value.code==='string'&&(['ECONNRESET','ECONNREFUSED','ETIMEDOUT','EHOSTUNREACH','ENETUNREACH','ENOTFOUND','EPIPE','57P01','57P02','57P03','53300'].includes(value.code)||/^08\w{3}$/.test(value.code))
    ||typeof value.message==='string'&&/^(Connection terminated unexpectedly|Connection terminated due to connection timeout|timeout exceeded when trying to connect)$/i.test(value.message);
}
export const hash = (value: unknown): string => createHash('sha256').update(typeof value === 'string' ? value : stable(value)).digest('hex');
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>`${JSON.stringify(k)}:${stable(v)}`).join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}
const TABLES = new Set(['devices','tasks','runs','messages','questions','memories','memory_bindings','settings','commands','assistant_leases','plans','checkpoints','frames','views','usage_records','budgets','budget_reservations','schedules','notifications','artifacts','steps','inbox_receipts','task_deliveries','task_reviews','coordinator_events','message_processing','task_actions']);
const table = (name: string) => { if (!TABLES.has(name)) throw new Error('Invalid store table'); return `sa_${name}`; };
export type Doc = Record<string, any>;
export class Tx {
  constructor(public client: PoolClient, public tenant: string) {}
  async all(name: string, lock = false): Promise<Doc[]> {
    const result = await this.client.query(`SELECT id,data,version,created_at,updated_at FROM ${table(name)} WHERE tenant_id=$1 ORDER BY created_at,id${lock ? ' FOR UPDATE' : ''}`, [this.tenant]);
    return result.rows.map(row);
  }
  async get(name: string, id: string, lock = false): Promise<Doc | null> {
    const result = await this.client.query(`SELECT id,data,version,created_at,updated_at FROM ${table(name)} WHERE tenant_id=$1 AND id=$2${lock?' FOR UPDATE':''}`,[this.tenant,id]);
    return result.rows[0] ? row(result.rows[0]) : null;
  }
  async need(name: string,id: string,lock=false):Promise<Doc>{ const value=await this.get(name,id,lock); if(!value)throw new ApiError(404,'not_found','资源不存在'); return value; }
  async put(name: string, data: Doc, id = data.id as string || randomUUID()): Promise<Doc> {
    const clean={...data}; delete clean.version; delete clean.created_at; delete clean.updated_at; clean.id=id;
    const result=await this.client.query(`INSERT INTO ${table(name)} (tenant_id,id,data) VALUES ($1,$2,$3) ON CONFLICT (tenant_id,id) DO UPDATE SET data=EXCLUDED.data,version=${table(name)}.version+1,updated_at=now() RETURNING id,data,version,created_at,updated_at`,[this.tenant,id,clean]);
    return row(result.rows[0]);
  }
  async insertNew(name: string, data: Doc, id = data.id as string || randomUUID()): Promise<Doc | null> {
    const clean={...data}; delete clean.version; delete clean.created_at; delete clean.updated_at; clean.id=id;
    const result=await this.client.query(`INSERT INTO ${table(name)} (tenant_id,id,data) VALUES ($1,$2,$3) ON CONFLICT (tenant_id,id) DO NOTHING RETURNING id,data,version,created_at,updated_at`,[this.tenant,id,clean]);
    return result.rows[0] ? row(result.rows[0]) : null;
  }
  async remove(name:string,id:string):Promise<void>{await this.client.query(`DELETE FROM ${table(name)} WHERE tenant_id=$1 AND id=$2`,[this.tenant,id]);}
  async emit(type:string,payload:Doc,taskId:string|null=null,runId:string|null=null):Promise<void>{
    const seq=await this.client.query('INSERT INTO sa_streams (tenant_id,seq) VALUES ($1,1) ON CONFLICT (tenant_id) DO UPDATE SET seq=sa_streams.seq+1 RETURNING seq',[this.tenant]);
    const event={event_id:randomUUID(),stream_seq:String(seq.rows[0].seq),type,occurred_at:new Date().toISOString(),task_id:taskId,run_id:runId,payload};
    await this.client.query('INSERT INTO sa_events (tenant_id,seq,id,data) VALUES ($1,$2,$3,$4)',[this.tenant,event.stream_seq,event.event_id,event]);
  }
  async idempotent(identity:string|undefined,body:unknown,action:()=>Promise<Doc>):Promise<Doc>{
    if(!identity)return action();
    await this.client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`${this.tenant}:${identity}`]);
    const existing=await this.client.query('SELECT request_hash,response FROM sa_idempotency WHERE tenant_id=$1 AND identity=$2',[this.tenant,identity]);
    const digest=hash(body);
    if(existing.rows[0]){if(existing.rows[0].request_hash!==digest)throw new ApiError(409,'idempotency_conflict','相同幂等键对应不同请求');return existing.rows[0].response;}
    const response=await action();
    await this.client.query('INSERT INTO sa_idempotency (tenant_id,identity,request_hash,response) VALUES ($1,$2,$3,$4)',[this.tenant,identity,digest,response]);
    return response;
  }
}
function row(raw:Doc):Doc{return {...raw.data,id:raw.id,version:raw.version,created_at:new Date(raw.created_at).toISOString(),updated_at:new Date(raw.updated_at).toISOString()};}
export class Store {
  pool:pg.Pool;
  constructor(url:string){this.pool=new pg.Pool({connectionString:url,max:12});}
  async migrate(directory:URL=migrationsDirectory):Promise<void>{
    const names=(await readdir(directory,{withFileTypes:true})).filter(f=>f.isFile()&&f.name.endsWith('.sql')).map(f=>f.name).sort();
    if(!names.length)throw new Error('No SQL migrations found');
    const migrations=await Promise.all(names.map(async name=>{const sql=await readFile(new URL(encodeURIComponent(name),directory),'utf8');return{name,sql,checksum:hash(sql)};}));
    const c=await this.pool.connect();
    try{
      await c.query('BEGIN');
      await c.query('SELECT pg_advisory_xact_lock($1)',[MIGRATION_LOCK_KEY]);
      const catalog=await c.query(`SELECT pg_get_userbyid(n.nspowner) AS schema_owner,pg_get_userbyid(t.relowner) AS table_owner,t.oid AS table_id,current_user AS caller
        FROM pg_namespace n LEFT JOIN pg_class t ON t.relnamespace=n.oid AND t.relname='schema_migrations' WHERE n.nspname=$1`,[MIGRATION_SCHEMA]);
      const existing=catalog.rows[0];
      if(existing&&(existing.schema_owner!==existing.caller||(existing.table_id&&existing.table_owner!==existing.caller)))throw new Error('Migration ledger requires its dedicated owner connection');
      if(!existing||!existing.table_id){
        if(!existing)await c.query(`CREATE SCHEMA ${MIGRATION_SCHEMA} AUTHORIZATION CURRENT_USER`);
        await c.query(`REVOKE ALL ON SCHEMA ${MIGRATION_SCHEMA} FROM PUBLIC`);
        await c.query(`CREATE TABLE ${MIGRATION_TABLE} (name text PRIMARY KEY,checksum text NOT NULL CHECK(checksum ~ '^[0-9a-f]{64}$'),applied_at timestamptz NOT NULL DEFAULT now())`);
        // Cloud owners may have global default grants to service roles. Remove
        // every non-owner grant, including direct grants outside the app group.
        await c.query(`DO $$ DECLARE item record; recipient text; BEGIN
          FOR item IN SELECT DISTINCT acl.grantee FROM pg_namespace n CROSS JOIN LATERAL aclexplode(COALESCE(n.nspacl,acldefault('n',n.nspowner))) acl WHERE n.nspname='${MIGRATION_SCHEMA}' AND acl.grantee<>n.nspowner LOOP
            recipient:=CASE WHEN item.grantee=0 THEN 'PUBLIC' ELSE quote_ident(pg_get_userbyid(item.grantee)) END;
            EXECUTE 'REVOKE ALL ON SCHEMA ${MIGRATION_SCHEMA} FROM '||recipient;
          END LOOP;
          FOR item IN SELECT DISTINCT acl.grantee FROM pg_class t JOIN pg_namespace n ON n.oid=t.relnamespace CROSS JOIN LATERAL aclexplode(COALESCE(t.relacl,acldefault('r',t.relowner))) acl WHERE n.nspname='${MIGRATION_SCHEMA}' AND t.relname='schema_migrations' AND acl.grantee<>t.relowner LOOP
            recipient:=CASE WHEN item.grantee=0 THEN 'PUBLIC' ELSE quote_ident(pg_get_userbyid(item.grantee)) END;
            EXECUTE 'REVOKE ALL ON TABLE ${MIGRATION_TABLE} FROM '||recipient;
          END LOOP;
        END $$`);
      }
      const ledger=await c.query(`SELECT name,checksum FROM ${MIGRATION_TABLE} ORDER BY name`);
      const applied=new Map<string,string>(ledger.rows.map(r=>[r.name,r.checksum]));
      for(const name of applied.keys())if(!names.includes(name))throw new Error(`Applied migration is missing: ${name}`);
      for(const migration of migrations)if(applied.has(migration.name)&&applied.get(migration.name)!==migration.checksum)throw new Error(`Applied migration checksum mismatch: ${migration.name}`);
      for(const migration of migrations){
        if(applied.has(migration.name))continue;
        await c.query(migration.sql);
        await c.query(`INSERT INTO ${MIGRATION_TABLE}(name,checksum) VALUES($1,$2)`,[migration.name,migration.checksum]);
      }
      await c.query('COMMIT');
    }catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}
  }
  async tenant<T>(tenant:string,fn:(tx:Tx)=>Promise<T>):Promise<T>{
    if(tenantContext.getStore())throw new Error('Nested tenant transactions are not supported; reuse the current Tx');
    return tenantContext.run(true,async()=>{
      const c=await this.pool.connect();try{await c.query('BEGIN');await c.query('SELECT pg_advisory_xact_lock_shared($1)',[MIGRATION_LOCK_KEY]);await c.query('SET LOCAL ROLE super_agent_app');await c.query("SELECT set_config('app.tenant_id',$1,true)",[tenant]);const result=await fn(new Tx(c,tenant));await c.query('COMMIT');return result;}catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}
    });
  }
  async tenants():Promise<string[]>{const result=await this.pool.query('SELECT tenant_id FROM sa_users');return result.rows.map(r=>r.tenant_id);}
  async close():Promise<void>{await this.pool.end();}
}
