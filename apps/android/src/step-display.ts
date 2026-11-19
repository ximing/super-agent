import type {ToolStep} from './types';
const titles:Record<string,string>={browser_navigate:'打开网页',browser_snapshot:'读取网页',browser_click:'点击页面',browser_fill:'填写页面',browser_keys:'发送页面按键',browser_screenshot:'截取网页',memory_search:'检索记忆',memory_read:'读取记忆',memory_propose:'整理候选记忆',files_list:'列出工作文件',files_read:'读取工作文件',files_write:'写入工作文件',artifacts_list:'查看任务附件',artifacts_download:'下载任务附件',artifacts_upload:'上传交付物',question_ask:'请求你的判断',shell_run:'执行本机命令',tasks_list:'查看任务列表',devices_list:'查看执行电脑',task_start:'准备任务计划',task_status:'读取任务状态'};
const statuses:Record<string,string>={running:'执行中',succeeded:'已完成',failed:'失败',cancelled:'已取消',result_unknown:'结果待核对'};
const errors:Record<string,string>={tool_failed:'工具未完成，请查看任务状态',invalid_arguments:'工具输入未通过校验',not_authorized:'当前任务未获授权',cancelled:'此步骤已取消',result_unknown:'执行结果尚未确认，请先核对业务回执'};
export const stepTimestamp=(step:ToolStep)=>{const value=Date.parse(step.started_at??step.created_at);return Number.isFinite(value)?value:0;};
const dateLabel=(value:string|null)=>{if(!value)return null;const date=new Date(value);return Number.isFinite(date.getTime())?date.toLocaleString('zh-CN'):null;};
/** Return fixed presentation labels only. Never render raw error/model text or tool arguments/results. */
export function stepPresentation(step:ToolStep){return{title:titles[step.tool]??'其他工具',status:statuses[step.status]??'状态待确认',error:step.error_code?(errors[step.error_code]??'工具结果需要进一步确认'):null,start:dateLabel(step.started_at??step.created_at),finish:dateLabel(step.completed_at)};}
