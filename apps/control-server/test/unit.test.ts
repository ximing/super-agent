import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Auth } from '../src/auth.js';
import { ApiError, Store, type Doc } from '../src/store.js';
import { Service, conflictingMessage, matchVersion, safeMoney, costRange } from '../src/service.js';
import { PlanService } from '../src/plans.js';
import { publicTask } from '../src/team.js';
import { buildApp } from '../src/app.js';
import { signObject } from '../src/objects.js';
import { requireCloudTestDatabase } from './cloud-guard.js';

const secret='unit-test-secret-that-is-at-least-thirty-two-bytes';
const config={databaseUrl:'postgresql://unused:unused@cloud-test.invalid/unused',jwtSecret:secret,runScheduler:false};

test('default server rejects unauthenticated data and does not enable developer login',async()=>{
  const app=await buildApp(config);
  try{
    assert.equal((await app.inject({method:'GET',url:'/health'})).statusCode,200);
    assert.equal((await app.inject({method:'GET',url:'/v1/tasks'})).statusCode,401);
    assert.equal((await app.inject({method:'POST',url:'/v1/auth/dev',payload:{email:'someone@example.com'}})).statusCode,404);
    assert.equal((await app.inject({method:'POST',url:'/v1/auth/exchange',payload:{access_token:'not-a-real-token'}})).statusCode,503);
    const auth=await app.inject({method:'GET',url:'/v1/auth/config'});assert.equal(auth.json().mode,'oidc');
  }finally{await app.close();}
});

test('database connection failure returns retryable 503 without logging users out or exposing connection details',async()=>{
  const app=await buildApp({...config,allowDevAuth:true});
  const auth=new Auth(app.control.store,config),tenant=randomUUID(),user=randomUUID();
  const token=await auth.token({type:'client',tenant,sub:user,sid:randomUUID()});
  app.control.store.pool.query=(async()=>{throw Object.assign(new Error('sensitive database endpoint must remain private'),{code:'ECONNRESET'});}) as any;
  try{
    const response=await app.inject({method:'GET',url:'/v1/tasks',headers:{authorization:`Bearer ${token}`}});
    assert.equal(response.statusCode,503);assert.equal(response.json().error.code,'database_unavailable');assert.equal(response.json().error.retryable,true);
    assert.ok(!response.body.includes('sensitive'));assert.ok(!response.body.includes('ECONNRESET'));
    const login=await app.inject({method:'POST',url:'/v1/auth/dev',payload:{email:'temporary-outage@example.com'}});assert.equal(login.statusCode,503);
    const invalid=await app.inject({method:'GET',url:'/v1/tasks',headers:{authorization:'Bearer invalid-token'}});assert.equal(invalid.statusCode,401);
  }finally{await app.close();}
});

test('JWT signature and run ticket bind tenant, device, run and current lease',async()=>{
  const store={} as Store,auth=new Auth(store,config),tenant=randomUUID(),device=randomUUID(),runId=randomUUID();
  const principal={type:'device' as const,tenant,id:device,device};
  const run={id:runId,device_id:device,lease_epoch:'8',lease_expires_at:new Date(Date.now()+30000).toISOString(),state:'running'};
  const token=await auth.runTicket(principal,run);
  const tx={need:async()=>run} as any;
  assert.equal((await auth.run(principal,tx,token)).id,runId);
  await assert.rejects(()=>auth.run({...principal,tenant:randomUUID()},tx,token),error=>error instanceof ApiError&&error.status===403);
  await assert.rejects(()=>auth.run({...principal,device:randomUUID()},tx,token),error=>error instanceof ApiError&&error.status===403);
  await assert.rejects(()=>auth.run(principal,tx,token,randomUUID()),error=>error instanceof ApiError&&error.status===403);
  run.lease_epoch='9';await assert.rejects(()=>auth.run(principal,tx,token),error=>error instanceof ApiError&&error.code==='run_lease_invalid');
  const forged=token.slice(0,-8)+'aaaaaaaa';await assert.rejects(()=>auth.decode(forged),error=>error instanceof ApiError&&error.status===401);
});

