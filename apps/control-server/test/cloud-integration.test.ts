import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { buildApp, type ControlApp } from '../src/app.js';
import { Store } from '../src/store.js';
import { signObject, type S3Config } from '../src/objects.js';
import { requireCloudTestDatabase } from './cloud-guard.js';

const databaseUrl=process.env.TEST_DATABASE_URL;
if(databaseUrl)requireCloudTestDatabase(databaseUrl,process.env.TEST_MIGRATION_DATABASE_URL);
test('cloud PostgreSQL: tenant RLS, pairing, durable dispatch, replay accounting and revocation', {skip:!databaseUrl,timeout:120000},async()=>{
  if(!process.env.TEST_MIGRATION_DATABASE_URL)throw new Error('TEST_MIGRATION_DATABASE_URL is required for a dedicated cloud test database');
  const store=new Store(process.env.TEST_MIGRATION_DATABASE_URL);await store.migrate();await store.close();
  const app=await buildApp({databaseUrl:databaseUrl!,jwtSecret:'cloud-integration-secret-at-least-32-bytes',allowDevAuth:true,runScheduler:false});
  const call=async(method:string,path:string,token?:string,payload?:unknown,extra:Record<string,string>={})=>app.inject({method:method as any,url:`/v1${path}`,headers:{...(token?{authorization:`Bearer ${token}`} : {}),...extra},...(payload!==undefined?{payload}: {})});
  try{
    const loginA=await call('POST','/auth/dev',undefined,{email:`a-${randomUUID()}@example.com`});assert.equal(loginA.statusCode,200,'Cloud test login A must succeed before authorization checks');const a=loginA.json();
    const loginB=await call('POST','/auth/dev',undefined,{email:`b-${randomUUID()}@example.com`});assert.equal(loginB.statusCode,200,'Cloud test login B must succeed before authorization checks');const b=loginB.json();
    assert.ok(a.access_token);assert.notEqual(a.user.tenant_id,b.user.tenant_id);
    app.control.store.tenants=async()=>[a.user.tenant_id,b.user.tenant_id];
    const keys=generateKeyPairSync('ed25519');
    const pair=(await call('POST','/device-pairings',undefined,{name:'Cloud integration Mac',public_key:keys.publicKey.export({type:'spki',format:'pem'}).toString()})).json();
    const claim=await call('POST','/device-pairings/claim',a.access_token,{code:pair.code});assert.equal(claim.statusCode,200);const device=claim.json().device_id;
    assert.equal((await call('POST','/device-pairings/claim',b.access_token,{code:pair.code})).statusCode,409);
    const challenge=(await call('POST','/devices/auth/challenge',undefined,{device_id:device})).json();
    const proof={device_id:device,nonce:challenge.nonce,signature:sign(null,Buffer.from(challenge.challenge),keys.privateKey).toString('base64')};
    const deviceAuth=await call('POST','/devices/auth/token',undefined,proof);assert.equal(deviceAuth.statusCode,200);const token=deviceAuth.json().access_token;
    assert.equal((await call('POST','/devices/auth/token',undefined,proof)).statusCode,401);
    assert.equal((await call('PUT',`/devices/${device}/capabilities`,token,{generation:1,engines:[{engine:'codex',ready:true,models:['integration-model']}],tools:['browser','memory'],slots:{browser:1,worker:1}})).statusCode,200);
    const key=randomUUID(),taskRequest={goal:'Read a controlled fixture',engine:'codex',device_id:device};
    const created=await call('POST','/tasks',a.access_token,taskRequest,{'idempotency-key':key});assert.equal(created.statusCode,200);const task=created.json();
    assert.equal((await call('POST','/tasks',a.access_token,taskRequest,{'idempotency-key':key})).json().id,task.id);
    assert.equal((await call('GET',`/tasks/${task.id}`,b.access_token)).statusCode,404);
    assert.equal((await call('GET','/devices',b.access_token)).json().items.length,0);
    await app.control.tick();const commands=(await call('GET','/node/commands',token)).json().items;assert.equal(commands.length,1);
    const command=commands[0],accepted=await call('POST',`/node/runs/${command.payload.run_id}/accept`,token,{command_id:command.payload.command_id,lease_epoch:command.payload.lease_epoch});assert.equal(accepted.statusCode,200);
    const run=accepted.json().run;
    const fullResult='完整任务报告。'.repeat(400);
    await app.control.store.tenant(a.user.tenant_id,async tx=>{await tx.put('checkpoints',{task_id:task.id,run_id:run.id,checkpoint:{completed:true,result_text:fullResult,binding:{internal_only:'not returned'}}});});
    const resultRuns=(await call('GET',`/tasks/${task.id}/runs`,a.access_token)).json().items;
    assert.equal(resultRuns[0].result_text,fullResult);assert.equal(resultRuns[0].checkpoint,undefined);assert.equal(resultRuns[0].binding,undefined);
    const message={protocol_version:'1.0',message_id:randomUUID(),kind:'usage.report',sent_at:new Date().toISOString(),payload:{device_id:device,run_id:run.id,lease_epoch:run.lease_epoch,producer_id:randomUUID(),producer_seq:'1',request_key:'request-1',usage_revision:1,engine:'codex',model_id:'integration-model',category:'worker',input_tokens:100,output_tokens:10,cached_input_tokens:0,reasoning_tokens:null,cost:{source:'estimated',quality:'final',amount:'0.1',currency:'USD',price_version_id:randomUUID()}}};
    const report=()=>call('POST','/node/reports',token,{messages:[message]});assert.equal((await report()).json().accepted.length,1);assert.equal((await report()).json().accepted.length,1);
    assert.equal((await call('GET','/costs/summary',a.access_token)).json().totals[0].amount,'0.1');assert.equal((await call('GET','/costs/summary',b.access_token)).json().request_count,0);
    const unknown={...message,message_id:randomUUID(),payload:{...message.payload,producer_seq:'2',request_key:'request-2',cost:{source:'unavailable',quality:'missing',amount:null,currency:null,price_version_id:null}}};
    assert.equal((await call('POST','/node/reports',token,{messages:[unknown]})).json().accepted.length,1);
    const summary=(await call('GET','/costs/summary',a.access_token)).json();assert.equal(summary.request_count,2);assert.equal(summary.unknown_count,1);
    assert.equal((await call('GET','/costs/summary?from=invalid',a.access_token)).statusCode,422);
    assert.equal((await call('GET','/costs/series?from=2026-11-18T13:00:00Z&to=2026-11-18T12:00:00Z',a.access_token)).statusCode,422);
    const msg=(await call('POST','/messages',a.access_token,{client_message_id:randomUUID(),text:'只在指定电脑处理',execution_preference:{engine:'codex',device_id:device,selection_mode:'pinned'}})).json();
    const leader=await call('POST','/assistant/lease/claim',token,{});assert.equal(leader.statusCode,200);const assistantHeaders={'x-assistant-epoch':leader.json().epoch};
    const plan=(await call('POST','/assistant/plans',token,{source_message_id:msg.id},assistantHeaders)).json();
    assert.equal((await call('POST',`/assistant/plans/${plan.id}/propose`,token,{items:[{item_key:'bad',goal:'不得改引擎',engine:'grok',device_id:device}]},assistantHeaders)).statusCode,422);
    const proposal=await call('POST',`/assistant/plans/${plan.id}/propose`,token,{items:[{item_key:'safe',title:'确认后执行',goal:'依照原目标',deliverables:['交付结果与来源'],engine:'codex',device_id:device}],summary:'确认目标和交付标准后执行'},assistantHeaders);assert.equal(proposal.statusCode,200);assert.equal(proposal.json().items[0].deliverables[0],'交付结果与来源');
    assert.equal((await call('POST',`/assistant/plans/${plan.id}/commit`,token,{items:proposal.json().items},assistantHeaders)).statusCode,409);
    assert.equal((await call('GET','/tasks',a.access_token)).json().items.length,1);
    const confirmation=(await call('POST','/messages',a.access_token,{client_message_id:randomUUID(),text:'确认'})).json();
    const confirmed=await call('POST',`/assistant/plans/${plan.id}/confirm`,token,{source_message_id:confirmation.id},assistantHeaders);assert.equal(confirmed.statusCode,200);assert.equal(confirmed.json().tasks.length,1);
    assert.equal((await call('POST',`/assistant/plans/${plan.id}/confirm`,token,{source_message_id:confirmation.id},assistantHeaders)).json().tasks[0].id,confirmed.json().tasks[0].id);
    assert.equal((await call('GET','/tasks',a.access_token)).json().items.length,2);
    const follow=(await call('POST','/messages',a.access_token,{client_message_id:randomUUID(),text:'补充当前任务',task_id:task.id})).json();
    const inbox=(await call('GET','/assistant/inbox',token,undefined,assistantHeaders)).json();assert.ok(inbox.items.every((m:any)=>m.id!==follow.id));
    const refreshed=(await call('GET',`/tasks/${task.id}`,a.access_token)).json();
    await app.control.store.tenant(a.user.tenant_id,async tx=>{const value=await tx.need('runs',run.id);await tx.put('runs',{...value,state:'result_unknown'});});
    assert.equal((await call('POST',`/tasks/${task.id}/actions`,a.access_token,{action:'retry'},{'if-match':`"${refreshed.version}"`})).statusCode,409);
    const rls=await app.control.store.tenant(b.user.tenant_id,tx=>tx.get('tasks',task.id));assert.equal(rls,null);
    const logout=await call('POST','/auth/logout',a.access_token,{});assert.equal(logout.statusCode,200);assert.equal((await call('GET','/tasks',a.access_token)).statusCode,401);
  }finally{await app.close();}
});

