import { ApiError,hash,type Doc,type Tx } from './store.js';

/** Caller must first validate the device, run ticket, epoch and lease. */
export async function storeCheckpoint(tx:Tx,run:Doc,checkpoint:unknown):Promise<{id:string}>{
  if(!checkpoint||typeof checkpoint!=='object'||Array.isArray(checkpoint))throw new ApiError(422,'invalid_checkpoint','检查点无效');
  const digest=hash(checkpoint),records=(await tx.all('checkpoints')).filter(c=>c.run_id===run.id&&c.task_id===run.task_id);
  const delivery=(await tx.all('task_deliveries')).find(d=>d.run_id===run.id);
  const completed=delivery?records.find(c=>c.id===delivery.checkpoint_id):records.find(c=>c.checkpoint?.completed===true);
  if(completed){
    if(hash(completed.checkpoint)===digest)return{id:completed.id};
    throw new ApiError(409,'checkpoint_frozen','已完成检查点不可替换；请通过新运行修正交付');
  }
  if(delivery)throw new ApiError(409,'delivery_frozen','已提交交付的证据不可追加或替换');
  if(!['starting','running','waiting_input','stopping'].includes(run.state))throw new ApiError(409,'checkpoint_run_inactive','只可为当前有效运行保存检查点');
  const task=await tx.need('tasks',run.task_id,true);
  if(task.current_run_id!==run.id)throw new ApiError(409,'checkpoint_run_superseded','该执行已被替换');
  const duplicate=records.find(c=>hash(c.checkpoint)===digest);if(duplicate)return{id:duplicate.id};
  const saved=await tx.put('checkpoints',{run_id:run.id,task_id:run.task_id,checkpoint,checkpoint_hash:digest});
  await tx.put('tasks',{...task,checkpoint_id:saved.id});await tx.emit('checkpoint.created',{id:saved.id},run.task_id,run.id);return{id:saved.id};
}
