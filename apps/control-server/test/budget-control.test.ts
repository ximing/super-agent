import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { BUDGET_HEARTBEAT_MS, canonicalActivityId } from '@super-agent/protocol';
import { activeHold, admitReservation, buildReservation, categoryStop, dollarAdmission, evaluateLimits, grantBlocked, limitsFor, publicGrant, releaseReservation, remainingLimits, renewReservation, reservationExpired, reservationInForce, settleReservation, usageByCategory } from '../src/budget-control.js';
import { configuredLimits, mergeLimitOverride, nextAccountBudget, taskBudgetUpdate, usageStop } from '../src/budget-policy.js';
import { ApiError, type Doc, type Tx } from '../src/store.js';
import { Auth } from '../src/auth.js';
import { Service, assistantUsageActivity, conflictingMessage, eventUsageActivity, workerUsageActivity } from '../src/service.js';
import { BudgetGuard } from '../../node/src/budget-guard.js';

function memoryTx(): Tx {
  const tables = new Map<string, Map<string, Doc>>();
  const table = (name: string) => { if (!tables.has(name)) tables.set(name, new Map()); return tables.get(name)!; };
  const put = async (name: string, doc: Doc, id: string = doc.id ?? randomUUID()) => {
    const value = { ...doc, id, version: (table(name).get(id)?.version ?? 0) + 1, created_at: table(name).get(id)?.created_at ?? new Date().toISOString(), updated_at: new Date().toISOString() };
    table(name).set(id, value);
    return value;
  };
  return { tenant: randomUUID(), client: { query: async () => ({ rows: [] }) }, get: async (name: string, id: string) => table(name).get(id) ?? null, all: async (name: string) => [...table(name).values()], need: async (name: string, id: string) => { const value = table(name).get(id); if (!value) throw new ApiError(404, 'not_found', '资源不存在'); return value; }, remove: async (name: string, id: string) => { table(name).delete(id); }, put, emit: async () => {} } as unknown as Tx;
}
function knownCost(amount = '0.02') { return { source: 'supplier_reported', amount, currency: 'USD' }; }

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

test('an expired run hold stays in force and an assistant lease does not protect a stale heartbeat', () => {
  const now = Date.parse('2026-11-19T00:00:00.000Z');
  const expiredRun = { status: 'reserved', expires_at: '2026-11-18T00:00:00.000Z', amount: '4', money_treatment: 'known', activity_kind: 'run', run_id: 'run-1' };
  const live = { activeRunIds: new Set(['run-1']), now };
  assert.equal(reservationInForce(expiredRun, live), true);
  assert.equal(reservationInForce(expiredRun, { activeRunIds: new Set(), now }), false);
  assert.equal(reservationInForce({ ...expiredRun, activity_kind: undefined }, live), true);
  assert.equal(dollarAdmission({ monthly_limit_usd: '10', used_usd: '7', unknown_count: 0, task_limit_usd: null }, [expiredRun], '1', now, live.activeRunIds).reason, 'budget_exhausted');
  assert.equal(activeHold([expiredRun], now, live.activeRunIds).toFixed(), '4');
  const unknown = { ...expiredRun, amount: null, money_treatment: 'unknown' };
  assert.equal(dollarAdmission({ monthly_limit_usd: '10', used_usd: '0', unknown_count: 0, task_limit_usd: null }, [unknown], '1', now, live.activeRunIds).reason, 'budget_unknown');
  assert.equal(activeHold([unknown], now, live.activeRunIds).toFixed(), '0');
  const fresh = { status: 'reserved', expires_at: '2026-11-18T00:00:00.000Z', amount: '1', money_treatment: 'known', activity_kind: 'assistant', heartbeat_at: new Date(now - BUDGET_HEARTBEAT_MS).toISOString() };
  const stale = { ...fresh, heartbeat_at: new Date(now - BUDGET_HEARTBEAT_MS - 1).toISOString() };
  assert.equal(reservationInForce(fresh, { activeRunIds: new Set(['run-1']), now }), true);
  assert.equal(reservationInForce(stale, { activeRunIds: new Set(['run-1']), now }), false);
  assert.equal(reservationInForce({ ...stale, activity_kind: 'review', run_id: 'run-1' }, live), false);
  const settled = settleReservation({ ...expiredRun, amount: '4' }, [{ cost: { amount: null } }], '2026-11-19T00:00:00.000Z', 'close');
  assert.equal(settled.status, 'released');
  assert.equal(settled.settlement_state, 'unknown');
  assert.equal(settled.amount, '4');
  const known = settleReservation(expiredRun, [{ cost: { amount: '0.01' } }], '2026-11-19T00:00:00.000Z', 'close');
  assert.equal(known.status, 'settled');
  assert.equal(known.amount, '4');
  assert.equal(settleReservation(known, [], '2026-11-19T00:01:00.000Z', 'expire'), known);
  const orphan = settleReservation(expiredRun, [{ cost: { amount: '9' } }], '2026-11-19T00:00:00.000Z', 'expire');
  assert.equal(orphan.status, 'expired');
  assert.equal(orphan.settlement_state, 'open');
  assert.equal(orphan.amount, '4');
});

