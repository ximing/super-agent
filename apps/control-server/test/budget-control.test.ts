import test from 'node:test';
import assert from 'node:assert/strict';
import { admitReservation, dollarAdmission, evaluateLimits, limitsFor } from '../src/budget-control.js';
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

test('duplicate usage observation does not add a second model call by itself', () => {
  const guard = new BudgetGuard(limitsFor('review'));
  guard.beforeModelCall();
  guard.noteUsage({ request_key: 'same', input_tokens: 1, cached_input_tokens: null, output_tokens: 1, reasoning_tokens: null });
  guard.noteUsage({ request_key: 'same', input_tokens: 1, cached_input_tokens: null, output_tokens: 1, reasoning_tokens: null });
  assert.equal(guard.calls, 1);
  assert.equal(guard.inputTokens, 1);
});
