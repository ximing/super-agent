import { randomUUID } from 'node:crypto';
import { Decimal } from 'decimal.js';
import { Auth, type Principal, now, expires, text, uuid } from './auth.js';
import { ApiError, Store, Tx, hash, type Doc } from './store.js';
import { storeStep } from './steps.js';
import { TeamService,graphLock,deliverables as normalizeDeliverables } from './team.js';
import { normalizeMemoryScope, proposeRetrospective } from './memory-governance.js';
import { accumulatedStop, admitReservation, dollarAdmission, evaluateLimits, limitsFor, publicGrant, usageTotals } from './budget-control.js';

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
export class Service {
  readonly team=new TeamService();
  constructor(public store:Store,public auth:Auth){}
  async deviceView(tx:Tx,d:Doc):Promise<Doc>{
    const active=(await tx.all('runs')).some(r=>r.device_id===d.id&&ACTIVE.includes(r.state));
    return{...d,status:!d.last_seen_at||Date.parse(d.last_seen_at)<Date.now()-30000?'offline':active?'busy':'online'};
  }
  async settings(tx:Tx):Promise<Doc>{const stored=await tx.get('settings',tx.tenant);return stored?{memory_global_read:false,...stored}:{id:tx.tenant,default_engine:'codex',default_device_id:null,assistant_device_id:null,memory_global_read:false,version:0};}
  async budget(tx:Tx):Promise<Doc>{const b=await tx.get('budgets',tx.tenant)??{id:tx.tenant,monthly_limit_usd:null,task_limit_usd:null,version:0};const month=(await tx.all('usage_records')).filter(u=>String(u.occurred_at).slice(0,7)===now().slice(0,7));const usage=month.filter(u=>u.cost?.currency==='USD'&&u.cost?.amount!==null);return{...b,used_usd:usage.reduce((s,u)=>s.plus(u.cost.amount),new Decimal(0)).toFixed(),unknown_count:month.length-usage.length};}
  async createTask(tx:Tx,body:Doc,reservedId?:string):Promise<Doc>{
    await graphLock(tx);
    const settings=await this.settings(tx),selectedEngine=engine(body.engine??settings.default_engine);
    const deviceId=uuid(body.device_id??settings.default_device_id,'device_id');await tx.need('devices',deviceId);
    const goal=text(body.goal,'goal'),id=reservedId??randomUUID(),criteria=normalizeDeliverables(body.deliverables),memory=normalizeMemoryScope(body.memory_scope);
    if(body.plan_id&&!reservedId)throw new ApiError(422,'managed_plan_required','计划任务需由已确认方案原子创建');
    if(body.plan_id)await tx.need('plans',uuid(body.plan_id));
    let task=await tx.put('tasks',{id,title:typeof body.title==='string'?body.title.slice(0,160):goal.slice(0,80),goal,deliverables:criteria,status:'queued',reason_code:null,engine:selectedEngine,model_id:body.model_id?text(body.model_id,'model_id',200):null,device_id:deviceId,current_run_id:null,scope_version_id:randomUUID(),scope:{source:body.source_message_id?'message':'explicit_user_task',source_message_id:body.source_message_id??null,confirmation_message_id:body.confirmation_message_id??null,goal,deliverables:criteria,...(memory?{memory}:{})},plan_id:body.plan_id??null,item_key:body.item_key??null,parent_task_id:null,root_task_id:id,depends_on_task_ids:[],delivery_status:'not_submitted'});
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
        const reserveAmount=budget.task_limit_usd??(budget.monthly_limit_usd!==null?'1':'0');
        const spent=usageTotals((await tx.all('usage_records')).filter(record=>record.task_id===task.id),[],null);
        const over=accumulatedStop(limitsFor('worker',task.scope?.budget),spent);
        if(over){if(task.reason_code!==over){const updated=await tx.put('tasks',{...task,status:'queued',reason_code:over});await tx.emit('budget.changed',{reason:over},task.id);}continue;}
        const admission=dollarAdmission(budget,reservations,reserveAmount);
        if(!admission.ok){
          if(task.reason_code!==admission.reason){const updated=await tx.put('tasks',{...task,status:'queued',reason_code:admission.reason});await tx.emit('budget.changed',{reason:admission.reason},task.id);}continue;
        }
        const runId=randomUUID(),commandId=randomUUID(),grantId=randomUUID(),epoch='1',lease=expires(45000);
        const hold=admitReservation(reservations,{run_id:runId,amount:reserveAmount,status:'reserved',expires_at:expires(120000),operation_key:`reserve:${runId}`,category:'worker',limits:limitsFor('worker',task.scope?.budget),money_treatment:budget.monthly_limit_usd===null&&budget.task_limit_usd===null?'unconfigured':budget.unknown_count>0?'unknown_not_zero':'known'});
        if(hold.created)await tx.put('budget_reservations',hold.reservation,grantId);
        const run=await tx.put('runs',{id:runId,task_id:task.id,device_id:device.id,engine:task.engine,model_id:model,lease_epoch:epoch,lease_expires_at:lease,state:'dispatched',summary:'等待执行电脑接受',scope_version_id:task.scope_version_id,budget_grant_id:grantId,command_id:commandId,checkpoint_id:task.checkpoint_id??null,scope:{...task.scope,dependencies:await this.team.dependencies(tx,task)},control:null});
        const command={protocol_version:'1.0',message_id:randomUUID(),kind:'run.start',sent_at:now(),payload:{command_id:commandId,tenant_id:tenant,task_id:task.id,run_id:runId,device_id:device.id,lease_epoch:epoch,scope_version_id:task.scope_version_id,capability_generation:caps.generation??1,runtime:{engine:task.engine,model_id:model,local_profile_id:cap.local_profile_id??'default'},expires_at:expires(60000),lease_valid_for_ms:45000,checkpoint_id:task.checkpoint_id??null,budget_grant_id:grantId}};
        await tx.put('commands',{...command,device_id:device.id,run_id:runId,state:'pending',expires_at:command.payload.expires_at},commandId);
        const updated=await tx.put('tasks',{...task,status:'queued',reason_code:'awaiting_device_accept',model_id:model,current_run_id:runId,delivery_status:'not_submitted'});
        await tx.emit('run.started',redactView(run),task.id,runId);await tx.emit('task.changed',updated,task.id,runId);
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
              await tx.put('runs',{...run,state:'cancelled',summary:'启动命令过期，未被接受'});
              await tx.put('commands',{...command,state:'expired'});
              const task=await tx.need('tasks',run.task_id);if(task.current_run_id===run.id)await tx.put('tasks',{...task,current_run_id:null,status:'queued',reason_code:'command_expired'});
              await this.releaseBudget(tx,run.id);continue;
            }
          }
          if(['starting','running','waiting_input','stopping'].includes(run.state)&&Date.parse(run.lease_expires_at)<Date.now()){
            await tx.put('runs',{...run,state:'lost',summary:'设备租约失效，等待核对'});
            await this.releaseBudget(tx,run.id);
            const task=await tx.need('tasks',run.task_id);if(task.current_run_id===run.id){const updated=await tx.put('tasks',{...task,status:'waiting_device',reason_code:'run_result_requires_reconciliation'});await tx.emit('task.changed',updated,task.id,run.id);await this.team.event(tx,'task.result_unknown',updated,run);}
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
        for(const reservation of await tx.all('budget_reservations',true)){
          if(reservation.status==='reserved'&&Date.parse(reservation.expires_at)<=Date.now()){
            const owner=reservation.run_id?await tx.get('runs',reservation.run_id):null;
            if(!owner||!ACTIVE.includes(owner.state))await tx.put('budget_reservations',{...reservation,status:'expired',expired_at:now()});
          }
        }
        const schedules=(await tx.all('schedules',true)).filter(s=>s.enabled&&Date.parse(s.next_due_at)<=Date.now());
        for(const schedule of schedules){
          const sourceMessage=await tx.put('messages',{role:'user',content:schedule.goal,task_id:null,client_message_id:`schedule:${schedule.id}:${schedule.next_due_at}`,execution_preference:{engine:schedule.engine,device_id:schedule.device_id},schedule_id:schedule.id});
          await tx.put('schedules',{...schedule,next_due_at:expires(schedule.interval_minutes*60000),last_message_id:sourceMessage.id});
          await tx.emit('message.created',sourceMessage);
        }
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
    const updated=await tx.put('tasks',{...task,status:'running',reason_code:null});await tx.emit('task.changed',updated,task.id,run.id);
    const checkpoint=run.checkpoint_id?await tx.get('checkpoints',run.checkpoint_id):null;
    const grant=run.budget_grant_id?await tx.get('budget_reservations',run.budget_grant_id):null;
    return{run:redactView(accepted),task:updated,scope:run.scope??{},checkpoint:checkpoint?.checkpoint??null,run_ticket:await this.auth.runTicket(p,accepted),lease_valid_for_ms:45000,budget:grant?publicGrant(grant):null};
  }
  async releaseBudget(tx:Tx,runId:string):Promise<void>{for(const r of (await tx.all('budget_reservations')).filter(r=>r.run_id===runId&&r.status==='reserved'))await tx.put('budget_reservations',{...r,status:'released',released_at:now()});}
  async reserveActivity(tx:Tx,body:Doc):Promise<Doc>{
    const category=['assistant','review','proactive','worker'].includes(body.category)?body.category:'assistant';
    const operation=text(body.operation_key,'operation_key',200);
    const reservations=await tx.all('budget_reservations');
    const prior=admitReservation(reservations,{operation_key:operation});
    if(!prior.created)return publicGrant(prior.reservation);
    const budget=await this.budget(tx),amount=budget.task_limit_usd??(budget.monthly_limit_usd!==null?'1':'0');
    const admission=dollarAdmission(budget,reservations,amount);
    if(!admission.ok)throw new ApiError(409,admission.reason??'budget_exhausted','预算不足，未开始新的模型调用');
    const limits=limitsFor(category,null);
    if(body.task_id){const spent=usageTotals((await tx.all('usage_records')).filter(record=>record.task_id===body.task_id),[],null);const over=accumulatedStop(limits,spent);if(over)throw new ApiError(409,over,'任务累计限制已到，未开始新的模型调用');}
    const saved=await tx.put('budget_reservations',{run_id:typeof body.task_id==='string'?body.task_id:null,amount,status:'reserved',expires_at:expires(120000),operation_key:operation,category,limits,money_treatment:budget.monthly_limit_usd===null&&budget.task_limit_usd===null?'unconfigured':budget.unknown_count>0?'unknown_not_zero':'known'});
    return publicGrant(saved);
  }
  async action(tx:Tx,id:string,body:Doc,header:unknown,cascade=true):Promise<Doc>{
    await graphLock(tx);
    const task=await tx.need('tasks',id,true);matchVersion(header,task,body.version);
    const action=text(body.action,'action',30),run=task.current_run_id?await tx.get('runs',task.current_run_id,true):null;
    if(!['pause','resume','cancel','switch','retry'].includes(action))throw new ApiError(422,'invalid_action','任务操作无效');
    if(action==='cancel'&&cascade){
      const tasks=await tx.all('tasks',true),affected=new Set([task.id]);let changed=true;
      while(changed){changed=false;for(const child of tasks)if(!affected.has(child.id)&&(affected.has(child.parent_task_id)||(child.depends_on_task_ids??[]).some((dep:string)=>affected.has(dep)))){affected.add(child.id);changed=true;}}
      for(const child of tasks.filter(t=>affected.has(t.id))){const current=await tx.need('tasks',child.id);await this.action(tx,current.id,{action:'cancel'},String(current.version),false);}
      return{action_id:randomUUID(),status:'accepted'};
    }
    if(action==='cancel'&&['succeeded','failed','cancelled'].includes(task.status))return{action_id:randomUUID(),status:'accepted'};
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
    await this.team.refreshBlocked(tx);await this.team.settled(tx,task.plan_id??null);return{action_id:randomUUID(),status:'accepted'};
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
    }else{
      const initial=await tx.need('runs',uuid(payload.run_id));await tx.need('tasks',initial.task_id,true);const run=await tx.need('runs',initial.id,true);if(run.device_id!==p.device||String(payload.lease_epoch)!==String(run.lease_epoch))throw new ApiError(404,'not_found','执行不存在');
      if(!producer||!/^\d+$/.test(String(seq)))throw new ApiError(422,'producer_required','缺少有效回报序列');
      if(message.kind==='usage.report')await this.usage(tx,run,payload);
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
      await tx.emit('run.changed',redactView(updatedRun),run.task_id,run.id);return;
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
        else next={...task,status:state==='succeeded'?(task.delivery_status&&task.delivery_status!=='not_submitted'?task.status:'awaiting_review'):state,pending_action:null,reason_code:state==='failed'?'execution_failed':state==='succeeded'&&task.delivery_status&&task.delivery_status!=='not_submitted'?task.reason_code:null};
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
  }
  async usage(tx:Tx,run:Doc,p:Doc):Promise<void>{
    const requestKey=text(p.request_key,'request_key',256),revision=Number(p.usage_revision);
    if(!Number.isSafeInteger(revision)||revision<1)throw new ApiError(422,'invalid_revision','费用版本无效');
    if(p.engine!==run.engine||p.model_id!==run.model_id)throw new ApiError(422,'usage_runtime_mismatch','用量引擎与执行不匹配');
    for(const k of ['input_tokens','output_tokens','cached_input_tokens','reasoning_tokens'])if(p[k]!==null&&p[k]!==undefined&&(!Number.isSafeInteger(p[k])||p[k]<0))throw new ApiError(422,'invalid_tokens','Token 计数无效');
    if(p.cached_input_tokens!=null&&p.input_tokens!=null&&p.cached_input_tokens>p.input_tokens)throw new ApiError(422,'invalid_tokens','缓存 Token 超过输入总数');
    const cost=p.cost??{},source=cost.source;
    if(!['supplier_reported','estimated','unavailable'].includes(source))throw new ApiError(422,'invalid_cost_source','费用来源无效');
    const amount=source==='unavailable'?null:safeMoney(cost.amount);
    if(source!=='unavailable'&&(amount===null||!/^\w{3}$/.test(cost.currency??'')))throw new ApiError(422,'invalid_cost','费用金额或币种无效');
    if(source==='unavailable'&&cost.amount!==null)throw new ApiError(422,'unknown_cost_not_zero','未知费用必须为 null');
    const existing=(await tx.all('usage_records')).find(u=>(run.event_id?u.event_id===run.event_id:u.run_id===run.id&&!u.event_id)&&u.request_key===requestKey);
    const supplied=typeof p.occurred_at==='string'&&/^\d{4}-\d{2}-\d{2}T.+(?:Z|[+-]\d{2}:\d{2})$/.test(p.occurred_at)&&Number.isFinite(Date.parse(p.occurred_at))&&Date.parse(p.occurred_at)<=Date.now()+300000?new Date(Date.parse(p.occurred_at)).toISOString():null;
    const normalized={run_id:run.id??null,task_id:run.task_id,device_id:run.device_id,...(run.event_id?{event_id:run.event_id}:{}),request_key:requestKey,usage_revision:revision,engine:run.engine,model_id:run.model_id,category:['assistant','review','worker','subagent','proactive','memory'].includes(p.category)?p.category:'worker',input_tokens:p.input_tokens??null,output_tokens:p.output_tokens??null,cached_input_tokens:p.cached_input_tokens??null,reasoning_tokens:p.reasoning_tokens??null,cost:{source,quality:source==='unavailable'?'missing':cost.quality??'final',amount,currency:cost.currency??null,price_version_id:cost.price_version_id??null},occurred_at:existing?.occurred_at??supplied??now()};
    if(existing){if(revision<existing.usage_revision)return;if(revision===existing.usage_revision){const a={...existing};delete a.id;delete a.version;delete a.created_at;delete a.updated_at;delete a.revisions;if(hash(a)!==hash(normalized))throw new ApiError(409,'usage_revision_conflict','同一费用版本内容不同');return;}}
    const record=await tx.put('usage_records',{...normalized,revisions:[...(existing?.revisions??[]),...(existing?[{revision:existing.usage_revision,cost:existing.cost,recorded_at:existing.updated_at}]:[])]},existing?.id??randomUUID());
    const grant=(await tx.all('budget_reservations')).find(reservation=>reservation.run_id===run.id);
    if(grant&&grant.status!=='reserved'&&!grant.late_usage_at)await tx.put('budget_reservations',{...grant,late_usage:true,late_usage_at:now()});
    await tx.emit('usage.changed',{id:record.id,run_id:run.id,revision,cost:record.cost},run.task_id,run.id);
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
