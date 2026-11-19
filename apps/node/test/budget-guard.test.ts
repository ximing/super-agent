import test from 'node:test';
import assert from 'node:assert/strict';
import { BudgetGuard, limitsFor } from '../src/budget-guard.js';

test('time and tool limits stop later work while an in-flight call remains outside the guard', () => {
  const guard = new BudgetGuard({ ...limitsFor('worker'), max_runtime_ms: 1_000, max_tool_steps: 1 }, 1_000);
  guard.beforeToolCall(1_100);
  assert.throws(() => guard.beforeToolCall(1_200), /tool_step_limit/);
  const expired = new BudgetGuard({ ...limitsFor('proactive'), max_runtime_ms: 500 }, 0);
  assert.throws(() => expired.beforeModelCall(500), /time_limit/);
});