test('cloud PostgreSQL: human-control expiry releases the browser and uncertain runs block redispatch', {skip:!databaseUrl,timeout:120000},async()=>{
  const app=await buildApp({databaseUrl:databaseUrl!,jwtSecret:'cloud-browser-control-test-at-least-32-bytes',allowDevAuth:true,runScheduler:false});
  try{
    const login=await app.inject({method:'POST',url:'/v1/auth/dev',payload:{email:`control-${randomUUID()}@example.com`}});assert.equal(login.statusCode,200,'Cloud control test login must succeed before creating fixtures');const session=login.json(),tenant=session.user.tenant_id,headers={authorization:`Bearer ${session.access_token}`};
    const fixture=await app.control.store.tenant(tenant,async tx=>{
      const device=await tx.put('devices',{name:'Control lease fixture',last_seen_at:new Date().toISOString(),capabilities:{generation:1,engines:[{engine:'codex',ready:true,models:['fixture']}],slots:{worker:1}}});
      const task=await app.control.service.createTask(tx,{goal:'Paused browser fixture',engine:'codex',device_id:device.id});
      const run=await tx.put('runs',{task_id:task.id,device_id:device.id,engine:'codex',model_id:'fixture',state:'paused',lease_epoch:'1',lease_expires_at:new Date().toISOString()});
      await tx.put('tasks',{...task,status:'paused',current_run_id:run.id});
      const queued=await app.control.service.createTask(tx,{goal:'Wait for human to release',engine:'codex',device_id:device.id});
      return{device,task,run,queued};
    });
    const viewResponse=await app.inject({method:'POST',url:`/v1/runs/${fixture.run.id}/views`,headers,payload:{}});assert.equal(viewResponse.statusCode,200);const viewId=viewResponse.json().id;
    assert.equal((await app.inject({method:'POST',url:`/v1/views/${viewId}/control`,headers,payload:{}})).json().status,'active');
    await app.control.service.dispatchTenant(tenant);
    assert.equal((await app.control.store.tenant(tenant,tx=>tx.need('tasks',fixture.queued.id))).current_run_id,null,'A valid human control lease blocks automatic work');
    await app.control.store.tenant(tenant,async tx=>{const v=await tx.need('views',viewId);await tx.put('views',{...v,expires_at:new Date(Date.now()-1000).toISOString(),control_expires_at:new Date(Date.now()-1000).toISOString()});});
    app.control.store.tenants=async()=>[tenant];await app.control.tick();
    const state=await app.control.store.tenant(tenant,async tx=>({view:await tx.need('views',viewId),task:await tx.need('tasks',fixture.task.id),queued:await tx.need('tasks',fixture.queued.id),commands:await tx.all('commands')}));
    assert.equal(state.view.state,'closed');assert.equal(state.view.control_requested,false);assert.equal(state.task.status,'paused');assert.ok(state.queued.current_run_id);
    assert.ok(state.commands.some(c=>c.kind==='view.control'&&c.payload.enabled===false));assert.ok(state.commands.some(c=>c.kind==='view.stop'));
    const third=await app.control.store.tenant(tenant,async tx=>{const r=await tx.need('runs',state.queued.current_run_id);await tx.put('runs',{...r,state:'result_unknown'});return app.control.service.createTask(tx,{goal:'Must wait for reconciliation',engine:'codex',device_id:fixture.device.id});});
    await app.control.service.dispatchTenant(tenant);assert.equal((await app.control.store.tenant(tenant,tx=>tx.need('tasks',third.id))).current_run_id,null);
    const queued=await app.control.store.tenant(tenant,tx=>tx.need('tasks',fixture.queued.id));
    const reconciled=await app.inject({method:'POST',url:`/v1/tasks/${queued.id}/reconciliation`,headers:{...headers,'if-match':`"${queued.version}"`},payload:{outcome:'not_applied',note:'The controlled test proves that no side effect occurred'}});assert.equal(reconciled.statusCode,200);
    await app.control.service.dispatchTenant(tenant);assert.ok((await app.control.store.tenant(tenant,tx=>tx.need('tasks',third.id))).current_run_id);
  }finally{await app.close();}
});

