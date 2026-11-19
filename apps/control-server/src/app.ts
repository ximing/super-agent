import Fastify, { type FastifyInstance, type FastifyRequest, type HTTPMethods } from 'fastify';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import { randomUUID } from 'node:crypto';
import { Decimal } from 'decimal.js';
import { Auth, type Config, type Principal, text, uuid, expires, now } from './auth.js';
import { Store, Tx, ApiError, isDatabaseUnavailable, type Doc } from './store.js';
import { Service, ACTIVE, engine, matchVersion, safeMoney, redactView } from './service.js';
import { signObject } from './objects.js';
import { AgentRecallAdapter } from './recall.js';
import { PlanService } from './plans.js';
import { publicStep,publicEvent } from './steps.js';
import { graphLock,publicCoordinatorEvent,publicArtifact } from './team.js';
import { storeCheckpoint } from './checkpoints.js';
import { finalizeArtifact } from './artifact-finalizer.js';
import { NotificationService } from './notifications.js';

export type ControlApp=FastifyInstance&{control:{store:Store;service:Service;notifications:NotificationService;tick:()=>Promise<void>}};
const body=(r:FastifyRequest):Doc=>{if(r.body===undefined)return{};if(!r.body||typeof r.body!=='object'||Array.isArray(r.body))throw new ApiError(422,'invalid_body','请求需要 JSON 对象');return r.body as Doc;};
const params=(r:FastifyRequest)=>r.params as Doc;
const query=(r:FastifyRequest)=>(r.query??{}) as Doc;
const items=(values:unknown[])=>({items:values});
function limit<T>(values:T[],q:Doc):T[]{return values.slice(-Math.max(1,Math.min(1000,Number(q.limit)||200)));}
function capabilities(input:Doc):Doc{
  if(!Number.isSafeInteger(input.generation)||input.generation<1||!Array.isArray(input.engines)||input.engines.length>10||!Array.isArray(input.tools))throw new ApiError(422,'invalid_capabilities','设备能力格式无效');
  if(input.slots?.browser!==undefined&&input.slots.browser!==0&&input.slots.browser!==1)throw new ApiError(422,'invalid_capabilities','浏览器槽位只允许0或1');
  return{generation:input.generation,engines:input.engines.map((e:Doc)=>({engine:engine(e.engine),ready:e.ready===true,models:Array.isArray(e.models)?e.models.map((m:unknown)=>text(m,'model_id',200)).slice(0,100):[],local_profile_id:typeof e.local_profile_id==='string'?e.local_profile_id.slice(0,100):'default',...(typeof e.reason==='string'?{reason:e.reason.slice(0,200)}:{})})),tools:input.tools.map((t:unknown)=>text(t,'tool',100)).slice(0,100),slots:{browser:input.slots?.browser??1,worker:Math.max(1,Math.min(8,Number(input.slots?.worker)||1))}};
}