test('merged task and account limits keep omitted keys and block one dimension at a time', () => {
  const stored = { max_total_tokens: 100, max_model_calls: 2, max_tool_steps: 3, max_runtime_ms: 1000 };
  const flat = taskBudgetUpdate({ max_model_calls: 4, version: 2 });
  assert.equal(flat.mode, 'merge');
  assert.deepEqual(mergeLimitOverride(stored, flat.patch, flat.mode), { max_total_tokens: 100, max_model_calls: 4, max_tool_steps: 3, max_runtime_ms: 1000 });
  const replaced = taskBudgetUpdate({ mode: 'replace', limits: { max_runtime_ms: 5000 } });
  assert.deepEqual(mergeLimitOverride(stored, replaced.patch, replaced.mode), { max_runtime_ms: 5000 });
  const cleared = mergeLimitOverride(stored, { max_model_calls: null }, 'merge');
  assert.deepEqual(cleared, { max_total_tokens: 100, max_tool_steps: 3, max_runtime_ms: 1000 });
  assert.equal(mergeLimitOverride(stored, { max_total_tokens: null, max_model_calls: null, max_tool_steps: null, max_runtime_ms: null }, 'replace'), null);
  const ceiling = configuredLimits('worker', [mergeLimitOverride(stored, { max_model_calls: 4 }, 'merge')]);
  const spent = { input_tokens: 1, output_tokens: 1, model_calls: 0, tool_steps: 0, started_at: 1 };
  assert.equal(usageStop(ceiling, { ...spent, model_calls: 4 }), 'model_call_limit');
  assert.equal(usageStop(ceiling, { ...spent, input_tokens: 80, output_tokens: 20, model_calls: 1 }), 'token_limit');
  assert.equal(usageStop(ceiling, { ...spent, model_calls: 1, tool_steps: 3 }), 'tool_step_limit');
  const raised = mergeLimitOverride(stored, taskBudgetUpdate({ max_runtime_ms: 5000 }).patch, 'merge')!;
  assert.equal(raised.max_total_tokens, 100);
  assert.equal(raised.max_model_calls, 2);
  assert.equal(raised.max_tool_steps, 3);
  const limits = remainingLimits(configuredLimits('worker', [raised]), { input_tokens: 40, output_tokens: 10, model_calls: 1, tool_steps: 1, started_at: 1 });
  assert.deepEqual(limits, { max_total_tokens: 50, max_model_calls: 1, max_tool_steps: 2, max_runtime_ms: 5000 });
  assert.equal(evaluateLimits(limits, { input_tokens: 0, output_tokens: 0, model_calls: 0, tool_steps: 0, started_at: 0 }, 5000).reason, 'time_limit');
  const account = { monthly_limit_usd: '10', task_limit_usd: '2', category_limits: { worker: { max_model_calls: 3, max_total_tokens: 50 }, review: { max_tool_steps: 4 } } };
  assert.deepEqual(nextAccountBudget(account, { category_limits: { worker: { max_model_calls: 8 } } }), { monthly_limit_usd: '10', task_limit_usd: '2', category_limits: { worker: { max_model_calls: 8, max_total_tokens: 50 }, review: { max_tool_steps: 4 } } });
  assert.deepEqual(nextAccountBudget(account, { monthly_limit_usd: '15' }), { monthly_limit_usd: '15', task_limit_usd: '2', category_limits: account.category_limits });
  assert.deepEqual(nextAccountBudget(account, { monthly_limit_usd: null }), { monthly_limit_usd: null, task_limit_usd: '2', category_limits: account.category_limits });
  assert.equal(nextAccountBudget(account, { category_limits: null }).category_limits, undefined);
  assert.deepEqual(nextAccountBudget(account, { mode: 'replace', category_limits: { worker: { max_model_calls: 9 } } }).category_limits, { worker: { max_model_calls: 9 } });
});

