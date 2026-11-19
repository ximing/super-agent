import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID,generateKeyPairSync,sign } from 'node:crypto';
import { buildApp } from '../src/app.js';
import { validatePlanGraph,deliverables,DEFAULT_DELIVERABLE } from '../src/team.js';
import { publicStep,publicEvent } from '../src/steps.js';
import { requireCloudTestDatabase } from './cloud-guard.js';

test('team graph validates dependency and parent cycles independently and supplies a review standard',()=>{
  assert.deepEqual(deliverables([]),[DEFAULT_DELIVERABLE]);
  assert.doesNotThrow(()=>validatePlanGraph([{item_key:'root',depends_on_keys:['child']},{item_key:'child',parent_item_key:'root',depends_on_keys:[]} ]));
  for(const items of [[{item_key:'a',depends_on_keys:['a']}],[{item_key:'a',depends_on_keys:['b']},{item_key:'b',depends_on_keys:['a']}],[{item_key:'a',parent_item_key:'b'},{item_key:'b',parent_item_key:'a'}],[{item_key:'a',depends_on_keys:['missing']} ]])assert.throws(()=>validatePlanGraph(items));
});
test('legacy tool records and events expose only lifecycle metadata, preserving uncertain results',()=>{
  const raw={id:randomUUID(),run_id:randomUUID(),tool:'untrusted-private-value',title:'private title',status:'result_unknown',error_code:'private error',started_at:'2026-11-19 (private canary)',completed_at:'private-canary',created_at:new Date().toISOString(),args:{password:'canary'},result:'canary',url:'canary',summary:'canary'};
  const step=publicStep(raw);assert.equal(step.tool,'other');assert.equal(step.title,'执行工具');assert.equal(step.status,'result_unknown');assert.equal(step.error_code,'result_unknown');assert.ok(!JSON.stringify(step).includes('canary'));assert.ok(!JSON.stringify(step).includes('private'));
  assert.deepEqual(publicEvent({type:'step.updated',payload:raw}).payload,step);
});

