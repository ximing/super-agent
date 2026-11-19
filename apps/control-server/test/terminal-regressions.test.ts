import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID,generateKeyPairSync,sign } from 'node:crypto';
import { buildApp } from '../src/app.js';
import { Auth } from '../src/auth.js';
import { requireCloudTestDatabase } from './cloud-guard.js';

const databaseUrl=process.env.TEST_DATABASE_URL;
if(databaseUrl)requireCloudTestDatabase(databaseUrl,process.env.TEST_MIGRATION_DATABASE_URL);
test('cloud terminal regressions: fresh envelopes cannot revive cancellation, replace evidence or confirm a cancelled plan', {skip:!databaseUrl,timeout:120000},async()=>{
  const config={databaseUrl:databaseUrl!,jwtSecret:'terminal-regression-test-secret-at-least-32-bytes',allowDevAuth:true,runScheduler:false},app=await buildApp(config);
  const call=(method:string,path:string,token?:string,payload?:unknown,headers:Record<string,string>={})=>app.inject({method:method as any,url:'/v1'+path,headers:{...(token?{authorization:'Bearer '+token}:{}),...headers},...(payload===undefined?{}:{payload})});
  try{
    const login=await call('POST','/auth/dev',undefined,{email:`terminal-${randomUUID()}@example.com`});assert.equal(login.statusCode,200);const session=login.json(),client=session.access_token,tenant=session.user.tenant_id;
    const keys=generateKeyPairSync('ed25519'),pair=(await call('POST','/device-pairings',undefined,{name:'Terminal regression Mac',public_key:keys.publicKey.export({type:'spki',format:'pem'}).toString()})).json(),device=(await call('POST','/device-pairings/claim',client,{code:pair.code})).json().device_id;
    const challenge=(await call('POST','/devices/auth/challenge',undefined,{device_id:device})).json(),token=(await call('POST','/devices/auth/token',undefined,{device_id:device,nonce:challenge.nonce,signature:sign(null,Buffer.from(challenge.challenge),keys.privateKey).toString('base64')})).json().access_token;
    await call('PUT',`/devices/${device}/capabilities`,token,{generation:1,engines:[{engine:'codex',ready:true,models:['fixture']}],tools:['memory'],slots:{worker:1,browser:0}});
    const principal={type:'device' as const,tenant,id:device,device},auth=new Auth(app.control.store,config);
    const seed=async(cancel=false)=>app.control.store.tenant(tenant,async tx=>{
      const task=await app.control.service.createTask(tx,{goal:'Terminal regression fixture',engine:'codex',device_id:device});
      const run=await tx.put('runs',{task_id:task.id,device_id:device,engine:'codex',model_id:'fixture',lease_epoch:'1',lease_expires_at:new Date(Date.now()+60000).toISOString(),state:cancel?'stopping':'running',summary:'fixture'});
      await tx.put('tasks',{...task,current_run_id:run.id,status:cancel?'pausing':'running',pending_action:cancel?'cancel':null});
      return{task,run,ticket:await auth.runTicket(principal,run),producer:randomUUID()};
    });
    const send=async(fixture:any,state:string,seq:number)=>{
      const message={protocol_version:'1.0',message_id:randomUUID(),kind:'run.state',sent_at:new Date().toISOString(),payload:{device_id:device,run_id:fixture.run.id,lease_epoch:'1',producer_id:fixture.producer,producer_seq:String(seq),state,summary:`envelope ${seq}`}};
      const response=await call('POST','/node/reports',token,{messages:[message]});assert.deepEqual(response.json().rejected,[]);return message;
    };
    const cancelled=await seed(true);await send(cancelled,'succeeded',1);const firstCancelled=(await call('GET',`/tasks/${cancelled.task.id}`,client)).json();assert.equal(firstCancelled.status,'cancelled');assert.equal(firstCancelled.cancellation_requested,true);
    const firstEnvelope=await send(cancelled,'succeeded',2);assert.ok(firstEnvelope.message_id);const secondCancelled=(await call('GET',`/tasks/${cancelled.task.id}`,client)).json();assert.equal(secondCancelled.status,'cancelled');assert.equal(secondCancelled.version,firstCancelled.version);
    assert.equal((await app.control.store.tenant(tenant,tx=>tx.all('task_deliveries'))).filter(d=>d.run_id===cancelled.run.id).length,0);
    const lateUsage={protocol_version:'1.0',message_id:randomUUID(),kind:'usage.report',sent_at:new Date().toISOString(),payload:{device_id:device,run_id:cancelled.run.id,lease_epoch:'1',producer_id:cancelled.producer,producer_seq:'3',request_key:'late-cancelled-request',usage_revision:1,engine:'codex',model_id:'fixture',input_tokens:4,output_tokens:1,cost:{source:'unavailable',amount:null,currency:null}}};
    assert.deepEqual((await call('POST','/node/reports',token,{messages:[lateUsage]})).json().rejected,[]);assert.equal((await call('GET','/costs/summary',client)).json().request_count,1);assert.equal((await call('GET',`/tasks/${cancelled.task.id}`,client)).json().version,firstCancelled.version);
    const dependent=await app.control.store.tenant(tenant,tx=>app.control.service.createTask(tx,{goal:'Must stay blocked',engine:'codex',device_id:device,depends_on_task_ids:[cancelled.task.id]}));await app.control.service.dispatchTenant(tenant);assert.equal((await call('GET',`/tasks/${dependent.id}`,client)).json().status,'blocked');
    for(const state of ['failed','cancelled']){
      const fixture=await seed();await send(fixture,state,1);const before=(await call('GET',`/tasks/${fixture.task.id}`,client)).json();await send(fixture,state,2);const after=(await call('GET',`/tasks/${fixture.task.id}`,client)).json();assert.equal(after.status,state);assert.equal(after.version,before.version);assert.equal((await app.control.store.tenant(tenant,tx=>tx.all('task_deliveries'))).filter(d=>d.run_id===fixture.run.id).length,0);
    }
    const success=await seed(),c0={completed:true,result_text:'C0 verified result'};
    const saved=await call('POST',`/node/runs/${success.run.id}/checkpoint`,token,{checkpoint:c0},{'x-run-ticket':success.ticket});assert.equal(saved.statusCode,200);const checkpointId=saved.json().id;
    await send(success,'succeeded',1);const pending=(await call('GET',`/tasks/${success.task.id}`,client)).json();assert.equal(pending.status,'awaiting_review');await send(success,'succeeded',2);assert.equal((await call('GET',`/tasks/${success.task.id}`,client)).json().version,pending.version);
    assert.equal((await app.control.store.tenant(tenant,tx=>tx.all('task_deliveries'))).filter(d=>d.run_id===success.run.id).length,1);
    const review=await call('POST',`/tasks/${success.task.id}/reviews`,client,{run_id:success.run.id,verdict:'accept',summary:'Manual verification of C0',checks:[{deliverable_index:0,passed:true,evidence_refs:[{kind:'checkpoint',id:checkpointId}]}]},{'if-match':String(pending.version)});assert.equal(review.statusCode,200);
    const accepted=(await call('GET',`/tasks/${success.task.id}`,client)).json();await send(success,'succeeded',3);assert.equal((await call('GET',`/tasks/${success.task.id}`,client)).json().version,accepted.version);
    const c1={completed:true,result_text:'C1 must never replace the verified result'};
    assert.equal((await call('POST',`/node/runs/${success.run.id}/checkpoint`,token,{checkpoint:c1})).statusCode,403);
    const oldTicket=await auth.runTicket(principal,{...success.run,lease_epoch:'0'});assert.equal((await call('POST',`/node/runs/${success.run.id}/checkpoint`,token,{checkpoint:c1},{'x-run-ticket':oldTicket})).statusCode,409);
    assert.equal((await call('POST',`/node/runs/${success.run.id}/checkpoint`,token,{checkpoint:c1},{'x-run-ticket':success.ticket})).statusCode,409);
    const replay=await call('POST',`/node/runs/${success.run.id}/checkpoint`,token,{checkpoint:c0},{'x-run-ticket':success.ticket});assert.equal(replay.statusCode,200);assert.equal(replay.json().id,checkpointId);assert.equal((await call('GET',`/tasks/${success.task.id}`,client)).json().version,accepted.version);
    // Simulate a legacy stray row without changing the frozen delivery. Even
    // such historical data cannot silently become current accepted evidence.
    await app.control.store.tenant(tenant,async tx=>{await tx.put('checkpoints',{task_id:success.task.id,run_id:success.run.id,checkpoint:c1});await tx.put('artifacts',{task_id:success.task.id,run_id:success.run.id,name:'late.txt',mime:'text/plain',size:1,status:'ready',object_key:'never-expose'});});
    const evidence=(await call('GET',`/tasks/${success.task.id}/evidence`,client)).json();assert.equal(evidence.result_text,c0.result_text);assert.equal(evidence.checkpoint.id,checkpointId);assert.equal(evidence.artifacts.length,0);
    const consumer=await app.control.store.tenant(tenant,tx=>app.control.service.createTask(tx,{goal:'Consume frozen accepted result',engine:'codex',device_id:device,depends_on_task_ids:[success.task.id]}));assert.equal((await app.control.store.tenant(tenant,tx=>app.control.service.team.dependencies(tx,consumer)))[0].result_text,c0.result_text);
    for(const state of ['stopping','running']){const fixture=await seed();await app.control.store.tenant(tenant,async tx=>{const run=await tx.need('runs',fixture.run.id);await tx.put('runs',{...run,state});});assert.equal((await call('POST',`/node/runs/${fixture.run.id}/checkpoint`,token,{checkpoint:{completed:false,summary:'last safe pause/failure checkpoint'}},{'x-run-ticket':fixture.ticket})).statusCode,200);}
    const lease=(await call('POST','/assistant/lease/claim',token,{})).json(),leader={'x-assistant-epoch':lease.epoch};
    const propose=async()=>{
      const source=(await call('POST','/messages',client,{client_message_id:randomUUID(),text:'Plan cancellation regression'})).json(),plan=(await call('POST','/assistant/plans',token,{source_message_id:source.id},leader)).json();
      const proposed=(await call('POST',`/assistant/plans/${plan.id}/propose`,token,{items:[{item_key:'only',goal:'Must be explicitly confirmed',deliverables:[],engine:'codex',device_id:device}],summary:'Cancel this pending plan'},leader)).json();
      const confirmation=(await call('POST','/messages',client,{client_message_id:randomUUID(),text:'确认 '+plan.id.slice(0,8)})).json();return{source,plan:proposed,confirmation};
    };
    const prepared=await propose(),count=(await call('GET','/tasks',client)).json().items.length;
    assert.equal((await call('POST',`/plans/${prepared.plan.id}/actions`,client,{action:'cancel'},{'if-match':String(prepared.plan.version)})).statusCode,200);
    assert.equal((await call('POST',`/assistant/plans/${prepared.plan.id}/confirm`,token,{source_message_id:prepared.confirmation.id},leader)).statusCode,409);assert.equal((await call('GET','/tasks',client)).json().items.length,count);assert.ok(!(await call('GET','/assistant/plans?state=awaiting_confirmation',token,undefined,leader)).json().items.some((p:any)=>p.id===prepared.plan.id));
    const racing=await propose(),[confirmed,cancelResponse]=await Promise.all([call('POST',`/assistant/plans/${racing.plan.id}/confirm`,token,{source_message_id:racing.confirmation.id},leader),call('POST',`/plans/${racing.plan.id}/actions`,client,{action:'cancel'},{'if-match':String(racing.plan.version)})]);assert.ok([200,409].includes(confirmed.statusCode));assert.ok([200,412].includes(cancelResponse.statusCode));
    if(cancelResponse.statusCode===412){const current=(await call('GET',`/assistant/plans/${racing.plan.id}`,token,undefined,leader)).json();assert.equal((await call('POST',`/plans/${racing.plan.id}/actions`,client,{action:'cancel'},{'if-match':String(current.version)})).statusCode,200);}
    assert.equal((await call('POST',`/assistant/plans/${racing.plan.id}/confirm`,token,{source_message_id:racing.confirmation.id},leader)).statusCode,409);
    const stray=await app.control.store.tenant(tenant,tx=>app.control.service.createTask(tx,{goal:'Stale queued work must not dispatch',engine:'codex',device_id:device,plan_id:racing.plan.id},randomUUID()));await app.control.service.dispatchTenant(tenant);const blocked=(await call('GET',`/tasks/${stray.id}`,client)).json();assert.equal(blocked.status,'cancelled');assert.equal(blocked.current_run_id,null);
  }finally{await app.close();}
});
