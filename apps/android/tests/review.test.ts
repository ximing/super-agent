import {test} from 'node:test';
import assert from 'node:assert/strict';
import {canReview,reviewInput} from '../src/review-input';
import type {TaskEvidence} from '../src/types';
const fixture:TaskEvidence={task:{id:'task-fixture',title:'Review',goal:'Review',status:'awaiting_review',reason_code:null,engine:'codex',model_id:'fixture',device_id:'device-fixture',current_run_id:'run-fixture',created_at:'2026-11-19T01:00:00Z',updated_at:'2026-11-19T01:00:01Z',version:6},run:{id:'run-fixture',task_id:'task-fixture',state:'succeeded',engine:'codex',device_id:'device-fixture',model_id:'fixture',lease_epoch:'1',summary:'Execution finished',created_at:'2026-11-19T01:00:00Z'},delivery:{id:'delivery-fixture',run_id:'run-fixture',status:'pending',deliverables:['Report'],artifact_ids:[],version:1},deliverables:['Report'],checkpoint:{id:'checkpoint-fixture',created_at:'2026-11-19T01:00:01Z'},steps:[],artifacts:[]};
test('acceptance requires explicit human checks and real fetched evidence references',()=>{
  assert.throws(()=>reviewInput(fixture,'accept','Checked report',{}, {0:'checkpoint:checkpoint-fixture'}));assert.throws(()=>reviewInput(fixture,'accept','Checked report',{0:true},{0:'checkpoint:invented'}));
  const body=reviewInput(fixture,'accept','Checked report',{0:true},{0:'checkpoint:checkpoint-fixture'});assert.equal(body.run_id,'run-fixture');assert.deepEqual(body.checks,[{deliverable_index:0,passed:true,evidence_refs:[{kind:'checkpoint',id:'checkpoint-fixture'}]}]);
});
test('review refuses changed delivery/run/task and empty explanations',()=>{
  const changed={...fixture,task:{...fixture.task,status:'succeeded'}};assert.equal(canReview(changed),false);assert.throws(()=>reviewInput(changed,'accept','Checked',{0:true},{0:'checkpoint:checkpoint-fixture'}));assert.equal(canReview({...fixture,delivery:{...fixture.delivery!,run_id:'old-run'}}),false);assert.throws(()=>reviewInput(fixture,'reject',' ',{},{}));
});