const databaseUrl=process.env.TEST_DATABASE_URL;
if(databaseUrl)requireCloudTestDatabase(databaseUrl,process.env.TEST_MIGRATION_DATABASE_URL);
test('cloud team: DAG gating, private tool timeline, independent review, event usage, failure blocking and cancellation', {skip:!databaseUrl,timeout:120000},async()=>{
  const app=await buildApp({databaseUrl:databaseUrl!,jwtSecret:'team-cloud-test-signature-at-least-32-bytes',allowDevAuth:true,runScheduler:false});
  const call=(method:string,path:string,token?:string,payload?:unknown,headers:Record<string,string>={})=>app.inject({method:method as any,url:'/v1'+path,headers:{...(token?{authorization:'Bearer '+token}:{}),...headers},...(payload===undefined?{}:{payload})});
  try{
    const login=await call('POST','/auth/dev',undefined,{email:`team-${randomUUID()}@example.com`});assert.equal(login.statusCode,200);const user=login.json(),client=user.access_token;
    const other=(await call('POST','/auth/dev',undefined,{email:`other-team-${randomUUID()}@example.com`})).json();
    const key=generateKeyPairSync('ed25519'),pair=(await call('POST','/device-pairings',undefined,{name:'Team integration Mac',public_key:key.publicKey.export({type:'spki',format:'pem'}).toString()})).json();
    const device=(await call('POST','/device-pairings/claim',client,{code:pair.code})).json().device_id;
    const challenge=(await call('POST','/devices/auth/challenge',undefined,{device_id:device})).json(),token=(await call('POST','/devices/auth/token',undefined,{device_id:device,nonce:challenge.nonce,signature:sign(null,Buffer.from(challenge.challenge),key.privateKey).toString('base64')})).json().access_token;
    assert.equal((await call('PUT',`/devices/${device}/capabilities`,token,{generation:1,engines:[{engine:'grok',ready:true,models:['fixture']}],tools:['memory'],slots:{worker:3,browser:0}})).statusCode,200);
    assert.equal((await call('GET','/devices',client)).json().items.find((value:any)=>value.id===device).capabilities.slots.browser,0);
    assert.equal((await call('PUT',`/devices/${device}/capabilities`,token,{generation:1,engines:[],tools:[],slots:{worker:1,browser:2}})).statusCode,422);
    const lease=(await call('POST','/assistant/lease/claim',token,{})).json(),leader={'x-assistant-epoch':lease.epoch};
    const source=(await call('POST','/messages',client,{client_message_id:randomUUID(),text:'分步收集资料并交付报告'})).json(),plan=(await call('POST','/assistant/plans',token,{source_message_id:source.id},leader)).json();
    const base={engine:'grok',device_id:device,deliverables:[]};
    assert.equal((await call('POST',`/assistant/plans/${plan.id}/propose`,token,{items:[{...base,item_key:'a',goal:'A',depends_on_keys:['b']},{...base,item_key:'b',goal:'B',depends_on_keys:['a']}],summary:'循环必须拒绝'},leader)).statusCode,422);
    const proposal=await call('POST',`/assistant/plans/${plan.id}/propose`,token,{items:[{...base,item_key:'a',goal:'收集资料'},{...base,item_key:'b',goal:'撰写报告',parent_item_key:'a',depends_on_keys:['a']},{...base,item_key:'c',goal:'发布摘要',parent_item_key:'a',depends_on_keys:['b']}],summary:'先核对资料，再写报告和摘要'},leader);assert.equal(proposal.statusCode,200);
    const confirmation=(await call('POST','/messages',client,{client_message_id:randomUUID(),text:'确认'})).json(),confirmed=await call('POST',`/assistant/plans/${plan.id}/confirm`,token,{source_message_id:confirmation.id},leader);assert.equal(confirmed.statusCode,200);const [a,b,c]=confirmed.json().tasks;
    assert.equal((await call('GET',`/tasks/${b.id}`,client)).json().status,'blocked');
    await call('POST','/node/heartbeat',token,{});await app.control.service.dispatchTenant(user.user.tenant_id);
    let command=(await call('GET','/node/commands',token)).json().items.find((v:any)=>v.kind==='run.start');assert.equal(command.payload.task_id,a.id);
    const accepted=(await call('POST',`/node/runs/${command.payload.run_id}/accept`,token,{command_id:command.payload.command_id,lease_epoch:command.payload.lease_epoch})).json(),run=accepted.run;
    const producer=randomUUID();let sequence=0;
    const report=async(kind:string,payload:any)=>{const message={protocol_version:'1.0',message_id:randomUUID(),kind,sent_at:new Date().toISOString(),payload:{device_id:device,run_id:run.id,lease_epoch:run.lease_epoch,producer_id:producer,producer_seq:String(++sequence),...payload}};const response=await call('POST','/node/reports',token,{messages:[message]});assert.equal(response.json().rejected.length,0,JSON.stringify(response.json().rejected));return message;};
    const stepId=randomUUID(),started=new Date().toISOString();await report('step.updated',{step_id:stepId,tool:'memory_search',status:'running',started_at:started,completed_at:null,error_code:null,args:{password:'private-canary'},result:'private-canary',title:'private-canary'});
    const finalStep=await report('step.updated',{step_id:stepId,tool:'memory_search',status:'succeeded',started_at:started,completed_at:new Date().toISOString(),error_code:null,result:'private-canary'});
    assert.equal((await call('POST','/node/reports',token,{messages:[finalStep]})).json().rejected.length,0);
    assert.ok(!JSON.stringify(await app.control.store.tenant(user.user.tenant_id,tx=>tx.need('steps',stepId))).includes('private-canary'),'Sensitive tool payload is discarded before storage');
    const checkpointResponse=await call('POST',`/node/runs/${run.id}/checkpoint`,token,{checkpoint:{completed:true,result_text:'核对结果与可读报告'}},{'x-run-ticket':accepted.run_ticket});assert.equal(checkpointResponse.statusCode,200);const checkpoint=checkpointResponse.json();
    const artifact=await app.control.store.tenant(user.user.tenant_id,tx=>tx.put('artifacts',{task_id:a.id,run_id:run.id,name:'result.txt',mime:'text/plain',size:20,status:'ready',object_key:'private-object-canary'}));
    const ended=await report('run.state',{state:'succeeded',summary:'报告已生成'});assert.equal((await call('POST','/node/reports',token,{messages:[ended]})).json().rejected.length,0);
    assert.equal((await call('GET',`/tasks/${a.id}`,client)).json().status,'awaiting_review');await call('POST','/node/heartbeat',token,{});await call('POST',`/node/runs/${run.id}/renew`,token,{lease_epoch:run.lease_epoch});await app.control.service.dispatchTenant(user.user.tenant_id);assert.equal((await call('GET',`/tasks/${b.id}`,client)).json().current_run_id,null);
    const evidence=await call('GET',`/assistant/tasks/${a.id}/evidence`,token,undefined,leader);assert.equal(evidence.statusCode,200);assert.deepEqual(evidence.json().deliverables,[DEFAULT_DELIVERABLE]);assert.ok(!evidence.body.includes('private-canary'));assert.ok(!evidence.body.includes('private-object-canary'));
    assert.equal((await call('GET',`/tasks/${a.id}/evidence`,other.access_token)).statusCode,404);assert.ok(!(await call('GET','/events',client)).body.includes('private-canary'));
    const review={run_id:run.id,verdict:'accept',summary:'人工核对完成',checks:[{deliverable_index:0,passed:true,evidence_refs:[{kind:'checkpoint',id:checkpoint.id}]}]};
    assert.equal((await call('POST',`/tasks/${a.id}/reviews`,other.access_token,review,{'if-match':String(evidence.json().task.version)})).statusCode,404);
    const forged={...review,checks:[{deliverable_index:0,passed:true,evidence_refs:[{kind:'checkpoint',id:randomUUID()}]}]};
    assert.equal((await call('POST',`/tasks/${a.id}/reviews`,client,forged,{'if-match':String(evidence.json().task.version)})).statusCode,404,'Invented evidence cannot approve a task');
    assert.equal((await call('POST',`/tasks/${a.id}/reviews`,token,review,{'if-match':String(evidence.json().task.version)})).statusCode,403);
    assert.equal((await call('POST',`/assistant/tasks/${a.id}/reviews`,token,review,{...leader,'if-match':String(evidence.json().task.version)})).statusCode,422,'Coordinator cannot accept only by repeating the worker checkpoint');
    const needs=await call('POST',`/assistant/tasks/${a.id}/reviews`,token,{run_id:run.id,verdict:'needs_input',summary:'需要人工对业务事实核对',checks:[]},{...leader,'if-match':String(evidence.json().task.version)});assert.equal(needs.statusCode,200);
    const event=(await call('GET','/assistant/events',token,undefined,leader)).json().items.find((e:any)=>e.type==='delivery.submitted');assert.ok(event);
    const usage={request_key:'review-provider-request',usage_revision:1,engine:'grok',model_id:'fixture',input_tokens:20,output_tokens:5,cost:{source:'supplier_reported',amount:'0.01',currency:'USD',quality:'final',price_version_id:null}};
    assert.equal((await call('POST',`/assistant/events/${event.id}/usage`,token,usage,leader)).statusCode,200);assert.equal((await call('POST',`/assistant/events/${event.id}/usage`,token,usage,leader)).statusCode,200);assert.equal((await call('GET','/costs/summary',client)).json().request_count,1);
    const completed={review_id:needs.json().id,message:'交付等待人工核对'},complete=await call('POST',`/assistant/events/${event.id}/complete`,token,completed,leader);assert.equal(complete.statusCode,200);assert.equal((await call('POST',`/assistant/events/${event.id}/complete`,token,completed,leader)).json().message.id,complete.json().message.id);
    const fresh=(await call('GET',`/tasks/${a.id}`,client)).json(),reviewKey=randomUUID(),headers={'if-match':String(fresh.version),'idempotency-key':reviewKey};
    const approved=await call('POST',`/tasks/${a.id}/reviews`,client,review,headers);assert.equal(approved.statusCode,200);assert.equal((await call('POST',`/tasks/${a.id}/reviews`,client,review,headers)).json().id,approved.json().id);
    assert.equal((await call('GET',`/tasks/${b.id}`,client)).json().status,'queued');assert.equal((await call('GET',`/tasks/${b.id}`,client)).json().root_task_id,a.id);
    await call('POST','/node/heartbeat',token,{});await app.control.service.dispatchTenant(user.user.tenant_id);command=(await call('GET','/node/commands',token)).json().items.find((v:any)=>v.kind==='run.start'&&v.payload.task_id===b.id);assert.ok(command);
    const next=(await call('POST',`/node/runs/${command.payload.run_id}/accept`,token,{command_id:command.payload.command_id,lease_epoch:command.payload.lease_epoch})).json();assert.equal(next.scope.dependencies[0].artifact_ids[0],artifact.id);
    assert.ok((await call('GET','/artifacts',token,undefined,{'x-run-ticket':next.run_ticket})).json().items.some((v:any)=>v.id===artifact.id));
    const failed={protocol_version:'1.0',message_id:randomUUID(),kind:'run.state',sent_at:new Date().toISOString(),payload:{device_id:device,run_id:next.run.id,lease_epoch:next.run.lease_epoch,producer_id:randomUUID(),producer_seq:'1',state:'failed',summary:'依赖测试失败'}};
    assert.equal((await call('POST','/node/reports',token,{messages:[failed]})).json().rejected.length,0);assert.equal((await call('GET',`/tasks/${c.id}`,client)).json().reason_code,'dependency_failed');
    const currentPlan=(await call('GET',`/assistant/plans/${plan.id}`,token,undefined,leader)).json();assert.equal((await call('POST',`/plans/${plan.id}/actions`,client,{action:'cancel'},{'if-match':String(currentPlan.version)})).statusCode,200);assert.equal((await call('GET',`/tasks/${c.id}`,client)).json().status,'cancelled');
    const d=(await call('POST','/tasks',client,{goal:'取消开始前任务',engine:'grok',device_id:device})).json(),e=(await call('POST','/tasks',client,{goal:'不得执行的子任务',engine:'grok',device_id:device,parent_task_id:d.id,depends_on_task_ids:[d.id]})).json();
    await call('POST','/node/heartbeat',token,{});await app.control.service.dispatchTenant(user.user.tenant_id);const live=(await call('GET',`/tasks/${d.id}`,client)).json();assert.equal((await call('POST',`/tasks/${d.id}/actions`,client,{action:'cancel'},{'if-match':String(live.version)})).statusCode,200);assert.equal((await call('GET',`/tasks/${e.id}`,client)).json().status,'cancelled');
    const raceTask=(await call('POST','/tasks',client,{goal:'并发取消与成功回报',engine:'grok',device_id:device})).json();
    await call('POST','/node/heartbeat',token,{});await app.control.service.dispatchTenant(user.user.tenant_id);const raceCommand=(await call('GET','/node/commands',token)).json().items.find((value:any)=>value.kind==='run.start'&&value.payload.task_id===raceTask.id);
    const raceContext=(await call('POST',`/node/runs/${raceCommand.payload.run_id}/accept`,token,{command_id:raceCommand.payload.command_id,lease_epoch:raceCommand.payload.lease_epoch})).json();
    const raceCurrent=(await call('GET',`/tasks/${raceTask.id}`,client)).json(),finish={protocol_version:'1.0',message_id:randomUUID(),kind:'run.state',sent_at:new Date().toISOString(),payload:{device_id:device,run_id:raceContext.run.id,lease_epoch:raceContext.run.lease_epoch,producer_id:randomUUID(),producer_seq:'1',state:'succeeded',summary:'结束与取消竞争'}};
    const [cancelResponse,finishResponse]=await Promise.all([call('POST',`/tasks/${raceTask.id}/actions`,client,{action:'cancel'},{'if-match':String(raceCurrent.version)}),call('POST','/node/reports',token,{messages:[finish]})]);
    assert.equal(finishResponse.json().rejected.length,0);assert.ok([200,412].includes(cancelResponse.statusCode));
    if(cancelResponse.statusCode===412){const latest=(await call('GET',`/tasks/${raceTask.id}`,client)).json();assert.equal((await call('POST',`/tasks/${raceTask.id}/actions`,client,{action:'cancel'},{'if-match':String(latest.version)})).statusCode,200);}
    assert.equal((await call('GET',`/tasks/${raceTask.id}`,client)).json().status,'cancelled');
  }finally{await app.close();}
});
