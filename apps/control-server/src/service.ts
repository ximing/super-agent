import { randomUUID } from 'node:crypto';
import { Decimal } from 'decimal.js';
import { Auth, type Principal, now, expires, text, uuid } from './auth.js';
import { ApiError, Store, Tx, hash, type Doc } from './store.js';
import { storeStep } from './steps.js';
import { TeamService,graphLock,deliverables as normalizeDeliverables } from './team.js';
import { observeDue } from './observations.js';
import { normalizeMemoryScope, proposeRetrospective } from './memory-governance.js';
import { activeHold, admitReservation, buildReservation, grantBlocked, remainingLimits, renewReservation, reservationInForce, settleReservation, type ReservationLiveness } from './budget-control.js';
import { configuredLimits, dollarGate, holdFor, presentGrant, recovery, sanitizeLimits, spendFor, taskDollarStop, usageStop } from './budget-policy.js';
import { BUDGET_RECOVERY, activityRootId, canonicalActivityId, grantExecutable, type BudgetCategory, type BudgetStopReason, type RuntimeBudgetLimits } from '@super-agent/protocol';
import { acceptControl, advanceActionReceipts, emitTaskProgress, noteActionProgress, runProgressPhase } from './interaction.js';

export const ACTIVE = ['dispatched','starting','running','waiting_input','stopping'];
const TERMINAL = ['succeeded','failed','cancelled','paused'];
export function engine(value:unknown):'codex'|'grok'{if(value!=='codex'&&value!=='grok')throw new ApiError(422,'invalid_engine','执行引擎无效');return value;}
export function matchVersion(header:unknown,object:Doc,fallback?:unknown):void{
  const raw=typeof header==='string'?header.replace(/^W\//,'').replaceAll('"',''):fallback;
  if(raw===undefined)throw new ApiError(428,'version_required','需要资源版本');
  if(Number(raw)!==object.version)throw new ApiError(412,'version_conflict','数据已更新，请刷新后重试');
}
export function safeMoney(value:unknown):string|null{if(value===null)return null;if(typeof value!=='string'||!/^\d+(\.\d{1,10})?$/.test(value)||new Decimal(value).gt('1000000000'))throw new ApiError(422,'invalid_amount','金额需要为非负十进制字符串');return new Decimal(value).toFixed();}
export function redactView(object:Doc):Doc{const {control,lease_expires_at,scope,...data}=object;return data;}
export function costRange(query:Doc,at=new Date()):{from:number;to:number}{
  const parse=(value:unknown,label:string)=>{if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}T.+(?:Z|[+-]\d{2}:\d{2})$/.test(value)||!Number.isFinite(Date.parse(value)))throw new ApiError(422,'invalid_date_range',`${label} 需要带时区的 ISO 时间`);return Date.parse(value);};
  const to=query.to===undefined?at.getTime():parse(query.to,'to');
  const from=query.from===undefined?Date.UTC(at.getUTCFullYear(),at.getUTCMonth(),1):parse(query.from,'from');
  if(from>to||to-from>366*86400000)throw new ApiError(422,'invalid_date_range','费用范围需起始早于结束且不超过 366 天');
  return{from,to};
}
export function conflictingMessage(existing:Doc,content:string,memoryScope:unknown):boolean{
  return existing.content!==content||hash(existing.memory_scope??null)!==hash(memoryScope??null);
}
export function workerUsageActivity(run:Doc,payload:Doc):Doc{
  const activityId=canonicalActivityId('run',run.id);
  if(payload.activity_id!==undefined&&payload.activity_id!==activityId)throw new ApiError(422,'activity_mismatch','用量活动与本次执行不一致');
  if(payload.category!==undefined&&payload.category!=='worker'&&payload.category!=='subagent')throw new ApiError(422,'invalid_usage_category','执行用量类别无效');
  return{activity_id:activityId,category:payload.category==='subagent'?'subagent':'worker',run_id:run.id,task_id:run.task_id??null,device_id:run.device_id??null,engine:run.engine,model_id:run.model_id};
}
/** The reported id must be the live attempt, or the only root when no attempt exists. */
export function resolveReportedActivity(root:string,body:Doc,reservations:Doc[],deviceId:string):string{
  const family=reservations.filter(row=>activityRootId(String(row.activity_id??''))===root);
  const live=family.filter(row=>row.status==='reserved'&&Number.isFinite(Date.parse(String(row.expires_at)))&&Date.parse(String(row.expires_at))>Date.now()&&(!row.device_id||row.device_id===deviceId)).sort((a,b)=>(Number(b.attempt)||1)-(Number(a.attempt)||1))[0];
  if(body.activity_id===undefined||body.activity_id===null){
    if(live)return String(live.activity_id);
    if(family.some(row=>String(row.activity_id)!==root))throw new ApiError(422,'activity_mismatch','用量活动标识不一致');
    return root;
  }
  const reported=text(body.activity_id,'activity_id',200);
  if(activityRootId(reported)!==root)throw new ApiError(422,'activity_mismatch','用量活动标识不一致');
  const row=family.find(item=>item.activity_id===reported&&(!item.device_id||item.device_id===deviceId));
  if(!row)throw new ApiError(422,'activity_mismatch','用量活动标识不一致');
  if(live&&live.activity_id!==reported)throw new ApiError(422,'activity_mismatch','用量活动标识不一致');
  return reported;
}
export function assistantUsageActivity(message:Doc,deviceId:string,engineName:string,modelId:string,body:Doc,reservations:Doc[]=[]):Doc{
  const root=canonicalActivityId(message.schedule_id?'proactive':'assistant',message.id);
  const activityId=resolveReportedActivity(root,body,reservations,deviceId);
  return{activity_id:activityId,category:message.schedule_id?'proactive':'assistant',run_id:null,task_id:message.task_id??null,device_id:deviceId,engine:engineName,model_id:modelId};
}
export function eventUsageActivity(event:Doc,deviceId:string,engineName:string,modelId:string,body:Doc,reservations:Doc[]=[]):Doc{
  const deliveryReview=!!(event.delivery_id&&(body.category==='review'||event.type==='delivery.submitted'));
  const root=deliveryReview?canonicalActivityId('review',event.delivery_id):canonicalActivityId('event',event.id);
  const activityId=resolveReportedActivity(root,body,reservations,deviceId);
  return{activity_id:activityId,category:deliveryReview?'review':'assistant',run_id:null,task_id:event.task_id??null,device_id:deviceId,engine:engineName,model_id:modelId,...(event.id?{event_id:event.id}:{})};
}
export function replyActivityId(source:Doc):string{return canonicalActivityId(source.schedule_id?'proactive':'assistant',source.id);}
function viewGrant(reservation:Doc,deviceId?:string|null):Doc{
  const grant=presentGrant(reservation);
  grant.device_id=reservation.device_id??null;
  grant.attempt=reservation.attempt??1;
  if(reservation.prior_activity_id)grant.prior_activity_id=reservation.prior_activity_id;
  grant.executable=grantExecutable({status:reservation.status,expires_at:reservation.expires_at,limits:reservation.limits??null,activity_id:reservation.activity_id,device_id:reservation.device_id??null},{activityId:String(reservation.activity_id??''),deviceId:deviceId??reservation.device_id??null});
  return grant;
}
/** Attempt keys are `${root}#N`. The root stays stable across terminal retries. */
function activityRoot(row:Doc,fallback:unknown):string{
  if(typeof row.prior_activity_id==='string'&&row.prior_activity_id)return row.prior_activity_id;
  return activityRootId(String(row.activity_id??fallback??''));
}
function workerRunReservation(reservation:Doc,runId:string):boolean{
  if(reservation.activity_kind==='assistant'||reservation.activity_kind==='review'||reservation.activity_kind==='proactive')return false;
  const canonical=canonicalActivityId('run',runId);
  if(reservation.activity_id===canonical)return reservation.activity_kind==null||reservation.activity_kind==='run';
  return (reservation.activity_kind==='run'||reservation.activity_kind==null)&&reservation.run_id===runId;
}
export class Service {
  readonly team=new TeamService();
  constructor(public store:Store,public auth:Auth){}
  async deviceView(tx:Tx,d:Doc):Promise<Doc>{
    const active=(await tx.all('runs')).some(r=>r.device_id===d.id&&ACTIVE.includes(r.state));
    return{...d,status:!d.last_seen_at||Date.parse(d.last_seen_at)<Date.now()-30000?'offline':active?'busy':'online'};
  }
  async settings(tx:Tx):Promise<Doc>{const stored=await tx.get('settings',tx.tenant);return stored?{memory_global_read:false,...stored}:{id:tx.tenant,default_engine:'codex',default_device_id:null,assistant_device_id:null,memory_global_read:false,version:0};}
  private async holdContext(tx:Tx):Promise<ReservationLiveness>{
    return{activeRunIds:new Set((await tx.all('runs')).filter(r=>ACTIVE.includes(r.state)).map(r=>r.id)),now:Date.now()};
  }
  async budget(tx:Tx):Promise<Doc>{
    const b=await tx.get('budgets',tx.tenant)??{id:tx.tenant,monthly_limit_usd:null,task_limit_usd:null,version:0};
    const month=(await tx.all('usage_records')).filter(u=>String(u.occurred_at).slice(0,7)===now().slice(0,7));
    const usage=month.filter(u=>u.cost?.currency==='USD'&&u.cost?.amount!==null);
    const reservations=await tx.all('budget_reservations');
    const live=await this.holdContext(tx);
    const unknown=(r:Doc)=>r.amount==null||String(r.money_treatment??'').startsWith('unknown');
    return{...b,used_usd:usage.reduce((s,u)=>s.plus(u.cost.amount),new Decimal(0)).toFixed(),unknown_count:month.length-usage.length,reserved_hold_usd:activeHold(reservations,live.now,live.activeRunIds).toFixed(),reserved_unknown_count:reservations.filter(r=>reservationInForce(r,live)&&unknown(r)).length,explanation:'本月金额是账号上限。每个任务另外计算自己的用量，新的一次运行只拿到扣掉已消耗后剩下的额度。运行时长按这一次活动计算，重试或换电脑不会把已用量清零。'};
  }
  private async activityAllowance(tx:Tx,budget:Doc,category:BudgetCategory,taskId:string|null,taskBudget:Doc|null):Promise<{ok:true;limits:RuntimeBudgetLimits;ceiling:RuntimeBudgetLimits;amount:string|null;treatment:string}|{ok:false;reason:BudgetStopReason;recovery:string;limits:RuntimeBudgetLimits}>{
    const ceiling=configuredLimits(category,[budget.category_limits?.[category],taskBudget]);
    const reservations=await tx.all('budget_reservations');
    const live=await this.holdContext(tx);
    const held=!!(taskId&&budget.task_limit_usd&&reservations.some(r=>r.task_id===taskId&&reservationInForce(r,live)&&r.money_treatment==='known'&&r.amount&&r.amount!=='0'));
    const records=taskId?(await tx.all('usage_records')).filter(r=>r.task_id===taskId):[];
    const runIds=new Set(taskId?(await tx.all('runs')).filter(r=>r.task_id===taskId).map(r=>r.id):[]);
    const steps=(await tx.all('steps')).filter(s=>runIds.has(s.run_id));
    const limits=remainingLimits(ceiling,spendFor(records,steps,category));
    const money=taskId?taskDollarStop(budget,records):null;
    const hold=holdFor(budget);
    const admission=dollarGate(budget,reservations,hold.amount,live.now,live.activeRunIds);
    const reason:BudgetStopReason|null=held?'budget_exhausted':money??grantBlocked(limits)??(admission.ok?null:admission.reason);
    if(reason)return{ok:false,reason,recovery:recovery(reason),limits};
    return{ok:true,limits,ceiling,amount:hold.amount,treatment:hold.treatment};
  }
  async createTask(tx:Tx,body:Doc,reservedId?:string):Promise<Doc>{
    await graphLock(tx);
    const settings=await this.settings(tx),selectedEngine=engine(body.engine??settings.default_engine);
    const deviceId=uuid(body.device_id??settings.default_device_id,'device_id');await tx.need('devices',deviceId);
    const goal=text(body.goal,'goal'),id=reservedId??randomUUID(),criteria=normalizeDeliverables(body.deliverables),memory=normalizeMemoryScope(body.memory_scope);
    const budgetOverride=body.budget==null?null:sanitizeLimits(body.budget);if(body.budget!=null&&!budgetOverride)throw new ApiError(422,'invalid_budget','任务用量上限无效');
    if(body.plan_id&&!reservedId)throw new ApiError(422,'managed_plan_required','计划任务需由已确认方案原子创建');
    if(body.plan_id)await tx.need('plans',uuid(body.plan_id));
    let task=await tx.put('tasks',{id,title:typeof body.title==='string'?body.title.slice(0,160):goal.slice(0,80),goal,deliverables:criteria,status:'queued',reason_code:null,engine:selectedEngine,model_id:body.model_id?text(body.model_id,'model_id',200):null,device_id:deviceId,current_run_id:null,scope_version_id:randomUUID(),scope:{source:body.source_message_id?'message':'explicit_user_task',source_message_id:body.source_message_id??null,confirmation_message_id:body.confirmation_message_id??null,goal,deliverables:criteria,...(memory?{memory}:{}),...(budgetOverride?{budget:budgetOverride}:{})},plan_id:body.plan_id??null,item_key:body.item_key??null,parent_task_id:null,root_task_id:id,depends_on_task_ids:[],delivery_status:'not_submitted'});
    if(body.parent_task_id||body.depends_on_task_ids)task=await this.team.attach(tx,task,body.parent_task_id,body.depends_on_task_ids);
    await tx.emit('task.created',task,id);return task;
  }
  async dispatchTenant(tenant:string):Promise<void>{
    await this.store.tenant(tenant,async tx=>{
      await graphLock(tx);await this.team.refreshBlocked(tx);
      const candidates=(await tx.all('tasks',true)).filter(t=>['queued','waiting_device'].includes(t.status)&&!t.current_run_id);
      for(const task of candidates.slice(0,10)){
        const plan=task.plan_id?await tx.need('plans',task.plan_id):null;
        if(task.cancellation_requested||plan?.cancellation_requested||plan&&plan.state!=='committed'){await this.action(tx,task.id,{action:'cancel'},String(task.version),false);continue;}
        const device=await tx.get('devices',task.device_id,true);
        if(!device)continue;
        const caps=device.capabilities??{},cap=(caps.engines??[]).find((e:Doc)=>e.engine===task.engine&&e.ready);
        const reason=!device.last_seen_at||Date.parse(device.last_seen_at)<Date.now()-30000?'device_offline':!cap?'engine_unavailable':null;
        if(reason){if(task.status!=='waiting_device'||task.reason_code!==reason){const updated=await tx.put('tasks',{...task,status:'waiting_device',reason_code:reason});await tx.emit('task.changed',updated,task.id);}continue;}
        const deviceRuns=(await tx.all('runs')).filter(r=>r.device_id===device.id);
        if(deviceRuns.some(r=>['lost','result_unknown'].includes(r.state)))continue;
        if((await tx.all('views')).some(v=>v.device_id===device.id&&v.control_requested&&v.state!=='closed'&&Date.parse(v.control_expires_at??v.expires_at)>Date.now()))continue;
        const running=deviceRuns.filter(r=>ACTIVE.includes(r.state));
        if(running.length>=Math.max(1,Math.min(8,caps.slots?.worker??1)))continue;
        const model=task.model_id??cap.models?.[0];
        if(!model||!cap.models?.includes(model)){
          const updated=await tx.put('tasks',{...task,status:'waiting_device',reason_code:'model_unavailable'});await tx.emit('task.changed',updated,task.id);continue;
        }
        const budget=await this.budget(tx),reservations=await tx.all('budget_reservations');
        const allowance=await this.activityAllowance(tx,budget,'worker',task.id,task.scope?.budget??null);
        if(!allowance.ok){if(task.reason_code!==allowance.reason){const updated=await tx.put('tasks',{...task,status:'queued',reason_code:allowance.reason});await tx.emit('budget.changed',{reason:allowance.reason,recovery:allowance.recovery,remaining:allowance.limits},task.id);}continue;}
        const runId=randomUUID(),commandId=randomUUID(),grantId=randomUUID(),epoch='1',lease=expires(45000),activityId=canonicalActivityId('run',runId);
        const hold=admitReservation(reservations,buildReservation({operation_key:activityId,activity_kind:'run',activity_id:activityId,task_id:task.id,run_id:runId,category:'worker',limits:allowance.limits,amount:allowance.amount,expires_at:expires(120000),money_treatment:allowance.treatment}));
        if(hold.created)await tx.put('budget_reservations',{...hold.reservation,device_id:device.id,attempt:1,ceiling:allowance.ceiling},grantId);
        const run=await tx.put('runs',{id:runId,task_id:task.id,device_id:device.id,engine:task.engine,model_id:model,lease_epoch:epoch,lease_expires_at:lease,state:'dispatched',summary:'等待执行电脑接受',scope_version_id:task.scope_version_id,budget_grant_id:grantId,command_id:commandId,checkpoint_id:task.checkpoint_id??null,scope:{...task.scope,dependencies:await this.team.dependencies(tx,task)},control:null});
        const command={protocol_version:'1.0',message_id:randomUUID(),kind:'run.start',sent_at:now(),payload:{command_id:commandId,tenant_id:tenant,task_id:task.id,run_id:runId,device_id:device.id,lease_epoch:epoch,scope_version_id:task.scope_version_id,capability_generation:caps.generation??1,runtime:{engine:task.engine,model_id:model,local_profile_id:cap.local_profile_id??'default'},expires_at:expires(60000),lease_valid_for_ms:45000,checkpoint_id:task.checkpoint_id??null,budget_grant_id:grantId}};
        await tx.put('commands',{...command,device_id:device.id,run_id:runId,state:'pending',expires_at:command.payload.expires_at},commandId);
        const updated=await tx.put('tasks',{...task,status:'queued',reason_code:'awaiting_device_accept',model_id:model,current_run_id:runId,delivery_status:'not_submitted'});
        await tx.emit('run.started',redactView(run),task.id,runId);await tx.emit('task.changed',updated,task.id,runId);await this.noteRun(tx,updated,run);
        // Each tenant gets a bounded dispatch wave; the next tick visits other tenants first.
        if(running.length+1>=Math.max(1,caps.slots?.worker??1))break;
      }
    });
  }
  async tick():Promise<void>{
    for(const tenant of await this.store.tenants()){
      await this.store.tenant(tenant,async tx=>{
        await graphLock(tx);
        await tx.all('tasks',true); // Consistent task-before-run lock order with actions and reports.
        const runs=await tx.all('runs',true);
        for(const run of runs){
          if(run.state==='dispatched'){
            const command=await tx.get('commands',run.command_id);
            if(command&&Date.parse(command.expires_at)<Date.now()){
              const expired=await tx.put('runs',{...run,state:'cancelled',summary:'启动命令过期，未被接受'});
              await tx.put('commands',{...command,state:'expired'});
              const task=await tx.need('tasks',run.task_id);const next=task.current_run_id===run.id?await tx.put('tasks',{...task,current_run_id:null,status:'queued',reason_code:'command_expired'}):task;
              await this.releaseBudget(tx,run.id);await this.noteRun(tx,next,expired);continue;
            }
          }
          if(['starting','running','waiting_input','stopping'].includes(run.state)&&Date.parse(run.lease_expires_at)<Date.now()){
            const lost=await tx.put('runs',{...run,state:'lost',summary:'设备租约失效，等待核对'});
            await this.releaseBudget(tx,run.id);
            const task=await tx.need('tasks',run.task_id);if(task.current_run_id===run.id){const updated=await tx.put('tasks',{...task,status:'waiting_device',reason_code:'run_result_requires_reconciliation'});await tx.emit('task.changed',updated,task.id,run.id);await this.team.event(tx,'task.result_unknown',updated,run);await this.noteRun(tx,updated,lost);}else await this.noteRun(tx,task,lost);
          }
        }
        for(const view of await tx.all('views',true)){
          const viewingExpired=Date.parse(view.expires_at)<=Date.now(),controlExpired=view.control_requested&&Date.parse(view.control_expires_at??view.expires_at)<=Date.now();
          if(view.state==='closed'||(!viewingExpired&&!controlExpired))continue;
          if(view.control_requested&&(viewingExpired||controlExpired)){
            const commandId=randomUUID();await tx.put('commands',{protocol_version:'1.0',message_id:randomUUID(),kind:'view.control',sent_at:now(),device_id:view.device_id,run_id:view.run_id,state:'pending',expires_at:expires(60000),payload:{command_id:commandId,run_id:view.run_id,view_id:view.id,enabled:false}},commandId);
          }
          if(viewingExpired){
            const commandId=randomUUID();await tx.put('commands',{protocol_version:'1.0',message_id:randomUUID(),kind:'view.stop',sent_at:now(),device_id:view.device_id,run_id:view.run_id,state:'pending',expires_at:expires(60000),payload:{command_id:commandId,run_id:view.run_id,view_id:view.id}},commandId);
          }
          await tx.put('views',{...view,...(viewingExpired?{state:'closed'}:{}),control_requested:false,control_state:'none'});
        }
        await this.sweepReservations(tx);
        const schedules=(await tx.all('schedules',true)).filter(s=>s.kind!=='observation'&&s.enabled&&Date.parse(s.next_due_at)<=Date.now());
        for(const schedule of schedules){
          const sourceMessage=await tx.put('messages',{role:'user',content:schedule.goal,task_id:null,client_message_id:`schedule:${schedule.id}:${schedule.next_due_at}`,execution_preference:{engine:schedule.engine,device_id:schedule.device_id},schedule_id:schedule.id});
          await tx.put('schedules',{...schedule,next_due_at:expires(schedule.interval_minutes*60000),last_message_id:sourceMessage.id});
          await tx.emit('message.created',sourceMessage);
        }
        await observeDue(tx);
      });
      await this.dispatchTenant(tenant);
    }
  }
  async accept(p:Principal,tx:Tx,id:string,body:Doc):Promise<Doc>{
    this.auth.device(p);await graphLock(tx);const initial=await tx.need('runs',id);await tx.need('tasks',initial.task_id,true);const run=await tx.need('runs',id,true),command=await tx.need('commands',uuid(body.command_id),true);
    if(run.device_id!==p.device||command.device_id!==p.device||run.command_id!==command.id||String(body.lease_epoch)!==String(run.lease_epoch))throw new ApiError(404,'not_found','执行命令不存在');
    if(!['dispatched','starting','running'].includes(run.state))throw new ApiError(409,'run_not_startable','当前执行状态不能接受命令');
    if(run.state==='dispatched'&&Date.parse(command.expires_at)<Date.now())throw new ApiError(409,'command_expired','启动命令已过期');
    const d=await tx.need('devices',p.device!);const cap=d.capabilities?.engines?.find((e:Doc)=>e.engine===run.engine&&e.ready&&e.models?.includes(run.model_id));
    if(!cap)throw new ApiError(409,'capability_changed','设备引擎能力已改变');
    const task=await tx.need('tasks',run.task_id,true);if(task.current_run_id!==run.id)throw new ApiError(409,'run_superseded','该次执行已被替代');
    const accepted=await tx.put('runs',{...run,state:run.state==='dispatched'?'starting':run.state,lease_expires_at:expires(45000)});
    await tx.put('commands',{...command,state:'accepted'});
    const updated=await tx.put('tasks',{...task,status:'running',reason_code:null});await tx.emit('task.changed',updated,task.id,run.id);await this.noteRun(tx,updated,accepted);
    const checkpoint=run.checkpoint_id?await tx.get('checkpoints',run.checkpoint_id):null;
    const grant=run.budget_grant_id?await tx.get('budget_reservations',run.budget_grant_id):null;
    return{run:redactView(accepted),task:updated,scope:run.scope??{},checkpoint:checkpoint?.checkpoint??null,run_ticket:await this.auth.runTicket(p,accepted),lease_valid_for_ms:45000,budget:grant?viewGrant(grant,p.device):null};
  }
  async sweepReservations(tx:Tx):Promise<void>{
    const live=await this.holdContext(tx);
    for(const reservation of await tx.all('budget_reservations',true)){
      if(reservation.status!=='reserved'||Date.parse(reservation.expires_at)>live.now)continue;
      if(reservationInForce(reservation,live)){await tx.put('budget_reservations',renewReservation(reservation,now(),120000),reservation.id);continue;}
      const next=settleReservation(reservation,[],now(),'expire');
      if(next!==reservation)await tx.put('budget_reservations',next,reservation.id);
    }
  }
  private async settleActivity(tx:Tx,matches:(reservation:Doc)=>boolean,linked:Doc[]):Promise<void>{
    for(const reservation of await tx.all('budget_reservations')){
      if(!matches(reservation))continue;
      const next=settleReservation(reservation,linked,now(),'close');
      if(next!==reservation)await tx.put('budget_reservations',next,reservation.id);
    }
  }
  async releaseBudget(tx:Tx,runId:string):Promise<void>{
    const activityId=canonicalActivityId('run',runId);
    const linked=(await tx.all('usage_records')).filter(row=>row.activity_id===activityId);
    await this.settleActivity(tx,reservation=>workerRunReservation(reservation,runId),linked);
  }
  async releaseActivity(tx:Tx,activityId:string):Promise<void>{
    const linked=(await tx.all('usage_records')).filter(row=>row.activity_id===activityId);
    await this.settleActivity(tx,reservation=>reservation.activity_id===activityId,linked);
  }
  /** Close every still-reserved attempt in one family. Each row settles only its own usage. */
  async releaseActivityRoot(tx:Tx,root:string):Promise<void>{
    const rows=(await tx.all('budget_reservations')).filter(row=>row.status==='reserved'&&activityRootId(String(row.activity_id??''))===root);
    for(const row of rows){
      const linked=(await tx.all('usage_records')).filter(record=>record.activity_id===row.activity_id);
      await this.settleActivity(tx,reservation=>reservation.id===row.id,linked);
    }
  }
  async reserveActivity(tx:Tx,body:Doc,deviceId?:string):Promise<Doc>{
    await graphLock(tx);
    const category:BudgetCategory=['assistant','review','proactive','worker'].includes(body.category)?body.category:'assistant';
    const requested=text(body.operation_key,'operation_key',200);
    const activityId=typeof body.activity_id==='string'?text(body.activity_id,'activity_id',200):requested;
    if(activityId!==requested&&body.new_attempt!==true)throw new ApiError(422,'activity_mismatch','活动标识必须与操作键一致');
    const reservations=await tx.all('budget_reservations');
    const prior=admitReservation(reservations,{operation_key:activityId});
    const terminal=new Set(['released','settled','expired']);
    if(!prior.created){
      const existing=prior.reservation;
      const root=activityRoot(existing,activityId);
      const family=reservations.filter(row=>activityRoot(row,row.activity_id)===root);
      const live=family.filter(row=>row.status==='reserved'&&Number.isFinite(Date.parse(String(row.expires_at)))&&Date.parse(String(row.expires_at))>Date.now()).sort((a,b)=>(Number(b.attempt)||1)-(Number(a.attempt)||1))[0];
      if(body.new_attempt===true){
        if(live)return viewGrant(live,deviceId);
        if(!terminal.has(existing.status))return viewGrant(existing,deviceId);
        const attempt=family.reduce((max,row)=>Math.max(max,Number(row.attempt)||1),1)+1;
        const operation=`${root}#${attempt}`;
        const replay=reservations.find(row=>row.operation_key===operation);
        if(replay)return viewGrant(replay,deviceId);
        body={...body,operation_key:operation,activity_id:operation,prior_activity_id:root,attempt};
      }else return viewGrant(existing,deviceId);
    }
    const operation=text(body.operation_key,'operation_key',200);
    const nextActivity=typeof body.activity_id==='string'?text(body.activity_id,'activity_id',200):operation;
    if(nextActivity!==operation)throw new ApiError(422,'activity_mismatch','活动标识必须与操作键一致');
    const budget=await this.budget(tx);
    const taskId=typeof body.task_id==='string'?body.task_id:null;
    const task=taskId?await tx.get('tasks',taskId):null;
    const allowance=await this.activityAllowance(tx,budget,category,taskId,task?.scope?.budget??null);
    if(!allowance.ok)throw new ApiError(409,allowance.reason,allowance.recovery);
    const kind=body.activity_kind==='run'||body.activity_kind==='assistant'||body.activity_kind==='review'||body.activity_kind==='proactive'?body.activity_kind:category==='worker'?'run':category;
    const runId=kind==='run'&&typeof body.run_id==='string'?body.run_id:null;
    const saved=await tx.put('budget_reservations',{...buildReservation({operation_key:operation,activity_kind:kind,activity_id:nextActivity,task_id:taskId,run_id:runId,category,limits:allowance.limits,amount:allowance.amount,expires_at:expires(120000),money_treatment:allowance.treatment}),device_id:deviceId??null,attempt:Number(body.attempt)||1,prior_activity_id:body.prior_activity_id??null,ceiling:allowance.ceiling});
    return viewGrant(saved,deviceId);
  }
  async assessRunBudget(tx:Tx,run:Doc):Promise<{reason:BudgetStopReason;recovery:string}|null>{
    const budget=await this.budget(tx);
    if(budget.monthly_limit_usd!==null&&budget.unknown_count===0&&new Decimal(budget.used_usd).gte(budget.monthly_limit_usd))return{reason:'budget_exhausted',recovery:BUDGET_RECOVERY.budget_exhausted};
    const task=await tx.need('tasks',run.task_id);
    const ceiling=configuredLimits('worker',[budget.category_limits?.worker,task.scope?.budget]);
    const records=(await tx.all('usage_records')).filter(r=>r.task_id===task.id);
    const runIds=new Set((await tx.all('runs')).filter(r=>r.task_id===task.id).map(r=>r.id));
    const steps=(await tx.all('steps')).filter(s=>runIds.has(s.run_id));
    const spent=spendFor(records,steps,'worker');
    const money=taskDollarStop(budget,records);
    let reason:BudgetStopReason|null=money;
    if(!reason&&Date.now()-Date.parse(run.created_at)>=ceiling.max_runtime_ms)reason='time_limit';
    if(!reason)reason=usageStop(ceiling,spent);
    return reason?{reason,recovery:recovery(reason)}:null;
  }
  async heartbeatRun(tx:Tx,runId:string):Promise<void>{
    const activityId=canonicalActivityId('run',runId);
    for(const reserve of (await tx.all('budget_reservations')).filter(row=>row.status==='reserved'&&row.activity_kind==='run'&&(row.activity_id===activityId||row.run_id===runId)))await tx.put('budget_reservations',renewReservation(reserve,now(),120000),reserve.id);
  }
  async heartbeatActivity(tx:Tx,activityId:string,deviceId?:string):Promise<Doc>{
    const rows=(await tx.all('budget_reservations',true)).filter(row=>row.status==='reserved'&&row.activity_id===activityId&&(!deviceId||!row.device_id||row.device_id===deviceId));
    const row=rows[0];
    if(rows.length!==1||!row)throw new ApiError(404,'not_found','预算预留不存在');
    return presentGrant(await tx.put('budget_reservations',renewReservation(row,now(),120000),row.id));
  }
  async noteQuestion(tx:Tx,task:Doc,run:Doc):Promise<void>{await emitTaskProgress(tx,task,run,'question','waiting_input','等待你的回答','needs_user');}
  private async noteRun(tx:Tx,task:Doc,run:Doc):Promise<void>{
    await advanceActionReceipts(tx,task,run);
    const waiting=run.state==='lost'||run.state==='result_unknown'?'reconcile_required':typeof task.reason_code==='string'?task.reason_code:null;
    await emitTaskProgress(tx,task,run,'run',runProgressPhase(String(run.state)),typeof run.summary==='string'?run.summary:'',waiting);
  }
  async action(tx:Tx,id:string,body:Doc,header:unknown,cascade=true):Promise<Doc>{
    await graphLock(tx);
    const task=await tx.need('tasks',id,true);matchVersion(header,task,body.version);
    const action=text(body.action,'action',30),run=task.current_run_id?await tx.get('runs',task.current_run_id,true):null;
    const receipt=async():Promise<Doc>=>{
      if(cascade===false)return{action_id:randomUUID(),status:'accepted'};
      const fresh=await tx.need('tasks',id);const freshRun=fresh.current_run_id?await tx.get('runs',fresh.current_run_id):null;
      return acceptControl(tx,{task:fresh,action,body,run:freshRun});
    };
    if(!['pause','resume','cancel','switch','retry'].includes(action))throw new ApiError(422,'invalid_action','任务操作无效');
    if(action==='cancel'&&cascade){
      const tasks=await tx.all('tasks',true),affected=new Set([task.id]);let changed=true;
      while(changed){changed=false;for(const child of tasks)if(!affected.has(child.id)&&(affected.has(child.parent_task_id)||(child.depends_on_task_ids??[]).some((dep:string)=>affected.has(dep)))){affected.add(child.id);changed=true;}}
      for(const child of tasks.filter(t=>affected.has(t.id)&&t.id!==task.id)){const current=await tx.need('tasks',child.id);await this.action(tx,current.id,{action:'cancel'},String(current.version),false);}
      const current=await tx.need('tasks',task.id);await this.action(tx,current.id,{action:'cancel'},String(current.version),false);
      return receipt();
    }
    if(action==='cancel'&&['succeeded','failed','cancelled'].includes(task.status))return receipt();
    if(run&&['lost','result_unknown'].includes(run.state)&&['resume','retry','switch'].includes(action))throw new ApiError(409,'result_unknown','先核对旧执行结果，再重试或切换');
    if(action==='switch'){
      if(!body.target)throw new ApiError(422,'target_required','需要目标引擎和电脑');engine(body.target.engine);await tx.need('devices',uuid(body.target.device_id));
    }
    let next:Doc={...task};
    if((action==='resume'||action==='retry')&&run&&ACTIVE.includes(run.state))throw new ApiError(409,'run_active','请先等待当前执行停止');
    if(action==='resume'||action==='retry')next={...task,status:'queued',reason_code:null,current_run_id:null,cancellation_requested:false};
    if(action==='switch')next.cancellation_requested=false;
    if(action==='pause'||action==='cancel'||action==='switch'){
      const active=run&&ACTIVE.includes(run.state);
      if(active&&run.state==='dispatched'){
        await tx.put('runs',{...run,state:'cancelled',summary:'开始前已停止',lease_expires_at:now()});const command=await tx.get('commands',run.command_id);if(command)await tx.put('commands',{...command,state:'cancelled'});await this.releaseBudget(tx,run.id);
        next=action==='switch'?{...task,engine:body.target.engine,device_id:body.target.device_id,model_id:body.target.model_id??null,status:'queued',reason_code:null,current_run_id:null}:{...task,status:action==='cancel'?'cancelled':'paused',reason_code:null};
      }else if(active){await tx.put('runs',{...run,state:'stopping',control:{action}});next={...task,status:action==='switch'?'switching':'pausing',pending_action:action,pending_target:body.target??null};}
      else if(action==='switch'){
        if(run&&['lost','result_unknown'].includes(run.state))throw new ApiError(409,'result_unknown','先核对旧执行结果，再切换');
        next={...task,engine:body.target.engine,device_id:body.target.device_id,model_id:body.target.model_id??null,status:'queued',reason_code:null,current_run_id:null};
      }else next=run&&['lost','result_unknown'].includes(run.state)?{...task,status:'waiting_input',reason_code:'result_unknown',cancellation_requested:action==='cancel'}:{...task,status:action==='cancel'?'cancelled':'paused',reason_code:null};
    }
    if(action==='cancel')next.cancellation_requested=true;
    if(action==='switch')next.cancellation_requested=false;
    const updated=await tx.put('tasks',next);await tx.emit('task.changed',updated,id,run?.id??null);
    if(action==='cancel')for(const question of (await tx.all('questions')).filter(q=>q.task_id===task.id&&q.status==='open'))await tx.put('questions',{...question,status:'cancelled'});
    if(updated.status==='cancelled')await this.team.event(tx,'task.cancelled',updated,run);
    await this.team.refreshBlocked(tx);await this.team.settled(tx,task.plan_id??null);return receipt();
  }
  async report(tx:Tx,p:Principal,message:Doc):Promise<void>{
    await graphLock(tx);
    if(message.protocol_version!=='1.0')throw new ApiError(422,'protocol_version','协议版本无效');
    const messageId=uuid(message.message_id),payload=message.payload;
    if(!payload||typeof payload!=='object'||payload.device_id!==p.device)throw new ApiError(403,'device_mismatch','设备归属不匹配');
    if('tenant_id'in payload||'user_id'in payload||'api_key'in payload)throw new ApiError(422,'forbidden_field','回报不允许指定身份或凭据');
    const digest=hash(message),producer=payload.producer_id??null,seq=payload.producer_seq??null;
    const old=await tx.client.query('SELECT * FROM sa_report_receipts WHERE tenant_id=$1 AND (message_id=$2 OR (producer_id=$3 AND producer_seq=$4))',[tx.tenant,messageId,producer,seq]);
    if(old.rows[0]){if(old.rows[0].request_hash!==digest)throw new ApiError(409,'report_conflict','回报标识已被不同内容使用');return;}
    if(message.kind==='command.ack'){
      const cmd=await tx.need('commands',uuid(payload.command_id),true);if(cmd.device_id!==p.device)throw new ApiError(404,'not_found','命令不存在');
      if(!['stored','duplicate','rejected'].includes(payload.status))throw new ApiError(422,'invalid_ack','命令回报无效');
      if(cmd.state!=='accepted')await tx.put('commands',{...cmd,receipt_status:payload.status,state:cmd.kind==='run.start'?cmd.state:'accepted'});
    }else if(message.kind==='action.progress'){
      if(!producer||!/^\d+$/.test(String(seq)))throw new ApiError(422,'producer_required','缺少有效回报序列');
      await noteActionProgress(tx,p.device!,payload);
    }else{
      const initial=await tx.need('runs',uuid(payload.run_id));await tx.need('tasks',initial.task_id,true);const run=await tx.need('runs',initial.id,true);if(run.device_id!==p.device||String(payload.lease_epoch)!==String(run.lease_epoch))throw new ApiError(404,'not_found','执行不存在');
      if(!producer||!/^\d+$/.test(String(seq)))throw new ApiError(422,'producer_required','缺少有效回报序列');
      if(message.kind==='usage.report')await this.usage(tx,workerUsageActivity(run,payload),payload);
      else if(message.kind==='run.state')await this.runState(tx,run,payload);
      else if(['step.updated','tool.receipt'].includes(message.kind))await storeStep(tx,run,payload);
      else throw new ApiError(422,'unsupported_report','不支持的回报类型');
    }
    await tx.client.query('INSERT INTO sa_report_receipts(tenant_id,message_id,producer_id,producer_seq,request_hash) VALUES($1,$2,$3,$4,$5)',[tx.tenant,messageId,producer,seq,digest]);
  }
  async runState(tx:Tx,run:Doc,payload:Doc):Promise<void>{
    const state=payload.state;
    if(!['starting','running','waiting_input','paused','succeeded','failed','cancelled','result_unknown'].includes(state))throw new ApiError(422,'invalid_state','执行状态无效');
    if(TERMINAL.includes(run.state)&&state!==run.state)throw new ApiError(409,'terminal_run','不能修改已结束执行');
    if(state==='running'&&(!['starting','running','waiting_input'].includes(run.state)||Date.parse(run.lease_expires_at)<Date.now()))throw new ApiError(409,'run_lease_invalid','执行租约已失效');
    const updatedRun=await tx.put('runs',{...run,state,summary:typeof payload.summary==='string'?payload.summary.slice(0,1000):run.summary??'',result:payload.result===undefined?run.result??null:payload.result});
    const task=await tx.need('tasks',run.task_id,true);
    // A fresh envelope is not a fresh execution. Terminal reports may refine
    // the Run display, but never replay Task completion/approval side effects.
    if((TERMINAL.includes(run.state)&&state===run.state)||task.status==='cancelled'){
      if(TERMINAL.includes(state))await this.releaseBudget(tx,run.id);
      await tx.emit('run.changed',redactView(updatedRun),run.task_id,run.id);await this.noteRun(tx,task,updatedRun);return;
    }
    if(task.current_run_id===run.id){
      let next:Doc={...task};
      if(state==='running'||state==='starting')next.status='running';
      if(state==='waiting_input')next.status='waiting_input';
      if(state==='result_unknown'){next.status='waiting_input';next.reason_code='result_unknown';}
      const cancellationRequested=task.cancellation_requested===true||task.pending_action==='cancel';
      if(cancellationRequested&&!TERMINAL.includes(state)){next.status=state==='result_unknown'?'waiting_input':'pausing';next.pending_action='cancel';next.cancellation_requested=true;}
      if(TERMINAL.includes(state)){
        await this.releaseBudget(tx,run.id);
        if(task.pending_action==='switch'&&['paused','cancelled'].includes(state)){
          next={...task,engine:task.pending_target.engine,device_id:task.pending_target.device_id,model_id:task.pending_target.model_id??null,status:'queued',reason_code:null,current_run_id:null,pending_action:null,pending_target:null};
        }else if(cancellationRequested)next={...task,status:'cancelled',pending_action:null,reason_code:null,cancellation_requested:true};
        else{const budgetReason=['token_limit','model_call_limit','tool_step_limit','time_limit','budget_exhausted','budget_unknown'].includes(run.control?.reason)?run.control.reason:null;next={...task,status:state==='succeeded'?(task.delivery_status&&task.delivery_status!=='not_submitted'?task.status:'awaiting_review'):state,pending_action:null,reason_code:state==='failed'?'execution_failed':state==='paused'&&budgetReason?budgetReason:state==='succeeded'&&task.delivery_status&&task.delivery_status!=='not_submitted'?task.reason_code:null};}
        if(state==='paused'&&next.status!=='cancelled')for(const view of (await tx.all('views')).filter(v=>v.run_id===run.id&&v.control_requested&&v.state!=='closed'&&Date.parse(v.control_expires_at??v.expires_at)>Date.now())){
          await tx.put('views',{...view,control_state:'active',control_expires_at:expires(60000)});
          const commandId=randomUUID();await tx.put('commands',{protocol_version:'1.0',message_id:randomUUID(),kind:'view.control',sent_at:now(),device_id:run.device_id,run_id:run.id,state:'pending',expires_at:expires(60000),payload:{command_id:commandId,run_id:run.id,view_id:view.id,enabled:true}},commandId);
        }
      }
      if(state==='succeeded'&&next.status!=='cancelled'&&(!task.delivery_status||task.delivery_status==='not_submitted')){await this.team.submit(tx,task,updatedRun);await proposeRetrospective(tx,updatedRun,task,'succeeded');next.delivery_status='pending';next.status='awaiting_review';}
      if(state==='failed'&&next.status==='failed')await proposeRetrospective(tx,updatedRun,task,'failed');
      const updatedTask=await tx.put('tasks',next);await tx.emit('task.changed',updatedTask,task.id,run.id);
      if(state==='failed'||updatedTask.status==='cancelled'||state==='result_unknown')await this.team.event(tx,updatedTask.status==='cancelled'?'task.cancelled':state==='failed'?'task.failed':'task.result_unknown',updatedTask,updatedRun);
      await this.team.refreshBlocked(tx);await this.team.settled(tx,task.plan_id??null);
    }
    await tx.emit('run.changed',redactView(updatedRun),run.task_id,run.id);
    await this.noteRun(tx,task.current_run_id===run.id?await tx.need('tasks',task.id):task,updatedRun);
  }
  async usage(tx:Tx,activity:Doc,p:Doc):Promise<void>{
    const activityId=text(activity.activity_id,'activity_id',200);
    if(p.activity_id!==undefined&&p.activity_id!==activityId)throw new ApiError(422,'activity_mismatch','用量活动标识不一致');
    const category=['assistant','review','worker','subagent','proactive','memory'].includes(activity.category)?activity.category:null;
    if(!category)throw new ApiError(422,'invalid_usage_category','用量类别无效');
    const requestKey=text(p.request_key,'request_key',256),revision=Number(p.usage_revision);
    if(!Number.isSafeInteger(revision)||revision<1)throw new ApiError(422,'invalid_revision','费用版本无效');
    if(p.engine!==activity.engine||p.model_id!==activity.model_id)throw new ApiError(422,'usage_runtime_mismatch','用量引擎与执行不匹配');
    for(const k of ['input_tokens','output_tokens','cached_input_tokens','reasoning_tokens'])if(p[k]!==null&&p[k]!==undefined&&(!Number.isSafeInteger(p[k])||p[k]<0))throw new ApiError(422,'invalid_tokens','Token 计数无效');
    if(p.cached_input_tokens!=null&&p.input_tokens!=null&&p.cached_input_tokens>p.input_tokens)throw new ApiError(422,'invalid_tokens','缓存 Token 超过输入总数');
    const cost=p.cost??{},source=cost.source;
    if(!['supplier_reported','estimated','unavailable'].includes(source))throw new ApiError(422,'invalid_cost_source','费用来源无效');
    const amount=source==='unavailable'?null:safeMoney(cost.amount);
    if(source!=='unavailable'&&(amount===null||!/^\w{3}$/.test(cost.currency??'')))throw new ApiError(422,'invalid_cost','费用金额或币种无效');
    if(source==='unavailable'&&cost.amount!==null)throw new ApiError(422,'unknown_cost_not_zero','未知费用必须为 null');
    const existing=(await tx.all('usage_records')).find(row=>row.activity_id===activityId&&row.request_key===requestKey);
    const supplied=typeof p.occurred_at==='string'&&/^\d{4}-\d{2}-\d{2}T.+(?:Z|[+-]\d{2}:\d{2})$/.test(p.occurred_at)&&Number.isFinite(Date.parse(p.occurred_at))&&Date.parse(p.occurred_at)<=Date.now()+300000?new Date(Date.parse(p.occurred_at)).toISOString():null;
    const normalized={activity_id:activityId,run_id:activity.run_id??null,task_id:activity.task_id??null,device_id:activity.device_id??null,...(activity.event_id?{event_id:activity.event_id}:{}),request_key:requestKey,usage_revision:revision,engine:activity.engine,model_id:activity.model_id,category,input_tokens:p.input_tokens??null,output_tokens:p.output_tokens??null,cached_input_tokens:p.cached_input_tokens??null,reasoning_tokens:p.reasoning_tokens??null,cost:{source,quality:source==='unavailable'?'missing':cost.quality??'final',amount,currency:cost.currency??null,price_version_id:cost.price_version_id??null},occurred_at:existing?.occurred_at??supplied??now()};
    if(existing){if(revision<existing.usage_revision)return;if(revision===existing.usage_revision){const prior={...existing};delete prior.id;delete prior.version;delete prior.created_at;delete prior.updated_at;delete prior.revisions;if(hash(prior)!==hash(normalized))throw new ApiError(409,'usage_revision_conflict','同一费用版本内容不同');return;}}
    const record=await tx.put('usage_records',{...normalized,revisions:[...(existing?.revisions??[]),...(existing?[{revision:existing.usage_revision,cost:existing.cost,recorded_at:existing.updated_at}]:[])]},existing?.id??randomUUID());
    const matches=(await tx.all('budget_reservations')).filter(reservation=>reservation.activity_id===activityId);
    const grant=matches[0];
    if(matches.length===1&&grant&&grant.status!=='reserved'){
      const linked=(await tx.all('usage_records')).filter(row=>row.activity_id===activityId);
      const unknownCount=linked.filter(row=>row.cost?.amount==null).length;
      const next:Doc={...grant,settlement_unknown_count:unknownCount};
      if(!grant.late_usage_at){next.late_usage=true;next.late_usage_at=now();}
      if(grant.status!=='expired'){
        next.settlement_state=unknownCount>0?'unknown':'settled';
        if(unknownCount===0&&grant.status==='released')next.status='settled';
      }
      await tx.put('budget_reservations',next,grant.id);
    }
    await tx.emit('usage.changed',{id:record.id,run_id:activity.run_id??null,revision,cost:record.cost},activity.task_id??null,activity.run_id??null);
  }
  async costs(tx:Tx,query:Doc):Promise<Doc[]>{
    const range=costRange(query);
    let records=(await tx.all('usage_records')).filter(r=>Date.parse(r.occurred_at)>=range.from&&Date.parse(r.occurred_at)<=range.to);
    for(const k of ['device_id','task_id','engine','model_id'])if(query[k])records=records.filter(r=>r[k]===query[k]);return records;
  }
  summary(records:Doc[]):Doc{
    const totals=new Map<string,{currency:string;source:string;amount:Decimal}>();
    for(const r of records)if(r.cost.amount!==null){const key=`${r.cost.currency}:${r.cost.source}`,entry=totals.get(key)??{currency:r.cost.currency,source:r.cost.source,amount:new Decimal(0)};entry.amount=entry.amount.plus(r.cost.amount);totals.set(key,entry);}
    const unknown=records.filter(r=>r.cost.amount===null).length;
    return{totals:[...totals.values()].map(t=>({...t,amount:t.amount.toFixed()})),input_tokens:records.reduce((n,r)=>n+(r.input_tokens??0),0),output_tokens:records.reduce((n,r)=>n+(r.output_tokens??0),0),unknown_count:unknown,request_count:records.length,coverage:records.length?(records.length-unknown)/records.length:1,as_of:now()};
  }
}