test('usage links only by activity id and terminal closes settle the worker hold', async () => {
  const tx = memoryTx();
  const service = new Service({} as never, {} as Auth);
  const taskId = randomUUID(), runId = randomUUID(), deliveryId = randomUUID(), messageId = randomUUID();
  const runActivity = canonicalActivityId('run', runId);
  const reviewActivity = canonicalActivityId('review', deliveryId);
  const message = { id: messageId, schedule_id: randomUUID(), task_id: null };
  const proactiveActivity = canonicalActivityId('proactive', messageId);
  const run = { id: runId, task_id: taskId, device_id: randomUUID(), engine: 'codex', model_id: 'fixture', state: 'running', lease_epoch: '1', lease_expires_at: new Date(Date.now() + 60000).toISOString(), summary: '', current_run_id: runId };
  const task = { id: taskId, goal: '核对', title: '核对', status: 'running', current_run_id: runId, delivery_status: 'not_submitted', scope: {} };
  await tx.put('tasks', task, taskId);
  await tx.put('runs', run, runId);
  const worker = await tx.put('budget_reservations', { operation_key: runActivity, activity_kind: 'run', activity_id: runActivity, run_id: runId, task_id: taskId, category: 'worker', status: 'reserved', amount: '3', money_treatment: 'known', expires_at: '2026-11-19T00:02:00.000Z' });
  const review = await tx.put('budget_reservations', { operation_key: reviewActivity, activity_kind: 'review', activity_id: reviewActivity, run_id: runId, task_id: taskId, category: 'review', status: 'reserved', amount: '2', money_treatment: 'known', expires_at: '2026-11-19T00:02:00.000Z' });
  await tx.put('budget_reservations', { operation_key: proactiveActivity, activity_kind: 'proactive', activity_id: proactiveActivity, run_id: null, category: 'proactive', status: 'reserved', amount: null, money_treatment: 'unknown', expires_at: '2026-11-19T00:02:00.000Z' });
  const workerPayload = { request_key: 'worker-1', usage_revision: 1, engine: 'codex', model_id: 'fixture', category: 'worker', input_tokens: 10, output_tokens: 2, cost: knownCost() };
  await service.usage(tx, workerUsageActivity(run, workerPayload), workerPayload);
  const reviewPayload = { request_key: 'review-1', usage_revision: 1, engine: 'codex', model_id: 'fixture', category: 'review', activity_id: reviewActivity, input_tokens: 4, output_tokens: 1, cost: knownCost('0.01') };
  const event = { id: randomUUID(), type: 'delivery.submitted', delivery_id: deliveryId, task_id: taskId, run_id: runId };
  await service.usage(tx, eventUsageActivity(event, run.device_id, 'codex', 'fixture', reviewPayload), reviewPayload);
  const proactivePayload = { request_key: 'proactive-1', usage_revision: 1, engine: 'grok', model_id: 'grok-2', input_tokens: 3, output_tokens: 1, cost: knownCost('0.03'), occurred_at: '2026-11-19T00:00:00.000Z' };
  const proactiveContext = assistantUsageActivity(message, randomUUID(), 'grok', 'grok-2', proactivePayload);
  await service.usage(tx, proactiveContext, proactivePayload);
  await service.usage(tx, proactiveContext, proactivePayload);
  const rows = await tx.all('usage_records');
  assert.equal(rows.length, 3);
  assert.equal(rows.filter(row => row.activity_id === runActivity && row.category === 'worker' && row.run_id === runId).length, 1);
  assert.equal(rows.filter(row => row.activity_id === reviewActivity && row.category === 'review' && row.run_id === null).length, 1);
  const proactive = rows.find(row => row.activity_id === proactiveActivity);
  assert.equal(proactive?.category, 'proactive');
  assert.equal(proactive?.run_id, null);
  const revised = { ...proactivePayload, usage_revision: 2, input_tokens: 9 };
  await service.usage(tx, assistantUsageActivity(message, proactiveContext.device_id, 'grok', 'grok-2', revised), revised);
  const afterRevision = (await tx.all('usage_records')).filter(row => row.activity_id === proactiveActivity);
  assert.equal(afterRevision.length, 1);
  assert.equal(afterRevision[0].usage_revision, 2);
  assert.equal(afterRevision[0].category, 'proactive');
  assert.equal(afterRevision[0].occurred_at, '2026-11-19T00:00:00.000Z');
  await assert.rejects(() => service.usage(tx, assistantUsageActivity(message, proactiveContext.device_id, 'grok', 'grok-2', revised), { ...revised, input_tokens: 1 }), (error: unknown) => error instanceof ApiError && error.status === 409);
  assert.equal((await tx.all('usage_records')).filter(row => row.activity_id === proactiveActivity).length, 1);
  const reviewBefore = review.expires_at;
  await service.heartbeatRun(tx, runId);
  const heartWorker = (await tx.all('budget_reservations')).find(row => row.id === worker.id);
  const heartReview = (await tx.all('budget_reservations')).find(row => row.id === review.id);
  assert.notEqual(heartWorker?.expires_at, worker.expires_at);
  assert.equal(heartReview?.expires_at, reviewBefore);
  assert.equal(heartReview?.status, 'reserved');
  await service.releaseBudget(tx, runId);
  const closedWorker = (await tx.all('budget_reservations')).find(row => row.id === worker.id);
  const stillReview = (await tx.all('budget_reservations')).find(row => row.id === review.id);
  assert.equal(closedWorker?.status, 'settled');
  assert.equal(closedWorker?.settlement_state, 'settled');
  assert.equal(closedWorker?.amount, '3');
  assert.equal(stillReview?.status, 'reserved');
  assert.equal(stillReview?.amount, '2');
  const latePayload = { ...reviewPayload, request_key: 'review-late', input_tokens: 8 };
  await service.releaseActivity(tx, reviewActivity);
  await service.usage(tx, eventUsageActivity(event, run.device_id, 'codex', 'fixture', latePayload), latePayload);
  const lateReview = (await tx.all('budget_reservations')).find(row => row.id === review.id);
  const untouchedWorker = (await tx.all('budget_reservations')).find(row => row.id === worker.id);
  assert.equal(lateReview?.late_usage, true);
  assert.ok(lateReview?.late_usage_at);
  assert.equal(lateReview?.amount, '2');
  assert.equal(lateReview?.status, 'settled');
  assert.ok(!untouchedWorker?.late_usage);
  assert.equal((await tx.all('usage_records')).filter(row => row.activity_id === reviewActivity).length, 2);
  const unknownId = canonicalActivityId('assistant', randomUUID());
  const unknownHold = await tx.put('budget_reservations', { operation_key: unknownId, activity_kind: 'assistant', activity_id: unknownId, status: 'reserved', amount: '5', money_treatment: 'known', expires_at: '2026-11-19T00:02:00.000Z' });
  const unknownPayload = { request_key: 'unknown-1', usage_revision: 1, engine: 'grok', model_id: 'grok-2', input_tokens: 1, output_tokens: 1, cost: { source: 'unavailable', amount: null, currency: null } };
  await service.usage(tx, { activity_id: unknownId, category: 'assistant', run_id: null, task_id: null, device_id: run.device_id, engine: 'grok', model_id: 'grok-2' }, unknownPayload);
  await service.releaseActivity(tx, unknownId);
  const unknownClosed = (await tx.all('budget_reservations')).find(row => row.id === unknownHold.id);
  assert.equal(unknownClosed?.status, 'released');
  assert.equal(unknownClosed?.settlement_state, 'unknown');
  assert.equal(unknownClosed?.amount, '5');
  assert.notEqual(unknownClosed?.amount, '0');
  for (const state of ['succeeded', 'failed', 'cancelled'] as const) {
    const id = randomUUID(), activity = canonicalActivityId('run', id);
    const owned = { ...run, id, task_id: randomUUID(), state: 'running' };
    await tx.put('tasks', { ...task, id: owned.task_id, current_run_id: id }, owned.task_id);
    await tx.put('runs', owned, id);
    const hold = await tx.put('budget_reservations', { operation_key: activity, activity_kind: 'run', activity_id: activity, run_id: id, status: 'reserved', amount: '3', money_treatment: 'known', expires_at: '2026-11-19T00:02:00.000Z' });
    const payload = { ...workerPayload, request_key: `close-${state}` };
    await service.usage(tx, workerUsageActivity(owned, payload), payload);
    const before = (await tx.all('usage_records')).filter(row => row.activity_id === activity).length;
    await service.runState(tx, owned, { state, summary: state });
    const closed = (await tx.all('budget_reservations')).find(row => row.id === hold.id);
    assert.equal(closed?.status, 'settled', state);
    assert.equal(closed?.amount, '3', state);
    assert.equal((await tx.all('usage_records')).filter(row => row.activity_id === activity).length, before, state);
  }
  assert.throws(() => workerUsageActivity(run, { ...workerPayload, category: 'review' }), (error: unknown) => error instanceof ApiError && error.status === 422);
  assert.equal(conflictingMessage({ content: '确认', memory_scope: { sites: ['a.example'] } }, '确认', { sites: ['b.example'] }), true);
  assert.equal(conflictingMessage({ content: '确认' }, '确认', null), false);
});

