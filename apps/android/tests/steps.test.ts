import {test} from 'node:test';
import assert from 'node:assert/strict';
import {stepPresentation,stepTimestamp} from '../src/step-display';
import type {ToolStep} from '../src/types';
const fixture:ToolStep={id:'fixture-step',run_id:'fixture-run',tool:'memory_search',title:'private-fixture',status:'result_unknown',started_at:'2026-11-19T01:00:00Z',completed_at:'2026-11-19T01:00:01Z',error_code:'result_unknown',created_at:'2026-11-19T01:00:00Z',version:2};
test('step presentation renders fixed labels and preserves uncertain outcomes without raw tool payload',()=>{
  const view=stepPresentation({...fixture,arguments:{query:'private-fixture'},result:'private-fixture',error_message:'private-fixture'} as ToolStep);
  assert.equal(view.title,'检索记忆');assert.equal(view.status,'结果待核对');assert.match(view.error??'',/核对/);assert.ok(view.start);assert.ok(view.finish);assert.ok(!JSON.stringify(view).includes('private-fixture'));
  assert.ok(stepTimestamp({...fixture,started_at:'2026-11-19T01:00:03Z'})>stepTimestamp(fixture));
});
test('unknown tool/status/error fields and malformed dates never display arbitrary values',()=>{
  const view=stepPresentation({...fixture,tool:'private-fixture',status:'private-fixture',error_code:'private-fixture',started_at:'private-fixture',completed_at:'private-fixture'} as unknown as ToolStep);
  assert.equal(view.title,'其他工具');assert.equal(view.status,'状态待确认');assert.equal(view.start,null);assert.equal(view.finish,null);assert.ok(!JSON.stringify(view).includes('private-fixture'));
});
