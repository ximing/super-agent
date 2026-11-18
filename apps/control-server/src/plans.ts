import { ApiError, Tx, type Doc, hash } from './store.js';
import { text, uuid } from './auth.js';
import { Service, engine } from './service.js';

export class PlanService {
  constructor(private service:Service){}
  async source(tx:Tx,id:string):Promise<Doc>{const message=await tx.need('messages',uuid(id));if(message.role!=='user'||message.task_id)throw new ApiError(422,'global_user_source_required','规划需要全局用户交办');return message;}
  async prepare(tx:Tx,id:string):Promise<Doc>{const source=await this.source(tx,id);const existing=(await tx.all('plans',true)).find(p=>p.source_message_id===source.id);return existing??tx.put('plans',{source_message_id:source.id,state:'draft',tasks:[],items:[]});}
  async propose(tx:Tx,id:string,body:Doc):Promise<Doc>{
    const plan=await tx.need('plans',uuid(id),true);if(plan.state==='committed'||plan.state==='rejected')return plan;
    const source=await this.source(tx,plan.source_message_id),pinned=source.execution_preference;
    if(!Array.isArray(body.items)||body.items.length<1||body.items.length>20)throw new ApiError(422,'invalid_plan','计划需要1至20个任务');
    const keys=new Set<string>(),proposed:Doc[]=[];
    for(const item of body.items){
      const key=text(item.item_key,'item_key',100);if(keys.has(key))throw new ApiError(422,'duplicate_plan_item','计划项目重复');keys.add(key);
      const device=uuid(item.device_id),selectedEngine=engine(item.engine);await tx.need('devices',device);
      if(pinned&&pinned.selection_mode!=='auto'&&((pinned.device_id&&pinned.device_id!==device)||(pinned.engine&&pinned.engine!==selectedEngine)))throw new ApiError(422,'pinned_execution_mismatch','计划不能改变用户指定的电脑或引擎');
      if(item.deliverables!==undefined&&(!Array.isArray(item.deliverables)||item.deliverables.length>20))throw new ApiError(422,'invalid_deliverables','交付标准最多20项');
      const deliverables=Array.isArray(item.deliverables)?item.deliverables.map((d:unknown)=>text(d,'deliverable',1000)):[];
      proposed.push({item_key:key,title:text(item.title??item.goal,'title',200),goal:text(item.goal,'goal'),deliverables,engine:selectedEngine,device_id:device,...(item.model_id?{model_id:text(item.model_id,'model_id',200)}:{})});
    }
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
    const plan=await tx.need('plans',uuid(id),true);
    if(plan.state==='committed')return plan;
    if(plan.state!=='awaiting_confirmation')throw new ApiError(409,'plan_not_confirmable','计划尚未等待确认或已经拒绝');
    const message=await this.decision(tx,plan,messageId,'confirm'),tasks:Doc[]=[];
    for(const item of plan.items)tasks.push(await this.service.createTask(tx,{...item,plan_id:plan.id,source_message_id:plan.source_message_id,confirmation_message_id:message.id}));
    const saved=await tx.put('plans',{...plan,state:'committed',tasks,confirmed_by_message_id:message.id});
    await tx.put('inbox_receipts',{source_message_id:plan.source_message_id},plan.source_message_id);await tx.put('inbox_receipts',{source_message_id:message.id},message.id);
    await tx.emit('plan.confirmed',{id:saved.id,tasks:tasks.map(t=>t.id),version:saved.version});return saved;
  }
  async reject(tx:Tx,id:string,messageId:string):Promise<Doc>{
    const plan=await tx.need('plans',uuid(id),true);if(plan.state==='rejected')return plan;if(plan.state!=='awaiting_confirmation')throw new ApiError(409,'plan_not_rejectable','计划当前不能拒绝');
    const message=await this.decision(tx,plan,messageId,'reject'),saved=await tx.put('plans',{...plan,state:'rejected',rejected_by_message_id:message.id});
    await tx.put('inbox_receipts',{source_message_id:plan.source_message_id},plan.source_message_id);await tx.put('inbox_receipts',{source_message_id:message.id},message.id);await tx.emit('plan.rejected',{id:saved.id,version:saved.version});return saved;
  }
}
