import test from 'node:test';
import assert from 'node:assert/strict';
import { ApiFailure, NodeApi, transportFailed } from '../src/api.js';
import type { NodeConfig } from '../src/config.js';

test('review requests carry an optimistic version and never silently retry a conflicting verdict', async () => {
  let calls = 0;
  let status = 409;
  const api = new NodeApi({ server_url: 'https://control.example' } as NodeConfig, async (_url, init) => {
    calls++;
    const headers = new Headers(init?.headers);
    assert.equal(headers.get('if-match'), '"42"');
    assert.equal(headers.get('x-assistant-epoch'), '7');
    assert.equal(headers.get('idempotency-key'), 'stable-event-review');
    return new Response(JSON.stringify({ error: { code: 'version_conflict', message: 'Refresh required' } }), { status });
  });
  await assert.rejects(api.raw('/assistant/tasks/task/reviews', { verdict: 'accept' }, { version: 42, assistantEpoch: '7', idempotencyKey: 'stable-event-review' }), (error: unknown) => error instanceof ApiFailure && error.code === 'version_conflict');
  assert.equal(calls, 1);
  status = 412;
  await assert.rejects(api.raw('/assistant/tasks/task/reviews', { verdict: 'accept' }, { version: 42, assistantEpoch: '7', idempotencyKey: 'stable-event-review' }), (error: unknown) => error instanceof ApiFailure && error.status === 412);
  assert.equal(calls, 2);
  await assert.rejects(api.raw('/assistant/tasks/task/reviews', {}, { version: NaN }), /invalid_entity_version/);
  assert.equal(calls, 2);
});

test('a timed-out control request drops the pooled connection once and an HTTP error does not', async () => {
  let resets = 0;
  const timeout = new Error('The operation was aborted due to timeout');
  timeout.name = 'TimeoutError';
  const api = new NodeApi({ server_url: 'https://control.example' } as NodeConfig, async () => { throw timeout; }, () => { resets++; });
  await assert.rejects(api.raw('/node/heartbeat', {}), (error: unknown) => transportFailed(error));
  assert.equal(resets, 1);
  const httpError = new NodeApi({ server_url: 'https://control.example' } as NodeConfig, async () => new Response(JSON.stringify({ error: { code: 'http_500', message: 'Control API returned 500' } }), { status: 500 }), () => { resets++; });
  await assert.rejects(httpError.raw('/node/heartbeat', {}), (error: unknown) => error instanceof ApiFailure && error.status === 500);
  assert.equal(resets, 1);
});