test('cloud PostgreSQL and private S3: authenticated artifact upload, finalize and download', {skip:!databaseUrl||process.env.S3_BUCKET!=='super-agent-test',timeout:120000},async()=>{
  const accessKey=process.env.S3_ACCESS_KEY_ID??process.env.S3_ACCESS_KEY,secretKey=process.env.S3_SECRET_ACCESS_KEY??process.env.S3_SECRET_KEY;
  if(!process.env.S3_ENDPOINT||!accessKey||!secretKey)throw new Error('Dedicated test S3 settings are required');
  const s3:S3Config={endpoint:process.env.S3_ENDPOINT,bucket:'super-agent-test',region:process.env.S3_REGION??'cn-beijing',accessKey,secretKey};
  const app=await buildApp({databaseUrl:databaseUrl!,jwtSecret:'cloud-s3-integration-secret-at-least-32-bytes',allowDevAuth:true,runScheduler:false,s3});
  let objectKey:string|undefined;
  try{
    const login=await app.inject({method:'POST',url:'/v1/auth/dev',payload:{email:`s3-${randomUUID()}@example.com`}});assert.equal(login.statusCode,200);const session=login.json(),headers={authorization:`Bearer ${session.access_token}`};
    const keys=generateKeyPairSync('ed25519');
    const pair=(await app.inject({method:'POST',url:'/v1/device-pairings',payload:{name:'Artifact fixture Mac',public_key:keys.publicKey.export({type:'spki',format:'pem'}).toString()}})).json();
    const claim=await app.inject({method:'POST',url:'/v1/device-pairings/claim',headers,payload:{code:pair.code}});assert.equal(claim.statusCode,200);const deviceId=claim.json().device_id;
    const challenge=(await app.inject({method:'POST',url:'/v1/devices/auth/challenge',payload:{device_id:deviceId}})).json();
    const deviceAuth=await app.inject({method:'POST',url:'/v1/devices/auth/token',payload:{device_id:deviceId,nonce:challenge.nonce,signature:sign(null,Buffer.from(challenge.challenge),keys.privateKey).toString('base64')}});assert.equal(deviceAuth.statusCode,200);
    const deviceHeaders={authorization:`Bearer ${deviceAuth.json().access_token}`};
    assert.equal((await app.inject({method:'PUT',url:`/v1/devices/${deviceId}/capabilities`,headers:deviceHeaders,payload:{generation:1,engines:[{engine:'codex',ready:true,models:['fixture']}],tools:['files'],slots:{worker:1,browser:1}}})).statusCode,200);
    const taskResponse=await app.inject({method:'POST',url:'/v1/tasks',headers,payload:{goal:'Read and publish controlled task artifacts',engine:'codex',device_id:deviceId}});assert.equal(taskResponse.statusCode,200);const task=taskResponse.json();
    const foreignTask=(await app.inject({method:'POST',url:'/v1/tasks',headers,payload:{goal:'Separate task artifact scope',engine:'codex',device_id:deviceId}})).json();
    app.control.store.tenants=async()=>[session.user.tenant_id];await app.control.tick();
    const commands=(await app.inject({method:'GET',url:'/v1/node/commands',headers:deviceHeaders})).json().items;
    const command=commands.find((c:any)=>c.payload.task_id===task.id)||commands[0];assert.ok(command);
    const accept=await app.inject({method:'POST',url:`/v1/node/runs/${command.payload.run_id}/accept`,headers:deviceHeaders,payload:{command_id:command.payload.command_id,lease_epoch:command.payload.lease_epoch}});assert.equal(accept.statusCode,200);
    const runHeaders={...deviceHeaders,'x-run-ticket':accept.json().run_ticket};assert.equal(accept.json().task.id,task.id);
    const content=Buffer.from(`super-agent integration ${randomUUID()}`);
    const request=await app.inject({method:'POST',url:'/v1/artifacts/uploads',headers,payload:{name:'integration.txt',mime:'text/plain',size:content.length,task_id:task.id}});assert.equal(request.statusCode,200);const upload=request.json();
    objectKey=`${session.user.tenant_id}/${upload.artifact_id}/content`;
    const put=await fetch(upload.upload_url,{method:'PUT',headers:upload.upload_headers,body:content});assert.ok(put.ok,`private test upload status ${put.status}`);
    const finalize=await app.inject({method:'POST',url:`/v1/artifacts/${upload.artifact_id}/finalize`,headers,payload:{}});assert.equal(finalize.statusCode,200);assert.equal(finalize.json().status,'ready');
    const download=await app.inject({method:'GET',url:`/v1/artifacts/${upload.artifact_id}/download`,headers});assert.equal(download.statusCode,200);
    const actual=await fetch(download.json().url);assert.ok(actual.ok);assert.deepEqual(Buffer.from(await actual.arrayBuffer()),content);
    const unsigned=new URL(download.json().url);unsigned.search='';assert.notEqual((await fetch(unsigned)).status,200,'Private object must reject unsigned reads');
    const workerList=await app.inject({method:'GET',url:'/v1/artifacts',headers:runHeaders});assert.equal(workerList.statusCode,200);assert.deepEqual(workerList.json().items.map((a:any)=>a.id),[upload.artifact_id]);assert.equal(workerList.json().items[0].object_key,undefined);
    assert.equal((await app.inject({method:'GET',url:`/v1/artifacts/${upload.artifact_id}/download`,headers:runHeaders})).statusCode,200,'Current worker can read user task input without a source run');
    assert.equal((await app.inject({method:'GET',url:`/v1/artifacts?task_id=${foreignTask.id}`,headers:runHeaders})).statusCode,404);
    const foreignUpload=await app.inject({method:'POST',url:'/v1/artifacts/uploads',headers,payload:{name:'foreign.txt',mime:'text/plain',size:1,task_id:foreignTask.id}});assert.equal(foreignUpload.statusCode,200);
    assert.equal((await app.inject({method:'GET',url:`/v1/artifacts/${foreignUpload.json().artifact_id}/download`,headers:runHeaders})).statusCode,404,'Run ticket cannot read another task in the same tenant');
    await app.control.store.tenant(session.user.tenant_id,async tx=>{const a=await tx.need('artifacts',upload.artifact_id);await tx.put('artifacts',{...a,run_id:randomUUID()});});
    assert.equal((await app.inject({method:'GET',url:`/v1/artifacts/${upload.artifact_id}/download`,headers:runHeaders})).statusCode,200,'A new run can read an earlier output for its own task');
    assert.equal((await app.inject({method:'POST',url:`/v1/artifacts/${upload.artifact_id}/finalize`,headers:runHeaders,payload:{}})).statusCode,404,'A new run cannot finalize another run upload');
    const other=(await app.inject({method:'POST',url:'/v1/auth/dev',payload:{email:`s3-other-${randomUUID()}@example.com`}})).json();
    assert.equal((await app.inject({method:'GET',url:`/v1/artifacts/${upload.artifact_id}/download`,headers:{authorization:`Bearer ${other.access_token}`}})).statusCode,404);
  }finally{if(objectKey)await fetch(signObject(s3,'DELETE',objectKey),{method:'DELETE'});await app.close();}
});

