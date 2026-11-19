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
  const usage = events.flatMap(event => event.type === 'usage' ? [event.usage] : []);
  assert.deepEqual(usage.map(sample => sample.request_key), ['xai:response1', 'xai:response2']);
  assert.equal(usage.some(sample => sample.request_key.startsWith('xai:attempt:')), false);
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

const usageSamples = (events: RuntimeEvent[]) => events.flatMap(event => event.type === 'usage' ? [event.usage] : []);

const assertUnknownAttempt = (events: RuntimeEvent[], round: number) => {
  const usage = usageSamples(events);
  assert.equal(usage.length, 1);
  const sample = usage[0]!;
  assert.equal(sample.request_key, `xai:attempt:r1:${round}`);
  assert.equal(sample.input_tokens, null);
  assert.equal(sample.cached_input_tokens, null);
  assert.equal(sample.output_tokens, null);
  assert.equal(sample.reasoning_tokens, null);
  assert.equal(sample.cost_ticks, undefined);
  assert.equal(Object.hasOwn(sample, 'amount'), false);
  assert.equal(Object.hasOwn(sample, 'cost'), false);
  const encoded = JSON.stringify(sample);
  assert.equal(encoded.includes('"amount":0'), false);
  assert.equal(encoded.includes('"amount":"0"'), false);
  assert.equal(encoded.includes('"cost_ticks":"0"'), false);
  assert.match(sample.occurred_at ?? '', /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  assert.ok(Math.abs(Date.parse(sample.occurred_at ?? '') - Date.now()) < 60_000);
};

test('abort or disconnect after send records one unknown attempt', async () => {
  const events: RuntimeEvent[] = [];
  let started!: () => void;
  const requestStarted = new Promise<void>(resolve => { started = resolve; });
  const fetcher = (async (_url: unknown, init: RequestInit) => {
    started();
    return new Promise<Response>((_resolve, reject) => init.signal!.addEventListener('abort', () => reject(new DOMException('Stopped', 'AbortError')), { once: true }));
  }) as typeof fetch;
  const noted: string[] = [];
  const ctx = context(events);
  ctx.budget = { beforeModelCall() {}, noteUsage(usage) { noted.push(usage.request_key); return null; } };
  const runtime = new GrokRuntime({ apiKey: 'TEST_LOCAL_KEY', fetcher });
  const executing = runtime.execute(ctx);
  await requestStarted;
  await runtime.stop();
  await assert.rejects(executing, { name: 'AbortError' });
  assertUnknownAttempt(events, 0);
  assert.deepEqual(noted, ['xai:attempt:r1:0']);

  const disconnected: RuntimeEvent[] = [];
  const failing = new GrokRuntime({ apiKey: 'TEST_LOCAL_KEY', fetcher: (async () => { throw new Error('disconnected'); }) as typeof fetch });
  await assert.rejects(failing.execute(context(disconnected)), /disconnected/);
  assertUnknownAttempt(disconnected, 0);
});

test('abort before send records no usage sample', async () => {
  const events: RuntimeEvent[] = [];
  const controller = new AbortController();
  let fetches = 0;
  const fetcher = (async () => { fetches += 1; return Response.json({ id: 'should-not-send' }); }) as typeof fetch;
  const ctx = context(events);
  ctx.signal = controller.signal;
  ctx.emit = event => { events.push(event); if (event.type === 'progress') controller.abort(); };
  await assert.rejects(new GrokRuntime({ apiKey: 'TEST_LOCAL_KEY', fetcher }).execute(ctx), { name: 'AbortError' });
  assert.equal(fetches, 0);
  assert.equal(usageSamples(events).length, 0);

  const already = new AbortController();
  already.abort();
  const prior: RuntimeEvent[] = [];
  const priorContext = context(prior);
  priorContext.signal = already.signal;
  let priorFetches = 0;
  await assert.rejects(new GrokRuntime({ apiKey: 'TEST_LOCAL_KEY', fetcher: (async () => { priorFetches += 1; return Response.json({}); }) as typeof fetch }).execute(priorContext), { name: 'AbortError' });
  assert.equal(priorFetches, 0);
  assert.equal(usageSamples(prior).length, 0);
});

test('errors thrown before fetch record no usage sample', async () => {
  const parameters: Record<string, unknown> = {};
  parameters.self = parameters;
  const events: RuntimeEvent[] = [];
  const ctx = context(events);
  ctx.tools = [{ name: 'memory_search', description: 'Search', parameters }];
  let fetches = 0;
  const fetcher = (async () => { fetches += 1; return Response.json({}); }) as typeof fetch;
  await assert.rejects(new GrokRuntime({ apiKey: 'TEST_LOCAL_KEY', fetcher }).execute(ctx), /circular/);
  assert.equal(fetches, 0);
  assert.equal(usageSamples(events).length, 0);

  const blocked: RuntimeEvent[] = [];
  const budgetContext = context(blocked);
  budgetContext.budget = { beforeModelCall() { throw new Error('budget_stop:model_call_limit'); } };
  let budgetFetches = 0;
  await assert.rejects(new GrokRuntime({ apiKey: 'TEST_LOCAL_KEY', fetcher: (async () => { budgetFetches += 1; return Response.json({}); }) as typeof fetch }).execute(budgetContext), /budget_stop:model_call_limit/);
  assert.equal(budgetFetches, 0);
  assert.equal(usageSamples(blocked).length, 0);
});

test('http error and retry exhaustion after send record one attempt, not two', async () => {
  const httpEvents: RuntimeEvent[] = [];
  const http = new GrokRuntime({ apiKey: 'TEST_LOCAL_KEY', fetcher: (async () => new Response('SECRET_ECHO', { status: 401 })) as typeof fetch });
  await assert.rejects(http.execute(context(httpEvents)), (error: Error) => {
    assert.equal(error.message, 'grok_http_401');
    assert.equal(error.message.includes('SECRET_ECHO'), false);
    return true;
  });
  assertUnknownAttempt(httpEvents, 0);
  assert.equal(httpEvents.some(event => event.type === 'usage' && event.usage.request_key.startsWith('xai:failed:')), false);

  let fetches = 0;
  const exhaustedEvents: RuntimeEvent[] = [];
  const exhausted = new GrokRuntime({
    apiKey: 'TEST_LOCAL_KEY',
    fetcher: (async () => { fetches += 1; return new Response('nope', { status: 503 }); }) as typeof fetch,
  });
  await assert.rejects(exhausted.execute(context(exhaustedEvents)), /grok_http_503|grok_retry_exhausted/);
  assert.equal(fetches, 4);
  assertUnknownAttempt(exhaustedEvents, 0);
});

test('a retry that later succeeds records the normal usage and not an unknown attempt', async () => {
  let fetches = 0;
  const events: RuntimeEvent[] = [];
  const fetcher = (async () => {
    fetches += 1;
    if (fetches === 1) return new Response('busy', { status: 503 });
    return Response.json({ id: 'response-ok', usage: { input_tokens: 4, output_tokens: 2, cost_in_usd_ticks: 50 }, output: [{ type: 'message', content: [{ type: 'output_text', text: 'done' }] }] });
  }) as typeof fetch;
  const result = await new GrokRuntime({ apiKey: 'TEST_LOCAL_KEY', fetcher }).execute(context(events));
  assert.equal(result.text, 'done');
  assert.equal(fetches, 2);
  const usage = usageSamples(events);
  assert.equal(usage.length, 1);
  assert.equal(usage[0]!.request_key, 'xai:response-ok');
  assert.equal(usage[0]!.input_tokens, 4);
  assert.equal(usage[0]!.output_tokens, 2);
  assert.equal(usage[0]!.cost_ticks, '50');
});

test('failure after a successful round records only that later attempt', async () => {
  let fetches = 0;
  const events: RuntimeEvent[] = [];
  const fetcher = (async () => {
    fetches += 1;
    if (fetches === 1) return Response.json({ id: 'response1', usage: { input_tokens: 10, output_tokens: 3, cost_in_usd_ticks: 1000 }, output: [{ type: 'function_call', call_id: 'call1', name: 'memory_search', arguments: '{"query":"release"}' }] });
    throw new Error('disconnected');
  }) as typeof fetch;
  await assert.rejects(new GrokRuntime({ apiKey: 'TEST_LOCAL_KEY', fetcher }).execute(context(events)), /disconnected/);
  const usage = usageSamples(events);
  assert.deepEqual(usage.map(sample => sample.request_key), ['xai:response1', 'xai:attempt:r1:1']);
  assert.equal(usage[1]!.input_tokens, null);
  assert.equal(usage[1]!.output_tokens, null);
  assert.equal(usage[1]!.cost_ticks, undefined);
});
