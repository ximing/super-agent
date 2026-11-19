import { ApiError, Tx, type Doc, hash } from './store.js';
import { text, uuid } from './auth.js';
import { Service, engine } from './service.js';
import { randomUUID } from 'node:crypto';
import { graphLock,deliverables,validatePlanGraph } from './team.js';

export class PlanService {
  constructor(private service:Service){}
  async source(tx:Tx,id:string):Promise<Doc>{const message=await tx.need('messages',uuid(id));if(message.role!=='user'||message.task_id)throw new ApiError(422,'global_user_source_required','规划需要全局用户交办');return message;}
  async prepare(tx:Tx,id?:string,eventId?:string):Promise<Doc>{
    await graphLock(tx);if(!!id===!!eventId)throw new ApiError(422,'plan_source_required','只可提供一个用户消息或协调事件来源');
    if(eventId){const event=await tx.need('coordinator_events',uuid(eventId)),existing=(await tx.all('plans',true)).find(p=>p.source_event_id===event.id);return existing??tx.put('plans',{source_message_id:null,source_event_id:event.id,root_source_message_id:event.source_message_id,base_plan_id:event.plan_id,state:'draft',tasks:[],items:[]});}
    const source=await this.source(tx,id!),existing=(await tx.all('plans',true)).find(p=>p.source_message_id===source.id);return existing??tx.put('plans',{source_message_id:source.id,state:'draft',tasks:[],items:[]});
  }
  async propose(tx:Tx,id:string,body:Doc):Promise<Doc>{
    await graphLock(tx);const plan=await tx.need('plans',uuid(id),true);if(plan.state==='committed'||plan.state==='rejected')return plan;
    if(plan.cancellation_requested)throw new ApiError(409,'plan_cancelled','方案已被用户取消');
    const sourceId=plan.source_message_id??plan.root_source_message_id,source=sourceId?await this.source(tx,sourceId):{},pinned=source.execution_preference;
    if(!Array.isArray(body.items)||body.items.length<1||body.items.length>20)throw new ApiError(422,'invalid_plan','计划需要1至20个任务');
    const keys=new Set<string>(),proposed:Doc[]=[];
    for(const item of body.items){
      const key=text(item.item_key,'item_key',100);if(keys.has(key))throw new ApiError(422,'duplicate_plan_item','计划项目重复');keys.add(key);
      const device=uuid(item.device_id),selectedEngine=engine(item.engine);await tx.need('devices',device);
      if(pinned&&pinned.selection_mode!=='auto'&&((pinned.device_id&&pinned.device_id!==device)||(pinned.engine&&pinned.engine!==selectedEngine)))throw new ApiError(422,'pinned_execution_mismatch','计划不能改变用户指定的电脑或引擎');
      if(item.depends_on_keys!==undefined&&(!Array.isArray(item.depends_on_keys)||item.depends_on_keys.length>20))throw new ApiError(422,'invalid_dependency','依赖任务格式无效');
      const depends_on_keys=[...new Set((item.depends_on_keys??[]).map((k:unknown)=>text(k,'dependency',100)))];
      proposed.push({item_key:key,title:text(item.title??item.goal,'title',200),goal:text(item.goal,'goal'),deliverables:deliverables(item.deliverables),engine:selectedEngine,device_id:device,depends_on_keys,parent_item_key:item.parent_item_key?text(item.parent_item_key,'parent_item_key',100):null,...(item.model_id?{model_id:text(item.model_id,'model_id',200)}:{})});
    }
    validatePlanGraph(proposed);
    const summary=text(body.summary??proposed.map(i=>i.title).join('\n'),'summary',10000);
    if(plan.state==='awaiting_confirmation'&&hash({items:plan.items,summary:plan.summary})===hash({items:proposed,summary}))return plan;
    const time=await tx.client.query('SELECT now() AS at');
    const saved=await tx.put('plans',{...plan,state:'awaiting_confirmation',items:proposed,summary,proposed_at:new Date(time.rows[0].at).toISOString()});
    await tx.emit('plan.proposed',{id:saved.id,summary:saved.summary,items:saved.items,version:saved.version});return saved;
  }
  private async decision(tx:Tx,plan:Doc,messageId:string,kind:'confirm'|'reject'):Promise<Doc>{
    const message=await this.source(tx,messageId);
    if(message.schedule_id||Date.parse(message.created_at)<Date.parse(plan.proposed_at??plan.created_at))throw new ApiError(409,'confirmation_source_invalid','需要目标方案之后的真实用户确认消息');
    const content=message.content.trim().replace(/[。！!，,]+$/g,'').trim().toLowerCase();
    const verb=kind==='confirm'?'(?:确认|开始执行|确认执行)':'(?:取消|拒绝|不要执行|取消执行)';
    const pending=(await tx.all('plans')).filter(p=>p.state==='awaiting_confirmation');
    const prefix=plan.id.slice(0,8).toLowerCase();
    const addressed=new RegExp(`^${verb}\\s+(?:${prefix}|${plan.id.toLowerCase()})$`).test(content);
    const unambiguous=pending.length===1&&new RegExp(`^${verb}$`).test(content);
    if(!addressed&&!unambiguous)throw new ApiError(409,'confirmation_required',pending.length>1?`请明确回复“确认 ${prefix}”或“取消 ${prefix}”`:'需要明确的用户确认或拒绝');
    return message;
  }
  async confirm(tx:Tx,id:string,messageId:string):Promise<Doc>{
    await graphLock(tx);const plan=await tx.need('plans',uuid(id),true);
    if(plan.cancellation_requested)throw new ApiError(409,'plan_cancelled','方案已被用户取消，不能再确认');
    if(plan.state==='committed')return plan;
    if(plan.state!=='awaiting_confirmation')throw new ApiError(409,'plan_not_confirmable','计划尚未等待确认或已经拒绝');
    const message=await this.decision(tx,plan,messageId,'confirm'),tasks:Doc[]=[],ids=new Map<string,string>(plan.items.map((item:Doc)=>[item.item_key,randomUUID()]));
    validatePlanGraph(plan.items);
    for(const item of plan.items)tasks.push(await this.service.createTask(tx,{...item,plan_id:plan.id,source_message_id:plan.source_message_id??plan.root_source_message_id,confirmation_message_id:message.id},ids.get(item.item_key)));
    for(let index=0;index<tasks.length;index++){const item=plan.items[index];tasks[index]=await tx.put('tasks',{...tasks[index],parent_task_id:item.parent_item_key?ids.get(item.parent_item_key):null});}
    for(let index=0;index<tasks.length;index++){const item=plan.items[index],task=tasks[index]!;tasks[index]=await this.service.team.attach(tx,task,task.parent_task_id,(item.depends_on_keys??[]).map((key:string)=>ids.get(key)));}
    await this.service.team.refreshBlocked(tx);
    const saved=await tx.put('plans',{...plan,state:'committed',tasks,confirmed_by_message_id:message.id});
    if(plan.source_message_id)await tx.put('inbox_receipts',{source_message_id:plan.source_message_id},plan.source_message_id);await tx.put('inbox_receipts',{source_message_id:message.id},message.id);
    await tx.emit('plan.confirmed',{id:saved.id,tasks:tasks.map(t=>t.id),version:saved.version});return saved;
  }
  async reject(tx:Tx,id:string,messageId:string):Promise<Doc>{
    await graphLock(tx);const plan=await tx.need('plans',uuid(id),true);if(plan.state==='rejected')return plan;if(plan.state!=='awaiting_confirmation')throw new ApiError(409,'plan_not_rejectable','计划当前不能拒绝');
    const message=await this.decision(tx,plan,messageId,'reject'),saved=await tx.put('plans',{...plan,state:'rejected',rejected_by_message_id:message.id});
    if(plan.source_message_id)await tx.put('inbox_receipts',{source_message_id:plan.source_message_id},plan.source_message_id);await tx.put('inbox_receipts',{source_message_id:message.id},message.id);await tx.emit('plan.rejected',{id:saved.id,version:saved.version});return saved;
  }
}
