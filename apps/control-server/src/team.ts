import { randomUUID } from 'node:crypto';
import { ApiError,hash,type Doc,type Tx } from './store.js';
import { text,uuid,type Principal } from './auth.js';
import { publicStep } from './steps.js';
import { deviceEvidenceSatisfied, isIndependentObservation, observationTools } from './acceptance-evidence.js';
import { proposeUserCorrection } from './memory-governance.js';
import { emitTaskProgress } from './interaction.js';

export const DEFAULT_DELIVERABLE='目标完成且有可核对结果';
export async function graphLock(tx:Tx):Promise<void>{await tx.client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`team-graph:${tx.tenant}`]);}
export function deliverables(value:unknown):string[]{
  if(value!==undefined&&(!Array.isArray(value)||value.length>20))throw new ApiError(422,'invalid_deliverables','交付标准最多20项');
  const result=(value as unknown[]|undefined??[]).map(v=>text(v,'deliverable',1000));return result.length?result:[DEFAULT_DELIVERABLE];
}
export function validatePlanGraph(items:Doc[]):void{
  const byKey=new Map(items.map(i=>[i.item_key,i]));
  for(const item of items){
    for(const key of item.depends_on_keys??[])if(!byKey.has(key)||key===item.item_key)throw new ApiError(422,'invalid_dependency','依赖必须是本计划中的其他任务');
    if(item.parent_item_key&&(!byKey.has(item.parent_item_key)||item.parent_item_key===item.item_key))throw new ApiError(422,'invalid_parent','父任务必须在本计划中');
  }
  for(const parentOnly of [false,true]){
    const active=new Set<string>(),done=new Set<string>();
    const visit=(key:string)=>{if(active.has(key))throw new ApiError(422,'task_graph_cycle','任务图不能成环');if(done.has(key))return;active.add(key);const item=byKey.get(key)!;for(const dependency of parentOnly?(item.parent_item_key?[item.parent_item_key]:[]):item.depends_on_keys??[])visit(dependency);active.delete(key);done.add(key);};
    for(const key of byKey.keys())visit(key);
  }
}
export function publicTask(t:Doc):Doc{
  const keys=['id','title','goal','status','reason_code','engine','model_id','device_id','device_name','current_run_id','created_at','updated_at','version','parent_task_id','root_task_id','plan_id','depends_on_task_ids','deliverables','delivery_status'];
  return {...Object.fromEntries(keys.filter(k=>t[k]!==undefined).map(k=>[k,t[k]])),memory_scope:t.scope?.memory??null,budget:t.scope?.budget??null};
}
/** List and write responses keep the stored document and also project the fields clients edit. */
export function taskView(t:Doc):Doc{
  return {...t,memory_scope:t.scope?.memory??null,budget:t.scope?.budget??null};
}
export function publicRun(r:Doc|null,result:string|null=null):Doc|null{return r?Object.fromEntries(['id','task_id','state','engine','device_id','model_id','lease_epoch','summary','created_at'].map(k=>[k,r[k]]).concat([['result_text',result]])):null;}
export function publicArtifact(a:Doc):Doc{
  const page=a.evidence_kind==='page_capture'||a.evidence_kind==='screenshot';
  const uncertain=a.evidence_kind?a.source_uncertain===true||(page&&!(typeof a.source_url==='string'&&a.source_url.length>0)):false;
  return {...Object.fromEntries(['id','name','mime','size','task_id','run_id','status','created_at'].map(k=>[k,a[k]])),integrity:a.integrity==='server_snapshot'?'server_snapshot':'legacy_unverified',finalized_at:a.integrity==='server_snapshot'?a.finalized_at??null:null,...(a.evidence_kind?{evidence_kind:a.evidence_kind,provenance:a.provenance??null,captured_at:a.captured_at??null,source_url:uncertain?null:a.source_url??null,fresh:uncertain?false:a.fresh!==false,stale:uncertain?true:a.stale===true,source_uncertain:uncertain}:{})};
}
export function publicCoordinatorEvent(e:Doc):Doc{return Object.fromEntries(['id','type','task_id','run_id','plan_id','delivery_id','source_message_id','status','reason_code','created_at','version'].map(k=>[k,e[k]??null]));}