export async function buildApp(config:Config):Promise<ControlApp>{
  const store=new Store(config.databaseUrl),auth=new Auth(store,config),service=new Service(store,auth);
  const plans=new PlanService(service);
  const notifications=new NotificationService(store,{...config.notifications,encryptionKey:config.memoryEncryptionKey??config.jwtSecret});
  let serviceWork:Promise<void>|undefined,notificationWork:Promise<void>|undefined;let closing=false;
  const serviceTick=():Promise<void>=>{
    if(closing)return Promise.resolve();if(serviceWork)return serviceWork;
    const work=Promise.resolve().then(()=>service.tick());serviceWork=work;
    const clear=()=>{if(serviceWork===work)serviceWork=undefined;};void work.then(clear,clear);return work;
  };
  const notificationTick=():Promise<void>=>{
    if(closing)return Promise.resolve();if(notificationWork)return notificationWork;
    const work=Promise.resolve().then(()=>notifications.tick());notificationWork=work;
    const clear=()=>{if(notificationWork===work)notificationWork=undefined;};void work.then(clear,clear);return work;
  };
  // Tests can await both loops, while slow provider I/O cannot hold business dispatch.
  const tick=async():Promise<void>=>{const results=await Promise.allSettled([serviceTick(),notificationTick()]);const failed=results.find(r=>r.status==='rejected');if(failed?.status==='rejected')throw failed.reason;};
  const recall=new AgentRecallAdapter({encryptionKey:config.memoryEncryptionKey??config.jwtSecret,allowedOrigins:config.recallAllowedOrigins,fetch:config.recallFetch});
  const app=Object.assign(Fastify({logger:config.logger?{redact:['req.headers.authorization','req.headers.x-run-ticket','body.access_token','body.refresh_token','body.signature','body.polling_secret','body.token']}:false,bodyLimit:4*1024*1024}),{control:{store,service,notifications,tick}}) as ControlApp;
  const principals=new WeakMap<FastifyRequest,Principal>();
  const authenticate=async(r:FastifyRequest):Promise<Principal>=>{const cached=principals.get(r);if(cached)return cached;const p=await auth.principal(r.headers.authorization);principals.set(r,p);return p;};
  await app.register(cors,{origin:false});
  await app.register(rateLimit,{hook:'preHandler',max:(_r,key)=>key.startsWith('principal:')?1200:60,timeWindow:60000,keyGenerator:async r=>{if(r.headers.authorization){try{const p=await authenticate(r);return`principal:${p.type}:${p.id}`;}catch(e){if(!(e instanceof ApiError&&e.status===401))throw e;/* Invalid tokens share the anonymous IP bucket, never self-declared claims. */}}return`anonymous:${r.ip}`;}});
  app.setErrorHandler((error,request,reply)=>{
    if(error instanceof ApiError)return reply.code(error.status).send({error:{code:error.code,message:error.message,retryable:error.retryable,request_id:request.id}});
    if(isDatabaseUnavailable(error))return reply.code(503).send({error:{code:'database_unavailable',message:'数据服务暂时不可用，请稍后重试',retryable:true,request_id:request.id}});
    if((error as Doc).code==='22P02')return reply.code(422).send({error:{code:'invalid_id',message:'标识或参数格式无效',retryable:false,request_id:request.id}});
    if((error as Doc).code==='23505')return reply.code(409).send({error:{code:'conflict',message:'请求与已有记录冲突',retryable:false,request_id:request.id}});
    if((error as Doc).statusCode===429)return reply.code(429).send({error:{code:'rate_limited',message:'请求过于频繁',retryable:true,request_id:request.id}});
    request.log.error({error_code:(error as Doc).code},'Request failed');
    return reply.code(500).send({error:{code:'internal_error',message:'服务暂时不可用',retryable:true,request_id:request.id}});
  });
  const route=(method:HTTPMethods,url:string,role:'client'|'device'|'either',handler:(req:FastifyRequest,p:Principal,tx:Tx)=>Promise<unknown>)=>{
    app.route({method,url:`/v1${url}`,handler:async req=>{
      const p=await authenticate(req);if(role==='client')auth.client(p);if(role==='device')auth.device(p);
      return store.tenant(p.tenant,tx=>handler(req,p,tx));
    }});
  };
  const idempotent=(req:FastifyRequest,p:Principal,tx:Tx,fn:()=>Promise<Doc>)=>tx.idempotent(typeof req.headers['idempotency-key']==='string'?`${p.type}:${p.id}:${req.routeOptions.url}:${req.headers['idempotency-key']}`:undefined,body(req),fn);
  const runAuth=(req:FastifyRequest,p:Principal,tx:Tx,id?:string,stopping=false)=>auth.run(p,tx,req.headers['x-run-ticket'],id,stopping);
  const assistant=(req:FastifyRequest,p:Principal,tx:Tx)=>auth.assistant(p,tx,req.headers['x-assistant-epoch']);
  const queueView=async(tx:Tx,view:Doc,kind:string,extra:Doc={})=>{
    const id=randomUUID();await tx.put('commands',{protocol_version:'1.0',message_id:randomUUID(),kind,sent_at:now(),device_id:view.device_id,run_id:view.run_id,state:'pending',expires_at:expires(60000),payload:{command_id:id,run_id:view.run_id,view_id:view.id,...extra}},id);
  };

  app.get('/health',async()=>({status:'ok',service:'super-agent-control'}));
  app.get('/ready',async()=>{await store.pool.query('SELECT 1');return{status:'ready'};});
  app.get('/v1/auth/config',async()=>{
    if(config.allowDevAuth)return{mode:'development'};
    const result:Doc={mode:'oidc',issuer:config.oidcIssuer??null,client_id:config.oidcClientId??null,redirect_uri:config.oidcRedirectUri??'superagent://oauth/callback'};
    if(config.oidcIssuer){try{const d=await fetch(new URL('.well-known/openid-configuration',`${config.oidcIssuer.replace(/\/$/,'')}/`),{signal:AbortSignal.timeout(5000)});if(d.ok){const json=await d.json() as Doc;result.authorization_endpoint=json.authorization_endpoint;result.token_endpoint=json.token_endpoint;}}catch{/* config remains explicit; no silent dev login */}}
    return result;
  });
  app.post('/v1/auth/dev',async r=>auth.development(body(r)));
  app.post('/v1/auth/exchange',async r=>auth.oidc(body(r)));
  app.post('/v1/auth/refresh',async r=>auth.refresh(body(r)));
  app.post('/v1/device-pairings',async r=>auth.pairing(body(r)));
  app.post('/v1/device-pairings/poll',async r=>auth.poll(body(r)));
  app.post('/v1/devices/auth/challenge',async r=>auth.challenge(body(r)));
  app.post('/v1/devices/auth/token',async r=>auth.deviceToken(body(r)));
  app.post('/v1/device-pairings/claim',async r=>{const p=await auth.principal(r.headers.authorization);auth.client(p);return auth.claim(p,body(r));});
  route('GET','/me','client',async(_r,p)=>({id:p.id,tenant_id:p.tenant,email:p.user!.email,name:p.user!.name}));
  route('POST','/auth/logout','client',async(_r,p,tx)=>{await notifications.revokeSession(tx,p.session!);await tx.client.query('UPDATE sa_sessions SET revoked_at=now() WHERE id=$1 AND user_id=$2',[p.session,p.id]);return{status:'revoked'};});
  route('GET','/sessions','client',async(_r,p,tx)=>{const result=await tx.client.query('SELECT id,created_at,expires_at,revoked_at FROM sa_sessions WHERE user_id=$1',[p.id]);return items(result.rows);});
  route('DELETE','/sessions/:id','client',async(r,p,tx)=>{const id=uuid(params(r).id);const owned=await tx.client.query('SELECT id FROM sa_sessions WHERE id=$1 AND user_id=$2',[id,p.id]);if(owned.rows.length)await notifications.revokeSession(tx,id);await tx.client.query('UPDATE sa_sessions SET revoked_at=now() WHERE id=$1 AND user_id=$2',[id,p.id]);return{status:'revoked'};});
  route('POST','/clients/push-registrations','client',async(r,p,tx)=>notifications.register(tx,p.session!,body(r)));
  route('GET','/clients/push-registrations','client',async(_r,_p,tx)=>notifications.registrations(tx));
  route('DELETE','/clients/push-registrations/:id','client',async(r,p,tx)=>notifications.revoke(tx,uuid(params(r).id),p.session!));
  route('GET','/settings/notifications','client',async(_r,_p,tx)=>notifications.preferences(tx));
  route('PUT','/settings/notifications','client',async(r,_p,tx)=>{const current=await notifications.preferences(tx);matchVersion(r.headers['if-match'],current,body(r).version);return notifications.updatePreferences(tx,{...body(r),version:current.version});});

  route('GET','/devices','client',async(_r,_p,tx)=>items(await Promise.all((await tx.all('devices')).map(d=>service.deviceView(tx,d)))));
  route('PATCH','/devices/:id','client',async(r,_p,tx)=>{await graphLock(tx);const d=await tx.need('devices',uuid(params(r).id),true);matchVersion(r.headers['if-match'],d);const b=body(r),updated=await tx.put('devices',{...d,...(b.name?{name:text(b.name,'name',100)}:{}),...(Array.isArray(b.tags)?{tags:b.tags.slice(0,20)}:{})});await tx.emit('device.changed',updated);return service.deviceView(tx,updated);});
  route('DELETE','/devices/:id','client',async(r,p,tx)=>{
    await graphLock(tx);
    const id=uuid(params(r).id);const d=await tx.need('devices',id,true);matchVersion(r.headers['if-match'],d);
    await tx.client.query('UPDATE sa_device_keys SET revoked_at=now() WHERE device_id=$1 AND tenant_id=$2',[id,p.tenant]);
    const updated=await tx.put('devices',{...d,revoked:true,last_seen_at:null});
    for(const run of (await tx.all('runs')).filter(x=>x.device_id===id&&ACTIVE.includes(x.state))){await tx.put('runs',{...run,state:'lost',lease_expires_at:now()});const task=await tx.need('tasks',run.task_id);await tx.put('tasks',{...task,status:'waiting_device',reason_code:'device_revoked'});}
    await tx.emit('device.changed',updated);return{status:'revoked'};
  });
  route('PUT','/devices/:id/capabilities','device',async(r,p,tx)=>{await graphLock(tx);if(params(r).id!==p.device)throw new ApiError(404,'not_found','设备不存在');const d=await tx.need('devices',p.device!,true),caps=capabilities(body(r));if(caps.generation<(d.capabilities?.generation??0))throw new ApiError(409,'old_capabilities','设备能力版本过期');const updated=await tx.put('devices',{...d,capabilities:caps,last_seen_at:now()});await tx.emit('device.changed',updated);return service.deviceView(tx,updated);});
  route('POST','/node/heartbeat','device',async(_r,p,tx)=>{const d=await tx.need('devices',p.device!,true);await tx.put('devices',{...d,last_seen_at:now()});return{server_time:now(),heartbeat_interval_ms:10000};});
  route('GET','/settings/execution','client',async(_r,_p,tx)=>service.settings(tx));
  route('PUT','/settings/execution','client',async(r,_p,tx)=>{
    const old=await service.settings(tx),b=body(r);if(old.version)matchVersion(r.headers['if-match'],old,b.version);
    for(const k of ['default_device_id','assistant_device_id'])if(b[k])await tx.need('devices',uuid(b[k],k));
    const settings=await tx.put('settings',{default_engine:engine(b.default_engine??old.default_engine),default_device_id:b.default_device_id===undefined?old.default_device_id:b.default_device_id,assistant_device_id:b.assistant_device_id===undefined?old.assistant_device_id:b.assistant_device_id},tx.tenant);
    await tx.emit('settings.changed',settings);return settings;
  });

  route('GET','/tasks','either',async(r,p,tx)=>{if(p.type==='device')await assistant(r,p,tx);return items(limit(await tx.all('tasks'),query(r)));});
  route('POST','/tasks','client',async(r,p,tx)=>idempotent(r,p,tx,()=>service.createTask(tx,body(r))));
  route('GET','/tasks/:id','either',async(r,p,tx)=>{if(p.type==='device')await assistant(r,p,tx);return tx.need('tasks',uuid(params(r).id));});
  route('GET','/tasks/:id/runs','client',async(r,_p,tx)=>{
    const t=await tx.need('tasks',uuid(params(r).id)),checkpoints=(await tx.all('checkpoints')).filter(c=>c.task_id===t.id),deliveries=await tx.all('task_deliveries');
    return items((await tx.all('runs')).filter(run=>run.task_id===t.id).map(run=>{
      const delivery=deliveries.find(d=>d.run_id===run.id),saved=delivery?checkpoints.find(c=>c.id===delivery.checkpoint_id):checkpoints.filter(c=>c.run_id===run.id&&c.checkpoint?.completed===true).at(-1);
      return{...redactView(run),result_text:typeof saved?.checkpoint.result_text==='string'?saved.checkpoint.result_text:null};
    }));
  });
  route('POST','/tasks/:id/actions','client',async(r,p,tx)=>idempotent(r,p,tx,()=>service.action(tx,uuid(params(r).id),body(r),r.headers['if-match'])));
  route('POST','/tasks/:id/inputs','client',async(r,p,tx)=>idempotent(r,p,tx,async()=>{await graphLock(tx);const t=await tx.need('tasks',uuid(params(r).id)),content=text(body(r).text,'text');const message=await tx.put('messages',{role:'user',content,task_id:t.id,client_message_id:randomUUID()});if(t.current_run_id){const run=await tx.need('runs',t.current_run_id,true);await tx.put('runs',{...run,pending_inputs:[...(run.pending_inputs??[]),content]});}await tx.emit('message.created',message,t.id);return message;}));
  route('GET','/runs/:id/steps','client',async(r,_p,tx)=>{const run=await tx.need('runs',uuid(params(r).id));return items((await tx.all('steps')).filter(s=>s.run_id===run.id).map(publicStep));});
  route('GET','/tasks/:id/evidence','client',async(r,_p,tx)=>service.team.evidence(tx,params(r).id));
  route('POST','/tasks/:id/reviews','client',async(r,p,tx)=>idempotent(r,p,tx,async()=>{await graphLock(tx);const task=await tx.need('tasks',uuid(params(r).id),true);matchVersion(r.headers['if-match'],task);return service.team.review(tx,p,task.id,body(r));}));
  route('POST','/plans/:id/actions','client',async(r,p,tx)=>idempotent(r,p,tx,async()=>{
    await graphLock(tx);const plan=await tx.need('plans',uuid(params(r).id),true);matchVersion(r.headers['if-match'],plan);
    if(body(r).action!=='cancel')throw new ApiError(422,'invalid_action','计划仅支持取消操作');
    await tx.put('plans',{...plan,cancellation_requested:true,state:['draft','awaiting_confirmation'].includes(plan.state)?'rejected':plan.state,execution_status:'cancelled'});
    if(plan.source_message_id)await tx.put('inbox_receipts',{source_message_id:plan.source_message_id},plan.source_message_id);
    const taskIds=(await tx.all('tasks')).filter(t=>t.plan_id===plan.id&&!['succeeded','failed','cancelled'].includes(t.status)).map(t=>t.id);
    for(const id of taskIds){const task=await tx.need('tasks',id);if(!['succeeded','failed','cancelled'].includes(task.status))await service.action(tx,id,{action:'cancel'},String(task.version));}
    await service.team.settled(tx,plan.id);return{action_id:randomUUID(),status:'accepted'};
  }));
  route('GET','/messages','client',async(r,_p,tx)=>items(limit((await tx.all('messages')).filter(m=>!query(r).task_id||m.task_id===query(r).task_id),query(r))));
  route('POST','/messages','client',async(r,p,tx)=>idempotent(r,p,tx,async()=>{
    await graphLock(tx);const b=body(r),clientId=uuid(b.client_message_id,'client_message_id'),existing=(await tx.all('messages')).find(m=>m.client_message_id===clientId);
    if(existing){if(existing.content!==b.text)throw new ApiError(409,'message_conflict','消息标识已使用');return existing;}
    if(b.task_id)await tx.need('tasks',uuid(b.task_id));if(b.execution_preference?.device_id)await tx.need('devices',uuid(b.execution_preference.device_id));
    const message=await tx.put('messages',{role:'user',content:text(b.text,'text'),task_id:b.task_id??null,client_message_id:clientId,execution_preference:b.execution_preference??null});
    if(b.task_id){const task=await tx.need('tasks',b.task_id,true);if(task.current_run_id){const run=await tx.need('runs',task.current_run_id,true);if(ACTIVE.includes(run.state))await tx.put('runs',{...run,pending_inputs:[...(run.pending_inputs??[]),message.content]});}}
    await tx.emit('message.created',message,message.task_id);return message;
  }));

  route('GET','/questions','client',async(r,_p,tx)=>items((await tx.all('questions')).filter(q=>!query(r).status||q.status===query(r).status)));
  route('POST','/questions/:id/answers','client',async(r,p,tx)=>idempotent(r,p,tx,async()=>{
    await graphLock(tx);
    const question=await tx.need('questions',uuid(params(r).id),true);matchVersion(r.headers['if-match'],question,body(r).version);
    if(question.status!=='open')throw new ApiError(409,'question_resolved','问题已处理');const answer=text(body(r).answer,'answer');
    const task=await tx.need('tasks',question.task_id,true),updated=await tx.put('questions',{...question,status:'answered',answer,answered_by:p.id});const run=await tx.need('runs',question.run_id,true);await tx.put('runs',{...run,control:{action:'answer',text:answer},state:run.state==='waiting_input'?'running':run.state});
    await tx.put('tasks',{...task,status:'running',reason_code:null});await tx.emit('question.resolved',updated,question.task_id,run.id);return updated;
  }));

  route('GET','/settings/memory','client',async(_r,_p,tx)=>recall.settings(tx));
  route('PUT','/settings/memory','client',async(r,_p,tx)=>{const old=await recall.settings(tx);if(old.version)matchVersion(r.headers['if-match'],old,body(r).version);return recall.bind(tx,body(r));});
  route('DELETE','/settings/memory','client',async(r,_p,tx)=>{const old=await recall.settings(tx);if(old.version)matchVersion(r.headers['if-match'],old);await tx.remove('memory_bindings',tx.tenant);return{provider:'agent-recall',configured:false,version:0};});
  route('GET','/memories','client',async(r,_p,tx)=>items(await recall.list(tx,query(r))));
  route('POST','/memories','client',async(r,p,tx)=>idempotent(r,p,tx,async()=>{const m=await recall.create(tx,body(r),typeof r.headers['idempotency-key']==='string'?`${p.id}:${r.headers['idempotency-key']}`:undefined);await tx.emit('memory.changed',{id:m.id,version:m.version});return m;}));
  route('GET','/memories/:id','client',async(r,_p,tx)=>recall.read(tx,uuid(params(r).id)));
  route('PATCH','/memories/:id','client',async(r,_p,tx)=>{const id=uuid(params(r).id),old=await recall.read(tx,id);matchVersion(r.headers['if-match'],old);const m=await recall.update(tx,id,body(r),old.version);await tx.emit('memory.changed',{id:m.id,previous_id:id,version:m.version});return m;});
  route('DELETE','/memories/:id','client',async(r,_p,tx)=>{const id=uuid(params(r).id),old=await recall.read(tx,id);matchVersion(r.headers['if-match'],old);await recall.remove(tx,id,old.version);await tx.emit('memory.changed',{id,deleted:true});return{status:'deleted'};});

  route('GET','/node/commands','device',async(_r,p,tx)=>items((await tx.all('commands')).filter(c=>c.device_id===p.device&&c.state==='pending'&&Date.parse(c.expires_at)>Date.now()).map(c=>({protocol_version:c.protocol_version,message_id:c.message_id,kind:c.kind,sent_at:c.sent_at,payload:c.payload}))));
  route('POST','/node/runs/:id/accept','device',(r,p,tx)=>service.accept(p,tx,uuid(params(r).id),body(r)));
  route('POST','/node/runs/:id/renew','device',async(r,p,tx)=>{
    const id=uuid(params(r).id),run=await tx.need('runs',id,true);if(run.device_id!==p.device||String(body(r).lease_epoch)!==String(run.lease_epoch)||!ACTIVE.includes(run.state)||Date.parse(run.lease_expires_at)<Date.now())throw new ApiError(409,'run_lease_invalid','执行租约已失效');
    const budget=await service.budget(tx);let control=run.control??null;
    if(budget.monthly_limit_usd!==null&&new Decimal(budget.used_usd).gte(budget.monthly_limit_usd))control={action:'pause',reason:'budget_exhausted'};
    if(!control&&run.pending_inputs?.length)control={action:'input',text:run.pending_inputs[0]};
    const updated=await tx.put('runs',{...run,lease_expires_at:expires(45000),control:['answer','input','browser_input'].includes(control?.action)?null:control,pending_inputs:control?.action==='input'?(run.pending_inputs??[]).slice(1):run.pending_inputs});
    for(const reserve of (await tx.all('budget_reservations')).filter(x=>x.run_id===id&&x.status==='reserved'))await tx.put('budget_reservations',{...reserve,expires_at:expires(60000)});
    const capture=(await tx.all('views')).some(v=>v.run_id===id&&Date.parse(v.expires_at)>Date.now()&&v.state!=='closed');
    return{run_ticket:await auth.runTicket(p,updated),lease_valid_for_ms:45000,...(control?{control}:{}),capture};
  });
  app.post('/v1/node/reports',async r=>{
    const p=await auth.principal(r.headers.authorization);auth.device(p);const messages=body(r).messages;if(!Array.isArray(messages)||messages.length>100)throw new ApiError(422,'invalid_reports','最多提交 100 条回报');
    const accepted:string[]=[],rejected:Doc[]=[];for(const m of messages){try{uuid(m.message_id);if(m.protocol_version!=='1.0'||!m.payload||m.payload.device_id!==p.device)throw new ApiError(422,'invalid_report','消息版本或设备不匹配');await store.tenant(p.tenant,tx=>service.report(tx,p,m));accepted.push(m.message_id);}catch(e){rejected.push({message_id:m?.message_id??null,code:e instanceof ApiError?e.code:'report_error'});}}
    return{accepted,rejected};
  });
  route('POST','/node/reconcile','device',async(r,p,tx)=>{
    const active=(await tx.all('runs')).filter(x=>x.device_id===p.device&&ACTIVE.includes(x.state));
    return{runs:active.map(r=>({run_id:r.id,lease_epoch:r.lease_epoch,state:r.state,lease_expires_at:r.lease_expires_at})),reported_count:Array.isArray(body(r).runs)?body(r).runs.length:0};
  });
  route('POST','/node/runs/:id/checkpoint','device',async(r,p,tx)=>{
    await graphLock(tx);const run=await runAuth(r,p,tx,uuid(params(r).id),true);
    return storeCheckpoint(tx,run,body(r).checkpoint);
  });
  route('POST','/node/runs/:id/questions','device',async(r,p,tx)=>{
    await graphLock(tx);const run=await runAuth(r,p,tx,uuid(params(r).id)),task=await tx.need('tasks',run.task_id,true);const b=body(r);const q=await tx.put('questions',{run_id:run.id,task_id:run.task_id,text:text(b.text,'text',5000),options:Array.isArray(b.options)?b.options.slice(0,20):[],status:'open'});
    await tx.put('runs',{...run,state:'waiting_input'});await tx.put('tasks',{...task,status:'waiting_input'});await tx.emit('question.created',q,run.task_id,run.id);return q;
  });
  const memoryScope=async(r:FastifyRequest,p:Principal,tx:Tx)=>r.headers['x-run-ticket']?runAuth(r,p,tx):assistant(r,p,tx);
  route('POST','/node/memory/search','device',async(r,p,tx)=>{
    await memoryScope(r,p,tx);return recall.search(tx,body(r));
  });
  route('POST','/node/memory/read','device',async(r,p,tx)=>{await memoryScope(r,p,tx);return recall.read(tx,uuid(body(r).id));});
  route('POST','/node/memory/proposals','device',async(r,p,tx)=>{await memoryScope(r,p,tx);const saved=await recall.propose(tx,body(r));await tx.emit('memory.changed',{id:saved.id,version:saved.version});return saved;});

  route('POST','/artifacts/uploads','either',async(r,p,tx)=>{
    if(!config.s3)throw new ApiError(503,'storage_not_configured','尚未配置云端对象存储');
    const run=p.type==='device'?await runAuth(r,p,tx):null,b=body(r),size=Number(b.size);
    if(!Number.isSafeInteger(size)||size<0||size>50*1024*1024)throw new ApiError(422,'invalid_file_size','文件应小于 50 MB');
    const taskId=run?.task_id??(b.task_id?uuid(b.task_id):null);if(taskId)await tx.need('tasks',taskId);if(run&&b.task_id&&b.task_id!==run.task_id)throw new ApiError(404,'not_found','任务不存在');
    const id=randomUUID(),key=`artifacts/staging/${tx.tenant}/${id}/content`,artifact=await tx.put('artifacts',{id,task_id:taskId,run_id:run?.id??null,name:text(b.name,'name',300),mime:text(b.mime??'application/octet-stream','mime',200),size,sha256:typeof b.sha256==='string'?b.sha256:null,staging_object_key:key,object_key:key,status:'staged'});
    return{artifact_id:id,upload_url:signObject(config.s3,'PUT',key),upload_headers:{'Content-Type':artifact.mime},expires_at:expires(300000),max_size:50*1024*1024};
  });
  route('POST','/artifacts/:id/finalize','either',async(r,p,tx)=>{
    if(!config.s3)throw new ApiError(503,'storage_not_configured','尚未配置云端对象存储');
    const artifact=await tx.need('artifacts',uuid(params(r).id),true);if(p.type==='device'){const run=await runAuth(r,p,tx);if(artifact.run_id!==run.id)throw new ApiError(404,'not_found','文件不存在');}
    return publicArtifact(await finalizeArtifact(tx,config.s3,artifact,config.objectFetch));
  });
  route('GET','/artifacts/:id/download','either',async(r,p,tx)=>{
    if(!config.s3)throw new ApiError(503,'storage_not_configured','尚未配置云端对象存储');const artifact=await tx.need('artifacts',uuid(params(r).id));
    if(p.type==='device'){const run=await runAuth(r,p,tx),allowed=await service.team.allowedArtifactTasks(tx,run.task_id);if(!allowed.has(artifact.task_id))throw new ApiError(404,'not_found','文件不存在');if(artifact.task_id!==run.task_id){const dependency=await tx.need('tasks',artifact.task_id);const delivery=(await tx.all('task_deliveries')).find(d=>d.run_id===dependency.current_run_id);if(artifact.run_id!==dependency.current_run_id||!delivery?.artifact_ids.includes(artifact.id))throw new ApiError(404,'not_found','文件不存在');}}
    if(artifact.status!=='ready')throw new ApiError(409,'artifact_not_ready','文件尚未就绪');return{...publicArtifact(artifact),url:signObject(config.s3,'GET',artifact.object_key),expires_at:expires(300000)};
  });
  route('GET','/artifacts','either',async(r,p,tx)=>{
    const q=query(r);let taskId=q.task_id?uuid(q.task_id):undefined,allowed:Set<string>|null=null,ownTask:string|null=null;
    if(p.type==='device'){
      const run=await runAuth(r,p,tx);
      allowed=await service.team.allowedArtifactTasks(tx,run.task_id);ownTask=run.task_id;
      if(taskId&&!allowed.has(taskId))throw new ApiError(404,'not_found','任务不存在');
    }
    if(taskId)await tx.need('tasks',taskId);
    if(q.run_id){const run=await tx.need('runs',uuid(q.run_id));if(taskId&&run.task_id!==taskId)throw new ApiError(404,'not_found','运行不存在');}
    const tasks=new Map((await tx.all('tasks')).map(t=>[t.id,t])),deliveries=new Map((await tx.all('task_deliveries')).map(d=>[d.run_id,d]));
    return items((await tx.all('artifacts')).filter(a=>(!taskId||a.task_id===taskId)&&(!q.run_id||a.run_id===q.run_id)&&(!allowed||allowed.has(a.task_id)&&(a.task_id===ownTask||a.status==='ready'&&a.run_id===tasks.get(a.task_id)?.current_run_id&&deliveries.get(a.run_id)?.artifact_ids.includes(a.id)))).map(publicArtifact));
  });

  route('POST','/assistant/lease/claim','device',async(r,p,tx)=>{
    const settings=await service.settings(tx),old=await tx.get('assistant_leases',tx.tenant,true);
    if(settings.assistant_device_id&&settings.assistant_device_id!==p.device)throw new ApiError(409,'not_assistant_device','不是指定主助理电脑');
    if(old&&old.device_id!==p.device&&Date.parse(old.expires_at)>Date.now())throw new ApiError(409,'assistant_busy','主助理租约被其他电脑持有');
    const epoch=old&&old.device_id===p.device&&Date.parse(old.expires_at)>Date.now()?String(old.epoch):String(BigInt(old?.epoch??'0')+1n);
    await tx.put('assistant_leases',{device_id:p.device,epoch,expires_at:expires(45000)},tx.tenant);return{epoch,lease_valid_for_ms:45000};
  });
  route('POST','/assistant/lease/renew','device',async(r,p,tx)=>{const lease=await auth.assistant(p,tx,body(r).epoch??r.headers['x-assistant-epoch']);await tx.put('assistant_leases',{...lease,expires_at:expires(45000)});return{epoch:lease.epoch,lease_valid_for_ms:45000};});
  route('GET','/assistant/inbox','device',async(r,p,tx)=>{await assistant(r,p,tx);const completed=new Set((await tx.all('inbox_receipts')).map(x=>x.source_message_id));return items((await tx.all('messages')).filter(m=>m.role==='user'&&!m.task_id&&!completed.has(m.id)));});
  route('POST','/assistant/plans','device',async(r,p,tx)=>{await assistant(r,p,tx);return plans.prepare(tx,body(r).source_message_id,body(r).source_event_id);});
  route('GET','/assistant/plans','either',async(r,p,tx)=>{if(p.type==='device')await assistant(r,p,tx);return items((await tx.all('plans')).filter(plan=>!query(r).state||plan.state===query(r).state));});
  route('GET','/assistant/plans/:id','device',async(r,p,tx)=>{await assistant(r,p,tx);return tx.need('plans',uuid(params(r).id));});
  route('POST','/assistant/plans/:id/propose','device',async(r,p,tx)=>{await assistant(r,p,tx);return plans.propose(tx,params(r).id,body(r));});
  route('POST','/assistant/plans/:id/confirm','either',async(r,p,tx)=>{if(p.type==='device')await assistant(r,p,tx);return plans.confirm(tx,params(r).id,body(r).source_message_id);});
  route('POST','/assistant/plans/:id/reject','either',async(r,p,tx)=>{if(p.type==='device')await assistant(r,p,tx);return plans.reject(tx,params(r).id,body(r).source_message_id);});
  route('POST','/assistant/plans/:id/commit','device',async(r,p,tx)=>{await assistant(r,p,tx);const plan=await tx.need('plans',uuid(params(r).id));if(plan.state==='committed')return plan;throw new ApiError(409,'confirmation_required','请先提交目标方案并取得真实用户确认');});
  route('GET','/assistant/context','device',async(r,p,tx)=>{await assistant(r,p,tx);return{messages:(await tx.all('messages')).slice(-20),tasks:(await tx.all('tasks')).filter(t=>!['succeeded','failed','cancelled'].includes(t.status)),pending_plans:(await tx.all('plans')).filter(plan=>plan.state==='awaiting_confirmation'),pending_events:(await tx.all('coordinator_events')).filter(e=>e.status==='pending').map(publicCoordinatorEvent)};});
  route('GET','/assistant/events','device',async(r,p,tx)=>{await assistant(r,p,tx);return items((await tx.all('coordinator_events')).filter(e=>e.status===(query(r).status??'pending')).map(publicCoordinatorEvent));});
  route('GET','/assistant/events/:id/context','device',async(r,p,tx)=>{await assistant(r,p,tx);return service.team.eventContext(tx,params(r).id);});
  route('POST','/assistant/events/:id/complete','device',async(r,p,tx)=>{await assistant(r,p,tx);return idempotent(r,p,tx,async()=>{await graphLock(tx);return service.team.completeEvent(tx,params(r).id,body(r));});});
  route('GET','/assistant/tasks/:id/evidence','device',async(r,p,tx)=>{await assistant(r,p,tx);return service.team.evidence(tx,params(r).id);});
  route('POST','/assistant/tasks/:id/reviews','device',async(r,p,tx)=>{await assistant(r,p,tx);return idempotent(r,p,tx,async()=>{await graphLock(tx);const task=await tx.need('tasks',uuid(params(r).id),true);matchVersion(r.headers['if-match'],task);return service.team.review(tx,p,task.id,body(r));});});
  route('GET','/assistant/tasks/:id/artifacts/:artifact_id/download','device',async(r,p,tx)=>{
    await assistant(r,p,tx);if(!config.s3)throw new ApiError(503,'storage_not_configured','尚未配置云端对象存储');const task=await tx.need('tasks',uuid(params(r).id)),artifact=await tx.need('artifacts',uuid(params(r).artifact_id));
    if(artifact.task_id!==task.id||artifact.run_id!==task.current_run_id||artifact.status!=='ready')throw new ApiError(404,'not_found','交付文件不存在');
    return{...publicArtifact(artifact),url:signObject(config.s3,'GET',artifact.object_key),expires_at:expires(300000)};
  });
  route('POST','/assistant/events/:id/usage','device',async(r,p,tx)=>{
    await assistant(r,p,tx);await graphLock(tx);const event=await tx.need('coordinator_events',uuid(params(r).id)),b=body(r),device=await tx.need('devices',p.device!),selectedEngine=engine(b.engine);
    if(!device.capabilities.engines.some((e:Doc)=>e.engine===selectedEngine&&e.models.includes(b.model_id)))throw new ApiError(422,'invalid_runtime','模型不属于当前电脑');
    await service.usage(tx,{id:event.run_id,task_id:event.task_id,device_id:p.device,engine:selectedEngine,model_id:b.model_id,event_id:event.id},{...b,category:b.category==='assistant'?'assistant':'review'});return{status:'recorded'};
  });
  route('POST','/assistant/messages','device',async(r,p,tx)=>{
    await assistant(r,p,tx);await graphLock(tx);const b=body(r),source=await tx.need('messages',uuid(b.source_message_id));
    const prior=(await tx.all('messages')).find(m=>m.source_message_id===source.id&&m.role==='assistant');if(prior)return prior;
    if(b.task_id)await tx.need('tasks',uuid(b.task_id));const message=await tx.put('messages',{role:'assistant',content:text(b.content,'content',100000),task_id:b.task_id??null,source_message_id:source.id});
    await tx.put('inbox_receipts',{source_message_id:source.id},source.id);await tx.emit('assistant.replied',message,b.task_id??null);return message;
  });
  route('POST','/assistant/usage','device',async(r,p,tx)=>{await assistant(r,p,tx);await graphLock(tx);const b=body(r),message=await tx.need('messages',uuid(b.message_id));const device=await tx.need('devices',p.device!);const selectedEngine=engine(b.engine);if(!device.capabilities.engines.some((e:Doc)=>e.engine===selectedEngine&&e.models.includes(b.model_id)))throw new ApiError(422,'invalid_runtime','模型不属于当前电脑');await service.usage(tx,{id:message.id,task_id:null,device_id:p.device,engine:selectedEngine,model_id:b.model_id},{...b,category:'assistant'});return{status:'recorded'};});
  route('GET','/node/devices','device',async(r,p,tx)=>{await assistant(r,p,tx);return items(await Promise.all((await tx.all('devices')).map(d=>service.deviceView(tx,d))));});
  route('GET','/node/tasks','device',async(r,p,tx)=>{await assistant(r,p,tx);return items(limit(await tx.all('tasks'),query(r)));});
  route('POST','/node/tasks','device',async(r,p,tx)=>{await assistant(r,p,tx);throw new ApiError(409,'confirmation_required','自由聊天派活需要先提交目标方案并确认');});
  route('GET','/node/settings','device',async(r,p,tx)=>{await assistant(r,p,tx);return service.settings(tx);});

  route('POST','/node/runs/:id/frames','device',async(r,p,tx)=>{
    const run=await tx.need('runs',uuid(params(r).id));if(run.device_id!==p.device)throw new ApiError(404,'not_found','执行不存在');const b=body(r);
    if(typeof b.image_base64!=='string'||b.image_base64.length>2500000||!Number.isFinite(b.width)||!Number.isFinite(b.height)||b.width<1||b.height<1)throw new ApiError(422,'invalid_frame','画面格式无效');
    const view=(await tx.all('views')).some(v=>v.run_id===run.id&&v.state!=='closed'&&Date.parse(v.expires_at)>Date.now());if(!view)throw new ApiError(409,'view_inactive','没有有效画面订阅');
    const bytes=Buffer.from(b.image_base64,'base64');const mime=bytes.subarray(0,3).equals(Buffer.from([255,216,255]))?'image/jpeg':bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))?'image/png':null;
    if(!mime)throw new ApiError(422,'invalid_frame','画面必须为 JPEG 或 PNG');
    const frame:Doc={frame_id:uuid(b.frame_id),width:b.width,height:b.height,captured_at:text(b.captured_at,'captured_at',100),viewport_version:text(b.viewport_version,'viewport_version',100),tab_id:b.tab_id??null,run_id:run.id};
    if(config.s3){const key=`frames/${tx.tenant}/${run.id}/${frame.frame_id}`;const upload=await fetch(signObject(config.s3,'PUT',key),{method:'PUT',headers:{'content-type':mime},body:bytes,signal:AbortSignal.timeout(10000)});if(!upload.ok)throw new ApiError(503,'frame_upload_failed','云端画面暂时无法保存',true);frame.object_key=key;frame.mime=mime;}else frame.image_base64=b.image_base64;
    await tx.put('frames',frame,run.id);return{status:'stored'};
  });
  route('GET','/runs/:id/frame','client',async(r,p,tx)=>{const run=await tx.need('runs',uuid(params(r).id));for(const view of (await tx.all('views')).filter(v=>v.run_id===run.id&&v.client_session===p.session&&v.state!=='closed'))await tx.put('views',{...view,expires_at:expires(30000)});const frame=await tx.need('frames',run.id);if(frame.object_key){if(!config.s3)throw new ApiError(503,'storage_not_configured','云端画面存储配置不可用');const response=await fetch(signObject(config.s3,'GET',frame.object_key),{signal:AbortSignal.timeout(10000)});if(!response.ok)throw new ApiError(503,'frame_unavailable','云端画面暂时不可用',true);return{frame_id:frame.frame_id,width:frame.width,height:frame.height,captured_at:frame.captured_at,viewport_version:frame.viewport_version,tab_id:frame.tab_id,image_base64:Buffer.from(await response.arrayBuffer()).toString('base64')};}return frame;});
  route('POST','/runs/:id/views','client',async(r,p,tx)=>{const run=await tx.need('runs',uuid(params(r).id));const view=await tx.put('views',{run_id:run.id,device_id:run.device_id,client_session:p.session,state:'viewing',expires_at:expires(30000),control_state:'none'});await queueView(tx,view,'view.start');return{id:view.id,state:view.state,poll_url:`/v1/runs/${run.id}/frame`};});
  route('DELETE','/views/:id','client',async(r,p,tx)=>{const view=await tx.need('views',uuid(params(r).id));if(view.client_session!==p.session)throw new ApiError(404,'not_found','查看会话不存在');await tx.put('views',{...view,state:'closed',control_requested:false,control_state:'none'});if(view.control_requested)await queueView(tx,view,'view.control',{enabled:false});await queueView(tx,view,'view.stop');return{status:'closed'};});
  route('POST','/views/:id/control','client',async(r,p,tx)=>{
    const initial=await tx.need('views',uuid(params(r).id));if(initial.client_session!==p.session)throw new ApiError(404,'not_found','查看会话不存在');
    const initialRun=await tx.need('runs',initial.run_id);await tx.need('tasks',initialRun.task_id,true);
    const run=await tx.need('runs',initial.run_id,true);await tx.need('devices',run.device_id,true);const view=await tx.need('views',initial.id,true);
    if(view.state==='closed'||Date.parse(view.expires_at)<=Date.now())throw new ApiError(409,'view_inactive','查看会话已过期');
    const other=(await tx.all('views')).some(v=>v.id!==view.id&&v.device_id===view.device_id&&v.control_requested&&v.state!=='closed'&&Date.parse(v.control_expires_at??v.expires_at)>Date.now());
    if(other)throw new ApiError(409,'control_busy','其他客户端正在接管');
    if((await tx.all('runs')).some(otherRun=>otherRun.id!==run.id&&otherRun.device_id===run.device_id&&(ACTIVE.includes(otherRun.state)||['lost','result_unknown'].includes(otherRun.state))))throw new ApiError(409,'device_busy','该电脑还有其他运行，先停止并核对后接管');
    if(['lost','result_unknown'].includes(run.state))throw new ApiError(409,'result_unknown','先核对旧执行是否已停止');
    const active=ACTIVE.includes(run.state),updated=await tx.put('views',{...view,control_requested:true,control_state:active?'pausing':'active',control_expires_at:expires(60000),expires_at:expires(60000)});
    if(active){await tx.put('runs',{...run,state:'stopping',control:{action:'pause'}});const task=await tx.need('tasks',run.task_id);await tx.put('tasks',{...task,status:'pausing',pending_action:'pause'});}
    else await queueView(tx,updated,'view.control',{enabled:true});
    return{id:view.id,status:updated.control_state};
  });
  route('POST','/views/:id/inputs','client',async(r,p,tx)=>{
    const view=await tx.need('views',uuid(params(r).id),true);if(view.client_session!==p.session||view.control_state!=='active'||Date.parse(view.control_expires_at)<Date.now())throw new ApiError(409,'control_not_active','请先等待接管完成');
    const frame=await tx.need('frames',view.run_id),b=body(r);if(frame.frame_id!==b.frame_id||frame.viewport_version!==b.viewport_version)throw new ApiError(409,'stale_frame','画面已更新，请刷新后操作');
    const inputType=b.type==='text'?'type':b.type;
    if(!['click','scroll','type','keys'].includes(inputType))throw new ApiError(422,'invalid_input_type','输入类型无效');
    if(b.type==='click'&&(!Number.isFinite(b.x)||!Number.isFinite(b.y)||b.x<0||b.y<0||b.x>=frame.width||b.y>=frame.height))throw new ApiError(422,'invalid_coordinates','输入坐标超出画面');
    const input={frame_id:b.frame_id,viewport_version:b.viewport_version,type:inputType,x:b.x,y:b.y,text:typeof b.text==='string'?b.text.slice(0,10000):undefined,keys:typeof b.keys==='string'?b.keys.slice(0,100):undefined};await queueView(tx,view,'view.input',{input});await tx.put('views',{...view,control_expires_at:expires(60000),expires_at:expires(60000)});return{status:'accepted'};
  });
  route('DELETE','/views/:id/control','client',async(r,p,tx)=>{const view=await tx.need('views',uuid(params(r).id));if(view.client_session!==p.session)throw new ApiError(404,'not_found','查看会话不存在');await tx.put('views',{...view,control_requested:false,control_state:'none'});await queueView(tx,view,'view.control',{enabled:false});return{status:'released',task_remains_paused:true};});
  route('POST','/tasks/:id/reconciliation','client',async(r,p,tx)=>idempotent(r,p,tx,async()=>{
    await graphLock(tx);const task=await tx.need('tasks',uuid(params(r).id),true);matchVersion(r.headers['if-match'],task);const run=await tx.need('runs',task.current_run_id,true);
    if(!['lost','result_unknown'].includes(run.state))throw new ApiError(409,'reconciliation_not_required','当前执行不需要结果核对');
    const outcome=body(r).outcome;if(!['not_applied','applied','unknown'].includes(outcome))throw new ApiError(422,'invalid_outcome','需要明确核对结果');const note=text(body(r).note,'note',5000);
    if(outcome==='unknown')return{status:'still_unknown'};
    const savedRun=await tx.put('runs',{...run,state:outcome==='applied'?'succeeded':'paused',summary:note,reconciled_by:p.id,reconciled_at:now()});await service.releaseBudget(tx,run.id);
    const cancelled=task.status==='cancelled'||task.cancellation_requested;const updated=await tx.put('tasks',{...task,status:cancelled?'cancelled':outcome==='applied'?'awaiting_review':'paused',delivery_status:!cancelled&&outcome==='applied'?'pending':task.delivery_status,reason_code:null,pending_action:null,pending_target:null});
    if(!cancelled&&outcome==='applied')await service.team.submit(tx,updated,savedRun);await service.team.refreshBlocked(tx);await tx.emit('task.changed',updated,task.id,run.id);return updated;
  }));

  route('GET','/costs/summary','client',async(r,_p,tx)=>service.summary(await service.costs(tx,query(r))));
  route('GET','/costs/records','client',async(r,_p,tx)=>items(limit(await service.costs(tx,query(r)),query(r))));
  route('GET','/costs/series','client',async(r,_p,tx)=>{
    const groups=new Map<string,Doc>();for(const record of await service.costs(tx,query(r))){if(record.cost.amount===null)continue;const date=record.occurred_at.slice(0,10),key=`${date}:${record.cost.currency}:${record.cost.source}`,g=groups.get(key)??{date,currency:record.cost.currency,source:record.cost.source,amount:'0',input_tokens:0,output_tokens:0};g.amount=new Decimal(g.amount).plus(record.cost.amount).toFixed();g.input_tokens+=record.input_tokens??0;g.output_tokens+=record.output_tokens??0;groups.set(key,g);}return items([...groups.values()]);
  });
  route('GET','/costs/breakdown','client',async(r,_p,tx)=>{
    const by=String(query(r).group_by??'engine');if(!['device','engine','task','model'].includes(by))throw new ApiError(422,'invalid_group','分组无效');const field=by==='device'?'device_id':by==='task'?'task_id':by==='model'?'model_id':'engine',groups=new Map<string,Doc>(),devices=await tx.all('devices'),tasks=await tx.all('tasks');
    for(const u of await service.costs(tx,query(r))){const key=String(u[field]??'assistant'),currency=u.cost.currency??'USD',identity=`${key}:${currency}`,g=groups.get(identity)??{key,label:devices.find(d=>d.id===key)?.name??tasks.find(t=>t.id===key)?.title??key,currency,amount:'0',request_count:0,unknown_count:0};g.request_count++;if(u.cost.amount===null)g.unknown_count++;else g.amount=new Decimal(g.amount).plus(u.cost.amount).toFixed();groups.set(identity,g);}return items([...groups.values()]);
  });
  route('GET','/budgets','client',async(_r,_p,tx)=>service.budget(tx));
  route('PUT','/budgets','client',async(r,_p,tx)=>{const old=await service.budget(tx);if(old.version)matchVersion(r.headers['if-match'],old,body(r).version);const b=body(r);await tx.put('budgets',{monthly_limit_usd:safeMoney(b.monthly_limit_usd??null),task_limit_usd:safeMoney(b.task_limit_usd??null)},tx.tenant);const saved=await service.budget(tx);await tx.emit('budget.changed',saved);return saved;});
  route('GET','/schedules','client',async(_r,_p,tx)=>items(await tx.all('schedules')));
  route('POST','/schedules','client',async(r,p,tx)=>idempotent(r,p,tx,async()=>{const b=body(r),minutes=Number(b.interval_minutes);if(!Number.isInteger(minutes)||minutes<5||minutes>525600)throw new ApiError(422,'invalid_interval','检查周期应在5分钟至1年之间');await tx.need('devices',uuid(b.device_id));return tx.put('schedules',{title:text(b.title??b.goal,'title',200),goal:text(b.goal,'goal'),engine:engine(b.engine),device_id:b.device_id,interval_minutes:minutes,mode:'remind_and_confirm',next_due_at:expires(minutes*60000),enabled:true});}));
  route('PATCH','/schedules/:id','client',async(r,_p,tx)=>{const schedule=await tx.need('schedules',uuid(params(r).id));matchVersion(r.headers['if-match'],schedule);return tx.put('schedules',{...schedule,enabled:body(r).enabled===true});});
  route('DELETE','/schedules/:id','client',async(r,_p,tx)=>{const schedule=await tx.need('schedules',uuid(params(r).id));matchVersion(r.headers['if-match'],schedule);await tx.remove('schedules',schedule.id);return{status:'deleted'};});
  route('GET','/notifications','client',async(_r,_p,tx)=>items(await tx.all('notifications')));
  route('GET','/events','client',async(r,_p,tx)=>{const after=String(query(r).after??'0');if(!/^\d{1,20}$/.test(after))throw new ApiError(422,'invalid_cursor','事件游标无效');const result=await tx.client.query('SELECT data FROM sa_events WHERE tenant_id=$1 AND seq>$2 ORDER BY seq LIMIT 500',[tx.tenant,after]);const events=result.rows.map(row=>publicEvent(row.data));return{items:events,cursor:events.at(-1)?.stream_seq??after};});
  route('POST','/sync/bootstrap','client',async(_r,_p,tx)=>{const result=await tx.client.query('SELECT seq FROM sa_streams WHERE tenant_id=$1',[tx.tenant]);return{tasks:await tx.all('tasks'),devices:await Promise.all((await tx.all('devices')).map(d=>service.deviceView(tx,d))),questions:(await tx.all('questions')).filter(q=>q.status==='open'),cursor:String(result.rows[0]?.seq??'0')};});

  let timer:ReturnType<typeof setInterval>|undefined;
  if(config.runScheduler!==false){timer=setInterval(()=>{
    if(!serviceWork)void serviceTick().catch(error=>app.log.error({code:error?.code},'Scheduler tick failed'));
    if(!notificationWork)void notificationTick().catch(error=>app.log.error({code:error?.code},'Notification tick failed'));
  },1000);timer.unref();}
  app.addHook('onClose',async()=>{closing=true;if(timer)clearInterval(timer);await Promise.allSettled([serviceWork,notificationWork]);await store.close();});
  return app;
}
export const createApp=buildApp;
