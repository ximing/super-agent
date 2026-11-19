import test from 'node:test';
import assert from 'node:assert/strict';
import { activeHold, admitReservation, buildReservation, categoryStop, dollarAdmission, evaluateLimits, grantBlocked, limitsFor, publicGrant, releaseReservation, remainingLimits, renewReservation, reservationExpired, usageByCategory } from '../src/budget-control.js';
import { BudgetGuard } from '../../node/src/budget-guard.js';

test('concurrent reservation replay does not hold the same run twice', () => {
  const request = { operation_key: 'reserve:run-1', run_id: 'run-1', amount: '1', status: 'reserved' };
  const first = admitReservation([], request);
  const second = admitReservation([first.reservation], { ...request, amount: '5' });
  assert.equal(first.created, true);
  assert.equal(second.created, false);
  assert.equal(second.reservation.amount, '1');
});

test('unknown money is not treated as zero and token limits stop the next controllable call', () => {
  const blocked = dollarAdmission({ monthly_limit_usd: '10', used_usd: '0', unknown_count: 2, task_limit_usd: null }, [], '1');
  assert.equal(blocked.ok, false);
  assert.equal(blocked.reason, 'budget_unknown');
  const open = dollarAdmission({ monthly_limit_usd: null, used_usd: '0', unknown_count: 4, task_limit_usd: null }, [], '0');
  assert.equal(open.ok, true);
  const limits = limitsFor('worker', { max_model_calls: 1, max_total_tokens: 10 });
  assert.equal(evaluateLimits(limits, { input_tokens: 0, output_tokens: 0, model_calls: 1, tool_steps: 0, started_at: Date.now() }).reason, 'model_call_limit');
  const guard = new BudgetGuard({ ...limits, max_model_calls: 5 });
  guard.beforeModelCall();
  assert.equal(guard.noteUsage({ request_key: 'one', input_tokens: 8, cached_input_tokens: null, output_tokens: 3, reasoning_tokens: null }), 'token_limit');
  assert.throws(() => guard.beforeToolCall(), /budget_stop:token_limit/);
  assert.throws(() => guard.beforeModelCall(), /budget_stop:token_limit/);
});

test('remaining limits subtract calls, tokens and tool steps but keep the activity runtime', () => {
  const limits = { max_total_tokens: 100, max_model_calls: 4, max_tool_steps: 7, max_runtime_ms: 180000 };
  const spent = { input_tokens: 40, output_tokens: 25, model_calls: 1, tool_steps: 3, started_at: 1 };
  assert.deepEqual(remainingLimits(limits, spent), { max_total_tokens: 35, max_model_calls: 3, max_tool_steps: 4, max_runtime_ms: 180000 });
  assert.deepEqual(remainingLimits(limits, { input_tokens: 80, output_tokens: 50, model_calls: 9, tool_steps: 20, started_at: 1 }), { max_total_tokens: 0, max_model_calls: 0, max_tool_steps: 0, max_runtime_ms: 180000 });
  assert.equal(grantBlocked({ ...limits, max_model_calls: 0, max_total_tokens: 0 }), 'model_call_limit');
  assert.equal(grantBlocked({ ...limits, max_model_calls: 2, max_total_tokens: 0, max_tool_steps: 0 }), 'token_limit');
  assert.equal(grantBlocked({ ...limits, max_runtime_ms: 0 }), null);
});

test('worker totals include subagent spend and review totals do not', () => {
  const call = (category: string) => ({ category, cost: { amount: '1' }, input_tokens: 10, output_tokens: 1 });
  const records = [call('worker'), call('worker'), call('subagent'), call('review')];
  assert.deepEqual(usageByCategory(records, 'review').map(record => record.category), ['review']);
  assert.deepEqual(usageByCategory(records, 'worker').map(record => record.category), ['worker', 'worker', 'subagent']);
  const workers = [call('worker'), call('worker'), call('subagent')];
  assert.equal(categoryStop(limitsFor('review', { max_model_calls: 1 }), usageByCategory(workers, 'review')), null);
  assert.equal(categoryStop(limitsFor('worker', { max_model_calls: 2 }), usageByCategory(workers, 'worker')), 'model_call_limit');
});