test('assistant heartbeat renews one reserved activity and does not create a hold', async () => {
  const tx = memoryTx();
  const service = new Service({} as never, {} as Auth);
  const activityId = canonicalActivityId('assistant', randomUUID());
  const otherId = canonicalActivityId('review', randomUUID());
  const row = await tx.put('budget_reservations', { operation_key: activityId, activity_kind: 'assistant', activity_id: activityId, status: 'reserved', amount: null, money_treatment: 'unknown', expires_at: '2020-01-01T00:00:00.000Z' });
  await tx.put('budget_reservations', { operation_key: otherId, activity_kind: 'review', activity_id: otherId, status: 'reserved', amount: '1', money_treatment: 'known', expires_at: '2020-01-01T00:00:00.000Z' });
  const grant = await service.heartbeatActivity(tx, activityId);
  assert.equal(grant.activity_id, activityId);
  assert.equal(grant.dollar_cap, 'not_enforced');
  assert.equal((await tx.all('budget_reservations')).length, 2);
  const saved = (await tx.all('budget_reservations')).find(item => item.id === row.id);
  const other = (await tx.all('budget_reservations')).find(item => item.activity_id === otherId);
  assert.equal(saved?.amount, null);
  assert.ok(Date.parse(saved?.expires_at) > Date.now());
  assert.equal(saved?.heartbeat_at, saved?.renewed_at);
  assert.equal(other?.expires_at, '2020-01-01T00:00:00.000Z');
  await assert.rejects(() => service.heartbeatActivity(tx, canonicalActivityId('assistant', randomUUID())), (error: unknown) => error instanceof ApiError && error.status === 404);
});