test('assistant operations reject stale or foreign-device leadership',async()=>{
  const auth=new Auth({} as Store,config),tenant=randomUUID(),device=randomUUID(),p={type:'device' as const,tenant,id:device,device};
  const lease={device_id:device,epoch:'3',expires_at:new Date(Date.now()+10000).toISOString()};const tx={get:async()=>lease} as any;
  assert.equal((await auth.assistant(p,tx,'3')).epoch,'3');
  await assert.rejects(()=>auth.assistant(p,tx,'2'),error=>error instanceof ApiError&&error.code==='assistant_lease_invalid');
  await assert.rejects(()=>auth.assistant({...p,device:randomUUID()},tx,'3'),error=>error instanceof ApiError&&error.code==='assistant_lease_invalid');
});

test('cost summary preserves currencies and unknown amounts instead of adding them as free usage',()=>{
  const service=new Service({} as Store,{} as Auth);
  const records=[
    {input_tokens:100,output_tokens:10,cost:{source:'supplier_reported',amount:'0.0038',currency:'USD'}},
    {input_tokens:200,output_tokens:20,cost:{source:'supplier_reported',amount:'0.0002',currency:'USD'}},
    {input_tokens:300,output_tokens:30,cost:{source:'estimated',amount:'0.05',currency:'CNY'}},
    {input_tokens:400,output_tokens:40,cost:{source:'unavailable',amount:null,currency:null}}
  ];
  const result=service.summary(records);
  assert.equal(result.request_count,4);assert.equal(result.unknown_count,1);assert.equal(result.coverage,0.75);
  assert.deepEqual(result.totals,[{currency:'USD',source:'supplier_reported',amount:'0.004'},{currency:'CNY',source:'estimated',amount:'0.05'}]);
  assert.equal(result.input_tokens,1000);assert.equal(result.output_tokens,100);
  assert.equal(safeMoney('0.0000000001'),'0.0000000001');
  assert.throws(()=>safeMoney('-1'),ApiError);assert.throws(()=>safeMoney(0.3),ApiError);
});

test('optimistic mutation requires a current version',()=>{
  assert.throws(()=>matchVersion(undefined,{version:4}),error=>error instanceof ApiError&&error.status===428);
  assert.throws(()=>matchVersion('"3"',{version:4}),error=>error instanceof ApiError&&error.status===412);
  assert.doesNotThrow(()=>matchVersion('"4"',{version:4}));
});

test('cloud integration guard refuses production, local, mismatched databases and shared owner roles',()=>{
  const app='postgresql://service:example@cloud.example.com/super_agent_test',owner='postgresql://owner:example@cloud.example.com/super_agent_test';
  assert.doesNotThrow(()=>requireCloudTestDatabase(app,owner));
  assert.throws(()=>requireCloudTestDatabase(app.replace('_test','_prod'),owner.replace('_test','_prod')));
  assert.throws(()=>requireCloudTestDatabase(app.replace('cloud.example.com','localhost'),owner.replace('cloud.example.com','localhost')));
  assert.throws(()=>requireCloudTestDatabase(app,owner.replace('super_agent_test','different_test')));
  assert.throws(()=>requireCloudTestDatabase(app,app));assert.throws(()=>requireCloudTestDatabase(app,undefined));
});

test('cost date range validates timezone, ordering and maximum range',()=>{
  assert.deepEqual(costRange({from:'2026-11-01T00:00:00Z',to:'2026-11-18T00:00:00Z'}),{from:Date.parse('2026-11-01T00:00:00Z'),to:Date.parse('2026-11-18T00:00:00Z')});
  for(const q of [{from:'not-a-date'},{from:'2026-11-01'},{from:'2027-01-01T00:00:00Z',to:'2026-01-01T00:00:00Z'},{from:'2020-01-01T00:00:00Z',to:'2026-01-01T00:00:00Z'}])assert.throws(()=>costRange(q),ApiError);
});

