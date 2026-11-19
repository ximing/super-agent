import {test} from 'node:test';
import assert from 'node:assert/strict';
import {categoryLimitsMerge, executionSettingsBody, memoryBindingBody, memoryScopePayload, memorySettingsConflictMessage, observationRuleBody, presentCostReservation, relationConflictMessage, taskBudgetMerge, type BudgetKey} from '../src/payloads';

const keys: BudgetKey[] = ['max_total_tokens', 'max_model_calls', 'max_tool_steps', 'max_runtime_ms'];

test('each stop reason merges only its own budget key', () => {
  const cases: {reason: string; key: BudgetKey; value: number}[] = [
    {reason: 'token_limit', key: 'max_total_tokens', value: 100},
    {reason: 'model_call_limit', key: 'max_model_calls', value: 80},
    {reason: 'tool_step_limit', key: 'max_tool_steps', value: 40},
    {reason: 'time_limit', key: 'max_runtime_ms', value: 3_600_000},
  ];
  for (const item of cases) {
    const body = taskBudgetMerge(item.reason, item.value);
    assert.equal(body.mode, 'merge');
    assert.deepEqual(Object.keys(body.limits), [item.key]);
    assert.equal(body.limits[item.key], item.value);
    for (const other of keys) if (other !== item.key) assert.equal(body.limits[other], undefined);
    assert.equal(JSON.stringify(body).includes('monthly_limit_usd'), false);
  }
  assert.equal(taskBudgetMerge('token_limit', 100).limits.max_model_calls, undefined);
  assert.equal(taskBudgetMerge('time_limit', 3_600_000).limits.max_total_tokens, undefined);
});

test('empty sites stay an array and global preference false is explicit', () => {
  const scope = memoryScopePayload({project: '  ', sites: '  ， ', globalPreference: false, statuses: '', maxVersion: ''});
  assert.deepEqual(scope, {project: null, sites: [], global_preference: false, statuses: ['verified'], max_version: null});
  assert.equal(Object.prototype.hasOwnProperty.call(scope, 'sites'), true);
  assert.equal(Object.prototype.hasOwnProperty.call(scope, 'global_preference'), true);
  assert.notEqual(scope.global_preference, undefined);
  assert.equal(scope.sites.length, 0);
});

test('observation rules keep the site ceiling and reject a page outside it', () => {
  const task = observationRuleBody({title: '验收后', goal: '整理差异', deviceId: 'device-1', engine: 'grok', sites: 'A.Example', project: 'alpha', cooldownMinutes: 30, source: 'task_result', taskId: 'task-1', match: 'status', value: 'awaiting_review'});
  assert.deepEqual(task.sites, ['a.example']);
  assert.equal(task.project, 'alpha');
  assert.equal(task.global_preference, undefined);
  assert.throws(() => observationRuleBody({title: '越权', goal: '看别的站', deviceId: 'device-1', engine: 'grok', sites: 'a.example', project: '', cooldownMinutes: 15, source: 'page', url: 'https://b.example/item', condition: '变化'}), /授权网站/);
});

test('409 relation conflict tells the user to reload instead of repeating the version', () => {
  assert.equal(relationConflictMessage(409, 'version_conflict'), '记忆关系已变化，请刷新后重试。不会用旧版本重复提交。');
  assert.equal(relationConflictMessage(500, 'version_conflict'), null);
  assert.equal(relationConflictMessage(409, 'message_conflict'), null);
});

test('cost summary helper does not coerce null reserved or unknown into zero', () => {
  for (const summary of [{}, {reserved_hold_usd: null, reserved_unknown_count: null, unknown_count: null}]) {
    const view = presentCostReservation(summary);
    assert.equal(view.reserved_hold_usd, null);
    assert.equal(view.reserved_unknown_count, null);
    assert.equal(view.unknown_count, null);
    assert.notEqual(view.reserved_hold_usd, 0);
    assert.notEqual(view.reserved_unknown_count, 0);
    assert.notEqual(view.unknown_count, 0);
    assert.equal(view.hold_label.includes('免费'), false);
    assert.equal(view.hold_label.includes('0'), false);
    assert.equal(view.reserved_unknown_label.includes('0'), false);
    assert.equal(view.unknown_label.includes('0'), false);
    assert.equal(JSON.stringify({reserved_hold_usd: view.reserved_hold_usd, reserved_unknown_count: view.reserved_unknown_count, unknown_count: view.unknown_count}).includes('0'), false);
  }
});

test('memory binding keeps the current project, can clear it, and can replace it without dropping the token', () => {
  const kept = memoryBindingBody({url: 'https://recall.example', token: 'updated-token', project: 'alpha'});
  assert.deepEqual(kept, {url: 'https://recall.example', token: 'updated-token', project: 'alpha'});
  assert.equal(Object.prototype.hasOwnProperty.call(kept, 'project'), true);
  assert.equal(Object.prototype.hasOwnProperty.call(kept, 'token'), true);
  assert.equal(JSON.stringify(kept).includes('"token":"updated-token"'), true);

  const cleared = memoryBindingBody({url: 'https://recall.example', token: 'updated-token', project: '  '});
  assert.equal(cleared.token, 'updated-token');
  assert.equal(cleared.project, null);
  assert.equal(Object.prototype.hasOwnProperty.call(cleared, 'project'), true);
  assert.equal(JSON.stringify(cleared).includes('"project":null'), true);
  assert.equal(JSON.stringify(cleared).includes('"token"'), true);

  const changed = memoryBindingBody({url: 'https://recall.example', token: 'updated-token', project: ' beta '});
  assert.equal(changed.project, 'beta');
  assert.equal(changed.token, 'updated-token');
  assert.equal(Object.prototype.hasOwnProperty.call(changed, 'project'), true);
});

test('wrong memory If-Match stays a 412 conflict and asks for a refresh', () => {
  assert.equal(memorySettingsConflictMessage(412, 'version_conflict'), '记忆连接已变化，请刷新后重试。');
  assert.equal(memorySettingsConflictMessage(409, 'version_conflict'), null);
  assert.equal(memorySettingsConflictMessage(412, 'recall_account_change_requires_review'), null);
});

test('turning global read off sends false and category merge omits money', () => {
  const settings = executionSettingsBody({engine: 'codex', device: '', assistant: 'mac', memoryGlobalRead: false});
  assert.equal(settings.memory_global_read, false);
  assert.equal(Object.prototype.hasOwnProperty.call(settings, 'memory_global_read'), true);
  assert.equal(settings.default_device_id, null);
  const categories = categoryLimitsMerge({worker: {max_model_calls: '20', max_total_tokens: ''}});
  assert.equal(categories.mode, 'merge');
  assert.deepEqual(categories.category_limits, {worker: {max_model_calls: 20}});
  assert.equal('monthly_limit_usd' in categories, false);
  assert.equal('task_limit_usd' in categories, false);
});
