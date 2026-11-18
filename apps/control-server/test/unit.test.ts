import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Auth } from '../src/auth.js';
import { ApiError, Store, type Doc } from '../src/store.js';
import { Service, matchVersion, safeMoney, costRange } from '../src/service.js';
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

test('S3 authorization is HTTPS, tenant-path scoped, short-lived and deterministic',()=>{
  const settings={endpoint:'https://storage.example.com',region:'us-east-1',bucket:'private-files',accessKey:'EXAMPLEACCESS',secretKey:'example-secret'};
  const url=new URL(signObject(settings,'PUT','tenant-a/file b/content',300,new Date('2026-11-18T12:00:00Z')));
  assert.equal(url.pathname,'/private-files/tenant-a/file%20b/content');assert.equal(url.searchParams.get('X-Amz-Expires'),'300');
  assert.match(url.searchParams.get('X-Amz-Signature')!,/^[a-f0-9]{64}$/);
  assert.notEqual(url.searchParams.get('X-Amz-Signature'),new URL(signObject(settings,'GET','tenant-a/file b/content',300,new Date('2026-11-18T12:00:00Z'))).searchParams.get('X-Amz-Signature'));
  assert.throws(()=>signObject({...settings,endpoint:'http://storage.example.com'},'GET','file'),ApiError);
});
