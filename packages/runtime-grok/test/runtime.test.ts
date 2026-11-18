import test from 'node:test';
import assert from 'node:assert/strict';
import { GrokRuntime } from '../src/index.js';
import type { RuntimeContext, RuntimeEvent } from '@super-agent/tool-broker/runtime';
const context = (events: RuntimeEvent[]): RuntimeContext => ({ runId: 'r1', taskId: 't1', goal: 'Read memory', modelId: 'test-model', cwd: '/tmp', tools: [{ name: 'memory_search', description: 'Search', parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } }], executeTool: async () => ({ known: true }), emit: event => { events.push(event); }, signal: new AbortController().signal });

test('direct provider tool loop returns local tool result and records each request once', async () => {
  const calls: { url: string; body: Record<string, unknown>; auth: string }[] = [], events: RuntimeEvent[] = [];
  const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), body: JSON.parse(String(init?.body)), auth: String((init?.headers as Record<string, string>).authorization) });
    return Response.json(calls.length === 1 ? { id: 'response1', usage: { input_tokens: 10, output_tokens: 3, cost_in_usd_ticks: 1000 }, output: [{ type: 'function_call', call_id: 'call1', name: 'memory_search', arguments: '{"query":"release"}' }] }
      : { id: 'response2', usage: { input_tokens: 20, output_tokens: 5, cost_in_usd_ticks: 2000 }, output: [{ type: 'message', content: [{ type: 'output_text', text: 'Found the release procedure.' }] }] });
  }) as typeof fetch;
  const runtime = new GrokRuntime({ apiKey: 'TEST_LOCAL_KEY', fetcher });
  const result = await runtime.execute(context(events));
  assert.equal(result.text, 'Found the release procedure.'); assert.equal(calls.length, 2);
  assert.equal(calls[0]!.url, 'https://api.x.ai/v1/responses'); assert.equal(calls[0]!.auth, 'Bearer TEST_LOCAL_KEY');
  assert.equal(JSON.stringify(calls[0]!.body).includes('TEST_LOCAL_KEY'), false);
  assert.equal(calls[1]!.body.previous_response_id, 'response1');
  assert.deepEqual(calls[1]!.body.input, [{ type: 'function_call_output', call_id: 'call1', output: '{"known":true}' }]);
  assert.equal(events.filter(e => e.type === 'usage').length, 2);
});

test('stop aborts provider request and does not dispatch a tool afterwards', async () => {
  let started!: () => void; const requestStarted = new Promise<void>(resolve => { started = resolve; });
  const fetcher = (async (_url: unknown, init: RequestInit) => { started(); return new Promise<Response>((_resolve, reject) => init.signal!.addEventListener('abort', () => reject(new DOMException('Stopped', 'AbortError')), { once: true })); }) as typeof fetch;
  const runtime = new GrokRuntime({ apiKey: 'TEST_LOCAL_KEY', fetcher });
  const executing = runtime.execute(context([])); await requestStarted; await runtime.stop();
  await assert.rejects(executing, { name: 'AbortError' });
});

test('provider errors do not echo response body credentials or task data', async () => {
  const runtime = new GrokRuntime({ apiKey: 'TEST_LOCAL_KEY', fetcher: (async () => new Response('SECRET_ECHO', { status: 401 })) as typeof fetch });
  await assert.rejects(runtime.execute(context([])), /grok_http_401/);
  assert.throws(() => new GrokRuntime({ apiKey: 'x', baseUrl: 'http://remote.example/v1' }), /HTTPS/);
});