test('cloud PostgreSQL: Recall actor bindings are encrypted, tenant scoped and cannot share an external account', {skip:!databaseUrl,timeout:120000},async()=>{
  const externalActor=randomUUID(),externalMemory=randomUUID();
  const recallFetch=(async(input:URL|string|Request,init?:RequestInit)=>{
    const path=new URL(String(input)).pathname;
    if(path==='/api/auth/me')return Response.json({user:{id:externalActor,email:'mock-recall@example.com'}});
    if(path==='/api/memories')return Response.json({memories:[{id:externalMemory,content:'已有记忆，仅用于mock',type:'fact',version:3,tags:[],chainId:externalMemory,updatedAt:new Date().toISOString()}]});
    return Response.json({error:'not found'},{status:404});
  }) as typeof fetch;
  const app=await buildApp({databaseUrl:databaseUrl!,jwtSecret:'cloud-recall-integration-secret-at-least-32-bytes',allowDevAuth:true,runScheduler:false,recallFetch});
  try{
    const loginA=await app.inject({method:'POST',url:'/v1/auth/dev',payload:{email:`recall-a-${randomUUID()}@example.com`}}),loginB=await app.inject({method:'POST',url:'/v1/auth/dev',payload:{email:`recall-b-${randomUUID()}@example.com`}});
    assert.equal(loginA.statusCode,200,'Recall test login A must succeed before memory checks');assert.equal(loginB.statusCode,200,'Recall test login B must succeed before memory checks');const a=loginA.json(),b=loginB.json();
    const headersA={authorization:`Bearer ${a.access_token}`},headersB={authorization:`Bearer ${b.access_token}`};
    assert.equal((await app.inject({method:'GET',url:'/v1/memories',headers:headersB})).statusCode,503);
    const saved=await app.inject({method:'PUT',url:'/v1/settings/memory',headers:headersA,payload:{url:'https://recall.aimo.plus',token:'mock-alice-pat'}});assert.equal(saved.statusCode,200);assert.equal(saved.json().configured,true);assert.ok(!saved.body.includes('mock-alice-pat'));assert.ok(!saved.body.includes('ciphertext'));
    const list=await app.inject({method:'GET',url:'/v1/memories',headers:headersA});assert.equal(list.statusCode,200);assert.equal(list.json().items[0].id,externalMemory);
    assert.equal((await app.inject({method:'PUT',url:'/v1/settings/memory',headers:headersB,payload:{url:'https://recall.aimo.plus',token:'mock-alice-pat'}})).statusCode,409);
    const raw=await app.control.store.tenant(a.user.tenant_id,tx=>tx.get('memory_bindings',a.user.tenant_id));assert.ok(raw?.secret);assert.ok(!JSON.stringify(raw).includes('mock-alice-pat'));
    assert.equal(await app.control.store.tenant(b.user.tenant_id,tx=>tx.get('memory_bindings',a.user.tenant_id)),null);
  }finally{await app.close();}
});
