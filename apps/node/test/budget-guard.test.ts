import test from 'node:test';
import assert from 'node:assert/strict';
import { BudgetGuard, limitsFor } from '../src/budget-guard.js';

test('time and tool limits stop later work while an in-flight call remains outside the guard', () => {
  const guard = new BudgetGuard({ ...limitsFor('worker'), max_runtime_ms: 1_000, max_tool_steps: 1 }, 1_000);
  guard.beforeToolCall(1_100);
  assert.throws(() => guard.beforeToolCall(1_200), /tool_step_limit/);
  assert.equal(guard.tools, 1);
  const expired = new BudgetGuard({ ...limitsFor('proactive'), max_runtime_ms: 500 }, 0);
  assert.throws(() => expired.beforeModelCall(500), /time_limit/);
  assert.equal(expired.calls, 0);
});

test('model and tool calls succeed through N and N+1 throws before the increment', () => {
  const model = new BudgetGuard({ max_total_tokens: 100, max_model_calls: 2, max_tool_steps: 5, max_runtime_ms: 10_000 }, 0);
  model.beforeModelCall(1);
  model.beforeModelCall(2);
  assert.equal(model.calls, 2);
  assert.throws(() => model.beforeModelCall(3), /model_call_limit/);
  assert.equal(model.calls, 2);
  const tools = new BudgetGuard({ max_total_tokens: 100, max_model_calls: 5, max_tool_steps: 2, max_runtime_ms: 10_000 }, 0);
  tools.beforeToolCall(1);
  tools.beforeToolCall(2);
  assert.equal(tools.tools, 2);
  assert.throws(() => tools.beforeToolCall(3), /tool_step_limit/);
  assert.equal(tools.tools, 2);
});

test('duplicate noteUsage does not double tokens for the same request key', () => {
  const guard = new BudgetGuard({ max_total_tokens: 100, max_model_calls: 10, max_tool_steps: 10, max_runtime_ms: 10_000 }, 0);
  const sample = { request_key: 'xai:attempt:r1:0', input_tokens: 11, cached_input_tokens: null, output_tokens: 7, reasoning_tokens: null };
  assert.equal(guard.noteUsage(sample, 1), null);
  assert.equal(guard.noteUsage({ ...sample }, 2), null);
  assert.equal(guard.inputTokens, 11);
  assert.equal(guard.outputTokens, 7);
  guard.noteUsage({ ...sample, input_tokens: 15, output_tokens: 4 }, 3);
  assert.equal(guard.inputTokens, 15);
  assert.equal(guard.outputTokens, 7);
  guard.noteUsage({ ...sample, input_tokens: null, output_tokens: null }, 4);
  assert.equal(guard.inputTokens, 15);
  assert.equal(guard.outputTokens, 7);
});
