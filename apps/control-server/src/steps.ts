import type { ToolStep,ToolStepError,ToolStepStatus } from '@super-agent/protocol';
import { ApiError,hash,type Doc,type Tx } from './store.js';
import { uuid } from './auth.js';

const titles:Record<string,string>={browser_navigate:'打开网页',browser_snapshot:'读取网页',browser_click:'点击页面',browser_fill:'填写页面',browser_keys:'页面键盘操作',browser_screenshot:'采集画面',memory_search:'检索记忆',memory_read:'读取记忆',memory_propose:'提交记忆提案',files_list:'列出任务文件',files_read:'读取任务文件',files_write:'写入任务文件',shell_run:'运行任务命令',question_ask:'询问用户',artifacts_list:'列出任务附件',artifacts_download:'下载任务附件',artifacts_upload:'上传交付文件',devices_list:'查看执行电脑',tasks_list:'查看任务',task_start:'规划任务',task_status:'查看任务状态',other:'执行工具'};
const statuses=new Set<ToolStepStatus>(['running','succeeded','failed','cancelled','result_unknown']);
const errors=new Set<ToolStepError>(['tool_failed','invalid_arguments','not_authorized','cancelled','result_unknown']);
function timestamp(value:unknown,label:string):string{
  if(typeof value!=='string'||value.length>80||!Number.isFinite(Date.parse(value)))throw new ApiError(422,'invalid_step_time',`${label}时间无效`);
  return new Date(value).toISOString();
}
function safeError(status:ToolStepStatus,error:unknown):ToolStepError|null{
  if(status==='running'||status==='succeeded')return null;
  if(status==='result_unknown'||status==='cancelled')return status;
  return errors.has(error as ToolStepError)?error as ToolStepError:'tool_failed';
}
/** Also protects old stored records/events that predate the public DTO. */
export function publicStep(raw:Doc):ToolStep{
  const tool=typeof raw.tool==='string'&&Object.hasOwn(titles,raw.tool)?raw.tool:'other';
  const status=statuses.has(raw.status)?raw.status as ToolStepStatus:'result_unknown';
  const safeTime=(value:unknown):string|null=>typeof value==='string'&&Number.isFinite(Date.parse(value))?new Date(value).toISOString():null;
  const created=safeTime(raw.created_at)??'1970-01-01T00:00:00.000Z',start=safeTime(raw.started_at)??created;
  return{id:raw.id,run_id:raw.run_id,tool,title:titles[tool]!,status,started_at:start,completed_at:status==='running'?null:safeTime(raw.completed_at)??safeTime(raw.updated_at)??created,error_code:safeError(status,raw.error_code),created_at:created,version:Number.isSafeInteger(raw.version)&&raw.version>0?raw.version:1};
}
export async function storeStep(tx:Tx,run:Doc,payload:Doc):Promise<ToolStep>{
  const id=uuid(payload.step_id,'step_id'),old=await tx.get('steps',id,true);
  if(old&&old.run_id!==run.id)throw new ApiError(404,'not_found','工具步骤不存在');
  if(!statuses.has(payload.status))throw new ApiError(422,'invalid_step_status','工具状态无效');
  const started=timestamp(payload.started_at,'开始'),completed=payload.status==='running'?null:timestamp(payload.completed_at,'结束');
  if(completed&&Date.parse(completed)<Date.parse(started))throw new ApiError(422,'invalid_step_time','结束时间不能早于开始时间');
  const tool=typeof payload.tool==='string'&&Object.hasOwn(titles,payload.tool)?payload.tool:'other';
  const normalized={run_id:run.id,tool,title:titles[tool],status:payload.status,started_at:started,completed_at:completed,error_code:safeError(payload.status,payload.error_code)};
  if(old){
    if(old.tool!==tool||old.started_at!==started)throw new ApiError(409,'step_identity_conflict','步骤工具或开始时间不能改变');
    const previous=Object.fromEntries(Object.keys(normalized).map(key=>[key,old[key]]));
    if(hash(previous)===hash(normalized))return publicStep(old);
    if(old.status!=='running')throw new ApiError(409,'step_finalized','已结束的步骤不能恢复执行或覆盖结果');
  }
  const saved=publicStep(await tx.put('steps',normalized,id));
  await tx.emit('step.updated',saved,run.task_id,run.id);return saved;
}
export function publicEvent(event:Doc):Doc{return['step.updated','tool.receipt'].includes(event.type)?{...event,payload:publicStep(event.payload??{})}:event;}