test('a message scope is part of the client id conflict and a proposed scope survives confirm', async () => {
  assert.equal(conflictingMessage({ content: '开始', memory_scope: { sites: ['a.example'], global_preference: false } }, '开始', { sites: ['b.example'], global_preference: false }), true);
  assert.equal(conflictingMessage({ content: '开始' }, '开始', null), false);
  const tables = new Map<string, Map<string, Doc>>();
  const table = (name: string) => { if (!tables.has(name)) tables.set(name, new Map()); return tables.get(name)!; };
  const put = async (name: string, doc: Doc, id: string = doc.id ?? randomUUID()) => { const value = { ...doc, id, version: (table(name).get(id)?.version ?? 0) + 1, created_at: table(name).get(id)?.created_at ?? new Date().toISOString(), updated_at: new Date().toISOString() }; table(name).set(id, value); return value; };
  const tx = { tenant: randomUUID(), client: { query: async (sql: string) => String(sql).includes('now()') ? { rows: [{ at: new Date(Date.now() - 60000).toISOString() }] } : { rows: [] } }, get: async (name: string, id: string) => table(name).get(id) ?? null, all: async (name: string) => [...table(name).values()], need: async (name: string, id: string) => { const value = table(name).get(id); if (!value) throw new ApiError(404, 'not_found', '资源不存在'); return value; }, put, emit: async () => {} } as any;
  const device = await put('devices', { name: 'mac' });
  const granted = { project: 'alpha', sites: ['example.com'], global_preference: true, statuses: ['verified'], max_version: null };
  const source = await put('messages', { role: 'user', content: '请规划站点', task_id: null, memory_scope: granted });
  const plan = await put('plans', { source_message_id: source.id, state: 'draft', tasks: [], items: [] });
  const plans = new PlanService(new Service({} as Store, {} as Auth));
  const proposed = await plans.propose(tx, plan.id, { summary: '核对站点', items: [{ item_key: 'one', title: '核对', goal: '核对站点', deliverables: ['结果'], engine: 'codex', device_id: device.id, memory_scope: { sites: ['Example.COM'], global_preference: true, project: 'alpha' } }] });
  assert.deepEqual(proposed.items[0].memory_scope, { project: 'alpha', sites: ['example.com'], global_preference: true, statuses: ['verified'], max_version: null });
  assert.equal(proposed.items[0].memory_scope === undefined, false);
  const confirmation = await put('messages', { role: 'user', content: '确认', task_id: null });
  const committed = await plans.confirm(tx, plan.id, confirmation.id);
  const task = await tx.get('tasks', committed.tasks[0].id);
  assert.deepEqual(task?.scope.memory, proposed.items[0].memory_scope);
  assert.deepEqual(publicTask(task!).memory_scope, proposed.items[0].memory_scope);
  assert.equal(publicTask(task!).budget, null);
  assert.match(proposed.summary, /实际生效的记忆范围/);
  const widePlan = await put('plans', { source_message_id: source.id, state: 'draft', tasks: [], items: [] });
  await assert.rejects(() => plans.propose(tx, widePlan.id, { summary: '扩大范围', items: [{ item_key: 'wide', title: '扩大', goal: '读取另一个项目', deliverables: ['结果'], engine: 'codex', device_id: device.id, memory_scope: { project: 'beta', sites: ['b.example'], global_preference: true } }] }), (error: unknown) => error instanceof ApiError && error.code === 'memory_scope_exceeds_grant');
  const childPlan = await put('plans', { source_message_id: source.id, state: 'draft', tasks: [], items: [] });
  await assert.rejects(() => plans.propose(tx, childPlan.id, { summary: '子任务扩大', items: [
    { item_key: 'parent', title: '父', goal: '只看 a', deliverables: ['结果'], engine: 'codex', device_id: device.id, memory_scope: { project: 'alpha', sites: ['example.com'], global_preference: false } },
    { item_key: 'child', title: '子', goal: '再看 b', deliverables: ['结果'], engine: 'codex', device_id: device.id, parent_item_key: 'parent', memory_scope: { project: 'alpha', sites: ['example.com', 'b.example'], global_preference: false } },
  ] }), (error: unknown) => error instanceof ApiError && error.code === 'memory_scope_exceeds_grant');
});

test('S3 authorization is HTTPS, tenant-path scoped, short-lived and deterministic',()=>{
  const settings={endpoint:'https://storage.example.com',region:'us-east-1',bucket:'private-files',accessKey:'EXAMPLEACCESS',secretKey:'example-secret'};
  const url=new URL(signObject(settings,'PUT','tenant-a/file b/content',300,new Date('2026-11-18T12:00:00Z')));
  assert.equal(url.pathname,'/private-files/tenant-a/file%20b/content');assert.equal(url.searchParams.get('X-Amz-Expires'),'300');
  assert.match(url.searchParams.get('X-Amz-Signature')!,/^[a-f0-9]{64}$/);
  assert.notEqual(url.searchParams.get('X-Amz-Signature'),new URL(signObject(settings,'GET','tenant-a/file b/content',300,new Date('2026-11-18T12:00:00Z'))).searchParams.get('X-Amz-Signature'));
  assert.throws(()=>signObject({...settings,endpoint:'http://storage.example.com'},'GET','file'),ApiError);
});