export class TeamService {
  async attach(tx:Tx,task:Doc,parentId:unknown,dependencies:unknown):Promise<Doc>{
    if(dependencies!==undefined&&(!Array.isArray(dependencies)||dependencies.length>100))throw new ApiError(422,'invalid_dependency','依赖最多100项');
    const ids=[...new Set((dependencies as unknown[]|undefined??[]).map(id=>uuid(id,'dependency_task_id')))];
    const parent=parentId?await tx.need('tasks',uuid(parentId,'parent_task_id')):null;
    if(parent&&parent.plan_id!==task.plan_id)throw new ApiError(422,'invalid_parent','父任务必须属于同一计划');
    for(const id of ids){const dep=await tx.need('tasks',id);if(dep.plan_id!==task.plan_id||id===task.id)throw new ApiError(422,'invalid_dependency','依赖必须属于同一计划的其他任务');}
    const all=await tx.all('tasks'),updated:Doc={...task,parent_task_id:parent?.id??null,depends_on_task_ids:ids};
    const items:Doc[]=all.map(t=>t.id===task.id?updated:t);
    validatePlanGraph(items.map(t=>({item_key:t.id,parent_item_key:t.parent_task_id,depends_on_keys:t.depends_on_task_ids??[]})));
    let root:Doc=updated;const byId=new Map(items.map(t=>[t.id,t]));while(root.parent_task_id)root=byId.get(root.parent_task_id)!;
    await tx.client.query('DELETE FROM sa_task_dependencies WHERE tenant_id=$1 AND task_id=$2',[tx.tenant,task.id]);
    for(const id of ids)await tx.client.query('INSERT INTO sa_task_dependencies(tenant_id,task_id,dependency_task_id) VALUES($1,$2,$3)',[tx.tenant,task.id,id]);
    return tx.put('tasks',{...updated,root_task_id:root.id});
  }
  async refreshBlocked(tx:Tx):Promise<void>{
    const tasks=await tx.all('tasks'),byId=new Map(tasks.map(t=>[t.id,t]));
    const reasonFor=(task:Doc,path=new Set<string>()):string|null=>{
      if(path.has(task.id))throw new ApiError(409,'task_graph_cycle','任务图出现循环依赖');const visited=new Set([...path,task.id]);let pending=false;
      for(const id of task.depends_on_task_ids??[]){const dep=byId.get(id);if(!dep)throw new ApiError(409,'dependency_missing','依赖任务不存在');
        if(dep.status==='succeeded'&&dep.delivery_status==='accepted')continue;
        if(['failed','cancelled'].includes(dep.status))return`dependency_${dep.status}`;
        if(['result_unknown','run_result_requires_reconciliation','dependency_result_unknown'].includes(dep.reason_code))return'dependency_result_unknown';
        const upstream=reasonFor(dep,visited);if(upstream&&upstream!=='dependencies_pending')return upstream;pending=true;
      }return pending?'dependencies_pending':null;
    };
    for(const task of tasks){
      if(task.current_run_id||!['queued','waiting_device','blocked'].includes(task.status))continue;
      const reason=reasonFor(task),blocked=reason!==null;
      if(blocked&&(task.status!=='blocked'||task.reason_code!==reason)){const saved=await tx.put('tasks',{...task,status:'blocked',reason_code:reason});byId.set(task.id,saved);await tx.emit('task.changed',publicTask(saved),task.id);}
      else if(!blocked&&task.status==='blocked'){const saved=await tx.put('tasks',{...task,status:'queued',reason_code:null});byId.set(task.id,saved);await tx.emit('task.changed',publicTask(saved),task.id);}
    }
  }
  async event(tx:Tx,type:string,task:Doc|null,run:Doc|null,deliveryId:string|null=null,planId:string|null=null,discriminator=''):Promise<Doc>{
    const key=`${type}:${run?.id??planId??task?.id}:${discriminator}`;
    const prior=(await tx.all('coordinator_events')).find(e=>e.event_key===key);if(prior)return prior;
    const plan=(planId??task?.plan_id)?await tx.get('plans',planId??task!.plan_id):null;
    const saved=await tx.put('coordinator_events',{type,event_key:key,task_id:task?.id??null,run_id:run?.id??null,plan_id:planId??task?.plan_id??null,delivery_id:deliveryId,source_message_id:plan?.source_message_id??plan?.root_source_message_id??task?.scope?.source_message_id??null,status:'pending',reason_code:task?.reason_code??null});
    await tx.emit('coordinator.event',publicCoordinatorEvent(saved),task?.id??null,run?.id??null);return saved;
  }
  async submit(tx:Tx,task:Doc,run:Doc):Promise<Doc>{
    const existing=(await tx.all('task_deliveries')).find(d=>d.run_id===run.id);if(existing)return existing;
    const checkpoint=(await tx.all('checkpoints')).find(c=>c.run_id===run.id&&c.task_id===task.id&&c.checkpoint?.completed===true);
    const artifacts=(await tx.all('artifacts')).filter(a=>a.task_id===task.id&&a.run_id===run.id&&a.status==='ready');
    const saved=await tx.put('task_deliveries',{task_id:task.id,run_id:run.id,status:'pending',deliverables:deliverables(task.deliverables),checkpoint_id:checkpoint?.id??null,artifact_ids:artifacts.map(a=>a.id)});
    await this.event(tx,'delivery.submitted',task,run,saved.id);
    await emitTaskProgress(tx,task,run,'delivery','reviewing','交付待核对',null);return saved;
  }
  async settled(tx:Tx,planId:string|null):Promise<void>{
    if(!planId)return;const tasks=(await tx.all('tasks')).filter(t=>t.plan_id===planId);if(!tasks.length)return;
    const finished=tasks.every(t=>['succeeded','failed','cancelled'].includes(t.status)||t.status==='blocked'&&['dependency_failed','dependency_cancelled'].includes(t.reason_code));
    if(!finished)return;const plan=await tx.need('plans',planId),status=plan.cancellation_requested||tasks.every(t=>t.status==='cancelled')?'cancelled':tasks.every(t=>t.status==='succeeded'&&t.delivery_status==='accepted')?'completed':'needs_attention';
    if(plan.execution_status!==status)await tx.put('plans',{...plan,execution_status:status});
    await this.event(tx,'plan.settled',null,null,null,planId,hash(tasks.map(t=>[t.id,t.current_run_id,t.status,t.delivery_status])).slice(0,24));
  }
  async evidence(tx:Tx,id:string):Promise<Doc>{
    const task=await tx.need('tasks',uuid(id)),run=task.current_run_id?await tx.need('runs',task.current_run_id):null;
    if(run&&run.task_id!==task.id)throw new ApiError(409,'run_scope_mismatch','运行与任务不匹配');
    const delivery=(await tx.all('task_deliveries')).find(d=>d.run_id===run?.id)??null;
    const checkpoints=run?(await tx.all('checkpoints')).filter(c=>c.run_id===run.id&&c.task_id===task.id):[];
    const checkpoint=delivery?checkpoints.find(c=>c.id===delivery.checkpoint_id):checkpoints.filter(c=>c.checkpoint?.completed===true).at(-1);
    const result=typeof checkpoint?.checkpoint.result_text==='string'?checkpoint.checkpoint.result_text:null;
    return{task:publicTask(task),run:publicRun(run,result),delivery,deliverables:deliverables(delivery?.deliverables??task.deliverables),result_text:result,evidence_error:checkpoint?.checkpoint.evidence_error?(['artifact_upload_failed','artifact_missing'].includes(checkpoint.checkpoint.evidence_error)?checkpoint.checkpoint.evidence_error:'artifact_missing'):null,checkpoint:checkpoint?{id:checkpoint.id,created_at:checkpoint.created_at}:null,steps:(await tx.all('steps')).filter(s=>s.run_id===run?.id).map(publicStep),artifacts:(await tx.all('artifacts')).filter(a=>a.task_id===task.id&&a.run_id===run?.id&&a.status==='ready'&&(!delivery||delivery.artifact_ids.includes(a.id))).map(publicArtifact),reviews:(await tx.all('task_reviews')).filter(r=>r.task_id===task.id&&r.run_id===run?.id)};
  }
  async eventContext(tx:Tx,id:string):Promise<Doc>{
    const event=await tx.need('coordinator_events',uuid(id)),plan=event.plan_id?await tx.need('plans',event.plan_id):null;
    const source=event.source_message_id?await tx.get('messages',event.source_message_id):null;
    const tasks=(await tx.all('tasks')).filter(t=>plan?t.plan_id===plan.id:t.id===event.task_id).slice(0,20),result:Doc[]=[];
    for(const task of tasks){const evidence=await this.evidence(tx,task.id),textResult=typeof evidence.result_text==='string'?evidence.result_text.slice(0,8000):null;result.push({task:evidence.task,run:publicRun(evidence.run,textResult),result_text:textResult});}
    return{event:publicCoordinatorEvent(event),source_message:source?Object.fromEntries(['id','role','content','task_id','created_at'].map(k=>[k,source[k]])):null,plan:plan?{id:plan.id,summary:plan.summary??'',execution_status:plan.execution_status??'running'}:null,tasks:result};
  }
  async review(tx:Tx,p:Principal,id:string,body:Doc):Promise<Doc>{
    const task=await tx.need('tasks',uuid(id),true),run=await tx.need('runs',uuid(body.run_id),true);
    if(task.current_run_id!==run.id||run.task_id!==task.id||run.state!=='succeeded'||!['awaiting_review','succeeded'].includes(task.status))throw new ApiError(409,'delivery_not_reviewable','只可验收当前已结束且待核对的交付');
    const verdict=body.verdict;if(!['accept','reject','needs_input'].includes(verdict))throw new ApiError(422,'invalid_verdict','验收结论无效');
    const delivery=(await tx.all('task_deliveries')).find(d=>d.run_id===run.id)??await this.submit(tx,task,run),criteria=deliverables(delivery.deliverables);
    if(delivery.status==='accepted')throw new ApiError(409,'delivery_already_accepted','交付已经验收');
    if(!Array.isArray(body.checks)||body.checks.length>20)throw new ApiError(422,'invalid_review','需要逐条验收标准');
    const used=new Set<number>(),checks:Doc[]=[];const referenced:Doc[]=[];
    const steps=(await tx.all('steps')).filter(step=>step.run_id===run.id);
    for(const check of body.checks){
      const index=check.deliverable_index;
      if(!Number.isInteger(index)||index<0||index>=criteria.length||used.has(index)||typeof check.passed!=='boolean'||!Array.isArray(check.evidence_refs)||check.evidence_refs.length>50)throw new ApiError(422,'invalid_review','验收标准或证据无效');
      used.add(index);const refs:Doc[]=[];
      for(const ref of check.evidence_refs){
        if(!ref||!['artifact','step','checkpoint'].includes(ref.kind))throw new ApiError(422,'invalid_evidence','证据引用类型无效');
        const object=await tx.need(ref.kind==='artifact'?'artifacts':ref.kind==='step'?'steps':'checkpoints',uuid(ref.id));
        if(object.run_id!==run.id||(ref.kind!=='step'&&object.task_id!==task.id)||ref.kind==='artifact'&&(object.status!=='ready'||!delivery.artifact_ids.includes(object.id))||ref.kind==='checkpoint'&&(!object.checkpoint?.completed||object.id!==delivery.checkpoint_id))throw new ApiError(422,'invalid_evidence','证据不属于本次交付快照');
        if(ref.kind==='artifact')referenced.push(object);
        refs.push({kind:ref.kind,id:object.id});
      }
      if(verdict==='accept'&&(!check.passed||!refs.length))throw new ApiError(422,'acceptance_incomplete','每条交付标准都需通过并提供证据');
      checks.push({deliverable_index:index,passed:check.passed,evidence_refs:refs});
    }
    const corroborated=p.type==='device'&&(observationTools(steps)?referenced.some(isIndependentObservation):deviceEvidenceSatisfied(steps,referenced));
    if(verdict==='accept'&&(used.size!==criteria.length||p.type==='device'&&!corroborated))throw new ApiError(422,'acceptance_incomplete','验收需覆盖全部标准；自动审核还需可独立核对的冻结证据');
    const review=await tx.put('task_reviews',{task_id:task.id,run_id:run.id,delivery_id:delivery.id,verdict,summary:text(body.summary,'summary',10000),checks,reviewer_kind:p.type==='client'?'user':'coordinator',reviewer_id:p.id});
    await tx.put('task_deliveries',{...delivery,status:verdict==='accept'?'accepted':verdict==='reject'?'rejected':'needs_input',review_id:review.id});
    const updated=await tx.put('tasks',{...task,status:verdict==='accept'?'succeeded':'awaiting_review',delivery_status:verdict==='accept'?'accepted':verdict==='reject'?'rejected':'needs_input',reason_code:verdict==='accept'?null:verdict==='reject'?'delivery_rejected':'delivery_needs_input'});
    await tx.emit('task.reviewed',review,task.id,run.id);await tx.emit('task.changed',publicTask(updated),task.id,run.id);
    await emitTaskProgress(tx,updated,run,'review',verdict==='accept'?'accepted_delivery':verdict==='reject'?'failed':'waiting_input',verdict==='accept'?'交付已验收':verdict==='reject'?'交付未通过':'交付还需要补充',verdict==='accept'?null:'delivery_needs_input');
    if(verdict==='reject'){await this.event(tx,'delivery.rejected',updated,run,delivery.id,null,review.id);if(p.type==='client')await proposeUserCorrection(tx,updated,run,review.summary);}
    await this.refreshBlocked(tx);await this.settled(tx,task.plan_id??null);return review;
  }
  async dependencies(tx:Tx,task:Doc):Promise<Doc[]>{
    const result:Doc[]=[];for(const id of task.depends_on_task_ids??[]){const dep=await tx.need('tasks',id);if(dep.status!=='succeeded'||dep.delivery_status!=='accepted')throw new ApiError(409,'dependencies_pending','依赖尚未通过验收');const evidence=await this.evidence(tx,id);result.push({task_id:id,run_id:dep.current_run_id,delivery_id:evidence.delivery?.id??null,result_text:evidence.result_text,artifact_ids:evidence.artifacts.map((a:Doc)=>a.id)});}return result;
  }
  async allowedArtifactTasks(tx:Tx,taskId:string):Promise<Set<string>>{
    const allowed=new Set([taskId]),visit=async(id:string)=>{const task=await tx.need('tasks',id);for(const dependency of task.depends_on_task_ids??[]){if(allowed.has(dependency))continue;const dep=await tx.need('tasks',dependency);if(dep.status==='succeeded'&&dep.delivery_status==='accepted'){allowed.add(dependency);await visit(dependency);}}};await visit(taskId);return allowed;
  }
  async completeEvent(tx:Tx,id:string,body:Doc):Promise<Doc>{
    const event=await tx.need('coordinator_events',uuid(id),true),digest=hash(body);
    if(event.status==='completed'){if(event.completion_hash!==digest)throw new ApiError(409,'event_completion_conflict','事件已用另一结果完成');return{event:publicCoordinatorEvent(event),message:event.message_id?await tx.get('messages',event.message_id):null};}
    if(body.review_id){const review=await tx.need('task_reviews',uuid(body.review_id));if(review.task_id!==event.task_id||review.run_id!==event.run_id)throw new ApiError(422,'review_event_mismatch','验收与事件不匹配');}
    if(body.follow_up_plan_id){const plan=await tx.need('plans',uuid(body.follow_up_plan_id));if(plan.source_event_id!==event.id||!['awaiting_confirmation','committed'].includes(plan.state))throw new ApiError(422,'plan_event_mismatch','方案与事件不匹配');}
    if(!body.message&&!body.review_id&&!body.follow_up_plan_id)throw new ApiError(422,'event_result_required','需要汇总、验收或后续方案');
    const message=body.message?await tx.put('messages',{role:'assistant',content:text(body.message,'message',100000),task_id:event.task_id,source_event_id:event.id,plan_id:event.plan_id}):null;
    const saved=await tx.put('coordinator_events',{...event,status:'completed',completion_hash:digest,message_id:message?.id??null,review_id:body.review_id??null,follow_up_plan_id:body.follow_up_plan_id??null});
    if(message)await tx.emit('assistant.replied',message,event.task_id,event.run_id);return{event:publicCoordinatorEvent(saved),message};
  }
}
