import {test} from 'node:test';
import assert from 'node:assert/strict';
import type {AgentTask} from '../src/types';
import {planItemScopeLine,taskTree,taskRelations} from '../src/task-graph';
const task=(id:string,extra:Partial<AgentTask>={}):AgentTask=>({id,title:id,goal:id,status:'blocked',reason_code:null,engine:'codex',model_id:null,device_id:null,current_run_id:null,created_at:'2026-11-19T01:00:00Z',updated_at:'2026-11-19T01:00:00Z',version:1,...extra});
test('execution dependencies stay separate from parent tree and unloaded relations remain explicit',()=>{
 const a=task('a'),b=task('b',{parent_task_id:'a'}),c=task('c',{depends_on_task_ids:['a','not-loaded']}),orphan=task('orphan',{parent_task_id:'missing'});const rows=taskTree([c,b,a,orphan]);assert.equal(rows.length,4);assert.equal(rows.find(row=>row.task.id==='c')?.depth,0);assert.equal(rows.find(row=>row.task.id==='b')?.depth,1);assert.equal(rows.find(row=>row.task.id==='orphan')?.parentUnavailable,true);const related=taskRelations(c,[a,b,c,orphan]);assert.equal(related.ancestors.length,0);assert.equal(related.dependencies.length,2);assert.equal(related.dependencies.find(dep=>dep.id==='not-loaded')?.task,undefined);
});
test('plan item scope keeps project, sites, and global preference visible',()=>{
  const line=planItemScopeLine({project:'alpha',sites:['example.com'],global_preference:false});
  assert.equal(line,'记忆范围：项目 alpha · 网站 example.com · 全局偏好 关');
  const cleared=planItemScopeLine({project:'  ',sites:[],global_preference:false});
  assert.equal(cleared,'记忆范围：项目 未指定 · 网站 无 · 全局偏好 关');
  assert.equal(planItemScopeLine(null),null);
  assert.equal(planItemScopeLine(undefined),null);
});
test('cycle and deep tree rendering terminates and does not pretend a loaded subset is the complete plan',()=>{
 const a=task('a',{parent_task_id:'b'}),b=task('b',{parent_task_id:'a'});assert.equal(taskTree([a,b]).length,2);assert.equal(taskRelations(a,[a,b]).incompleteAncestors,true);const chain=Array.from({length:12},(_,i)=>task(`n${i}`,{parent_task_id:i?`n${i-1}`:null}));const rows=taskTree(chain);assert.equal(rows.length,12);assert.ok(rows.every(row=>row.depth<=3));assert.equal(rows.at(-1)?.relationUncertain,true);
});