test('terminal grants stay readable but are not execution authority', async () => {
  const tx = memoryTx();
  const service = new Service({} as never, {} as Auth);
  const activity = canonicalActivityId('assistant', 'msg-1');
  const first = await service.reserveActivity(tx, { operation_key: activity, activity_id: activity, activity_kind: 'assistant', category: 'assistant' }, 'device-a');
  assert.equal(first.executable, true);
  assert.equal(first.device_id, 'device-a');
  const other = await service.reserveActivity(tx, { operation_key: activity, activity_id: activity, activity_kind: 'assistant', category: 'assistant' }, 'device-b');
  assert.equal(other.executable, false);
  assert.equal(other.grant_id, first.grant_id);
  for (const status of ['expired', 'released', 'settled'] as const) {
    const row = (await tx.all('budget_reservations')).find(item => item.activity_id === activity)!;
    await tx.put('budget_reservations', { ...row, status, expires_at: '2020-01-01T00:00:00.000Z' }, row.id);
    const reread = await service.reserveActivity(tx, { operation_key: activity, activity_id: activity, activity_kind: 'assistant', category: 'assistant' }, 'device-a');
    assert.equal(reread.executable, false, status);
    assert.equal(reread.status, status);
  }
  const created = await service.reserveActivity(tx, { operation_key: activity, activity_id: activity, activity_kind: 'assistant', category: 'assistant', new_attempt: true }, 'device-a');
  assert.equal(created.executable, true);
  assert.equal(created.prior_activity_id, activity);
  assert.notEqual(created.activity_id, activity);
  const replay = await service.reserveActivity(tx, { operation_key: activity, activity_id: activity, activity_kind: 'assistant', category: 'assistant', new_attempt: true }, 'device-a');
  assert.equal(replay.grant_id, created.grant_id);
  assert.equal((await tx.all('budget_reservations')).filter(row => row.prior_activity_id === activity || row.activity_id === activity).length, 2);
});

test('duplicate usage observation does not add a second model call by itself', () => {
  const guard = new BudgetGuard(limitsFor('review'));
  guard.beforeModelCall();
  guard.noteUsage({ request_key: 'same', input_tokens: 1, cached_input_tokens: null, output_tokens: 1, reasoning_tokens: null });
  guard.noteUsage({ request_key: 'same', input_tokens: 1, cached_input_tokens: null, output_tokens: 1, reasoning_tokens: null });
  assert.equal(guard.calls, 1);
  assert.equal(guard.inputTokens, 1);
});