test('reservation renew stays reserved and a second release does not flip status', () => {
  const limits = limitsFor('review');
  const nowIso = '2026-11-19T00:00:00.000Z';
  const built = buildReservation({ operation_key: 'reserve:act-1', activity_kind: 'review', activity_id: 'act-1', task_id: 'task-1', run_id: 'run-1', category: 'review', limits, amount: null, expires_at: '2026-11-19T00:02:00.000Z', money_treatment: 'unknown' });
  assert.equal(built.amount, null);
  assert.equal(built.run_id, 'run-1');
  assert.notEqual(built.run_id, built.task_id);
  assert.equal(built.status, 'reserved');
  assert.equal(built.late_usage, false);
  assert.equal(buildReservation({ operation_key: 'reserve:act-1', activity_kind: 'review', activity_id: 'act-1', task_id: null, run_id: null, category: 'review', limits, amount: '0', expires_at: nowIso, money_treatment: 'unconfigured' }).amount, '0');
  const renewed = renewReservation({ ...built, id: 'grant-1' }, nowIso, 60000);
  assert.equal(renewed.status, 'reserved');
  assert.equal(renewed.expires_at, '2026-11-19T00:01:00.000Z');
  assert.equal(renewed.renewed_at, nowIso);
  assert.equal(renewed.heartbeat_at, nowIso);
  assert.equal(renewed.amount, null);
  assert.equal(renewed.limits, limits);
  assert.equal(reservationExpired(built, Date.parse('2026-11-19T00:02:00.000Z')), true);
  assert.equal(reservationExpired(renewed, Date.parse('2026-11-19T00:00:30.000Z')), false);
  const released = releaseReservation(renewed, 'released', nowIso);
  const again = releaseReservation(released, 'expired', '2026-11-19T00:05:00.000Z');
  assert.equal(again, released);
  assert.equal(again.status, 'released');
  assert.equal(again.released_at, nowIso);
  const grant = publicGrant(renewed);
  assert.equal(grant.grant_id, 'grant-1');
  assert.equal(grant.dollar_cap, 'not_enforced');
  assert.equal(grant.category, 'review');
  assert.equal(grant.activity_kind, 'review');
  assert.equal(grant.activity_id, 'act-1');
  assert.equal(grant.task_id, 'task-1');
  assert.equal(grant.run_id, 'run-1');
  assert.equal(grant.renewed_at, nowIso);
  assert.equal(grant.heartbeat_at, nowIso);
  const bare = publicGrant({ id: 'bare', status: 'reserved', expires_at: nowIso, limits, money_treatment: 'known' });
  assert.equal(bare.dollar_cap, 'not_enforced');
  assert.equal(Object.hasOwn(bare, 'activity_kind'), false);
  assert.equal(Object.hasOwn(bare, 'run_id'), false);
  assert.equal(Object.hasOwn(bare, 'renewed_at'), false);
});

test('a null reserved hold blocks dollar admission and a known hold still sums', () => {
  const unknown = { status: 'reserved', expires_at: '2099-01-01T00:00:00.000Z', amount: null, money_treatment: 'unknown' };
  const blocked = dollarAdmission({ monthly_limit_usd: '10', used_usd: '9', unknown_count: 0, task_limit_usd: null }, [unknown], '1');
  assert.equal(blocked.ok, false);
  assert.equal(blocked.reason, 'budget_unknown');
  assert.equal(activeHold([unknown]).toFixed(), '0');
  const missing = { status: 'reserved', expires_at: '2099-01-01T00:00:00.000Z', money_treatment: 'known' };
  assert.equal(dollarAdmission({ monthly_limit_usd: '10', used_usd: '0', unknown_count: 0, task_limit_usd: null }, [missing], '1').reason, 'budget_unknown');
  const tagged = { status: 'reserved', expires_at: '2099-01-01T00:00:00.000Z', amount: '1', money_treatment: 'unknown_not_zero' };
  assert.equal(dollarAdmission({ monthly_limit_usd: '10', used_usd: '0', unknown_count: 0, task_limit_usd: null }, [tagged], '1').reason, 'budget_unknown');
  const known = { status: 'reserved', expires_at: '2099-01-01T00:00:00.000Z', amount: '4', money_treatment: 'known' };
  assert.equal(activeHold([known, unknown]).toFixed(), '4');
  assert.equal(dollarAdmission({ monthly_limit_usd: '10', used_usd: '5', unknown_count: 0, task_limit_usd: null }, [known], '2').reason, 'budget_exhausted');
  assert.equal(dollarAdmission({ monthly_limit_usd: '10', used_usd: '5', unknown_count: 0, task_limit_usd: null }, [known], '1').ok, true);
  const explicitZero = { status: 'reserved', expires_at: '2099-01-01T00:00:00.000Z', amount: '0', money_treatment: 'unconfigured' };
  assert.equal(dollarAdmission({ monthly_limit_usd: '10', used_usd: '1', unknown_count: 0, task_limit_usd: null }, [explicitZero], '1').ok, true);
});

test('duplicate usage observation does not add a second model call by itself', () => {
  const guard = new BudgetGuard(limitsFor('review'));
  guard.beforeModelCall();
  guard.noteUsage({ request_key: 'same', input_tokens: 1, cached_input_tokens: null, output_tokens: 1, reasoning_tokens: null });
  guard.noteUsage({ request_key: 'same', input_tokens: 1, cached_input_tokens: null, output_tokens: 1, reasoning_tokens: null });
  assert.equal(guard.calls, 1);
  assert.equal(guard.inputTokens, 1);
});
