import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { buildApp, type ControlApp } from '../../apps/control-server/src/app.js';
import { Store } from '../../apps/control-server/src/store.js';
import { NodeApi } from '../../apps/node/src/api.js';
import { NodeAgent } from '../../apps/node/src/agent.js';
import { initConfig, writeConfig, type NodeConfig } from '../../apps/node/src/config.js';
import { FakeRuntime } from '../../apps/node/src/fake-runtime.js';
import type { AuthSession, Capabilities, ListResponse, Message, Task, WireMessage, CostSummary, TaskEvidence, CoordinatorEvent } from '@super-agent/protocol';
import type { RuntimeContext } from '@super-agent/tool-broker/runtime';
import { BrowserActor } from '../../packages/tool-broker/src/browser.js';
import { sleep } from '../../packages/tool-broker/src/runtime.js';

// Explicit opt-in cloud integration only. Never start a DB/container or fall back to production.
if (!process.env.TEST_DATABASE_URL && existsSync('.env.test')) process.loadEnvFile('.env.test');
const runtimeUrl = process.env.TEST_DATABASE_URL, migrationUrl = process.env.TEST_MIGRATION_DATABASE_URL;
function dedicatedCloudDatabase(value: string, name: string): URL {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error(`${name} must be a valid dedicated cloud PostgreSQL URL`); }
  const database = decodeURIComponent(url.pathname.slice(1));
  assert.ok(['postgres:', 'postgresql:'].includes(url.protocol), `${name} must be PostgreSQL`);
  assert.ok(database === 'super_agent_test' || /_test$/.test(database), `${name} must target a dedicated *_test database`);
  assert.ok(!/prod|production/i.test(database), `${name} cannot target production`);
  assert.ok(url.hostname && !['localhost', '127.0.0.1', '::1', '[::1]', 'host.docker.internal'].includes(url.hostname), `${name} must be a cloud database`);
  return url;
}

type RequestLog = { path: string; body: Record<string, unknown> | undefined };
function fetchThroughInject(app: ControlApp, log: RequestLog[], replay: { commands?: WireMessage[] } = {}): typeof fetch {
  return (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    assert.equal(url.origin, 'https://control.integration.invalid', 'Node must only use its configured cloud control origin');
    const body = init.body ? JSON.parse(String(init.body)) as Record<string, unknown> : undefined;
    log.push({ path: url.pathname, body });
    const headers: Record<string, string> = {};
    new Headers(init.headers).forEach((value, key) => { headers[key] = value; });
    const response = await app.inject({ method: (init.method ?? 'GET') as never, url: `${url.pathname}${url.search}`, headers, ...(init.body === undefined ? {} : { payload: String(init.body) }) });
    if (url.pathname === '/v1/node/commands' && response.statusCode === 200 && replay.commands) return Response.json({ items: [...response.json<{ items: WireMessage[] }>().items, ...replay.commands] });
    return new Response(response.statusCode === 204 ? null : response.body, { status: response.statusCode, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
}

async function client<T>(app: ControlApp, token: string | undefined, path: string, method = 'GET', body?: unknown, headers: Record<string, string> = {}): Promise<T> {
  const response = await app.inject({ method: method as never, url: `/v1${path}`, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers }, ...(body === undefined ? {} : { payload: body }) });
  assert.ok(response.statusCode >= 200 && response.statusCode < 300, `${method} ${path}: HTTP ${response.statusCode}, ${response.body}`);
  return response.json<T>();
}

async function pairNode(app: ControlApp, user: AuthSession, dir: string, fetcher: typeof fetch): Promise<{ config: NodeConfig; api: NodeApi }> {
  const path = join(dir, 'node.json');
  const config = await initConfig('https://control.integration.invalid', 'Cloud integration Mac', path, true);
  config.assistant = false;
  const api = new NodeApi(config, fetcher);
  const pairing = await api.raw<{ pairing_id: string; code: string; polling_secret: string }>('/device-pairings', { name: config.name, public_key: config.public_key });
  await client(app, user.access_token, '/device-pairings/claim', 'POST', { code: pairing.code });
  const result = await api.raw<{ status: string; device_id: string; tenant_id: string }>('/device-pairings/poll', { pairing_id: pairing.pairing_id, polling_secret: pairing.polling_secret });
  assert.equal(result.status, 'claimed'); config.device_id = result.device_id; config.tenant_id = result.tenant_id;
  await writeConfig(config, path);
  await api.authenticate();
  const caps: Capabilities = { generation: 1, engines: [{ engine: 'codex', ready: true, models: ['fake-test-model'], local_profile_id: 'test-only' }, { engine: 'grok', ready: true, models: ['fake-test-model'], local_profile_id: 'test-only' }], tools: ['memory', 'files', 'browser', 'questions'], slots: { browser: 1, worker: 3 } };
  await api.request(`/devices/${config.device_id}/capabilities`, caps, { method: 'PUT' });
  return { config, api };
}

async function setupApp(withMockObjectStorage = false): Promise<ControlApp> {
  assert.ok(runtimeUrl && migrationUrl, 'Both cloud test database URLs are required');
  const runtime = dedicatedCloudDatabase(runtimeUrl, 'TEST_DATABASE_URL'), migration = dedicatedCloudDatabase(migrationUrl, 'TEST_MIGRATION_DATABASE_URL');
  assert.equal(runtime.hostname, migration.hostname, 'Runtime and migration must target the same cloud host');
  assert.equal(runtime.pathname, migration.pathname, 'Runtime and migration must target the same dedicated database');
  const owner = new Store(migrationUrl);
  try { await owner.migrate(); } finally { await owner.close(); }
  const memoryId = randomUUID(), actorId = randomUUID();
  return buildApp({ databaseUrl: runtimeUrl, jwtSecret: 'integration-only-secret-with-at-least-32-bytes', allowDevAuth: true, runScheduler: false,
    ...(withMockObjectStorage ? { s3: { endpoint: 'https://objects.integration.invalid', bucket: 'explicit-test-only', region: 'test', accessKey: 'mock-only-access', secretKey: 'mock-only-secret' } } : {}),
    recallAllowedOrigins: ['https://recall.integration.invalid'], recallFetch: (async (url: string | URL | Request, options?: RequestInit) => {
      assert.equal(new URL(String(url)).origin, 'https://recall.integration.invalid');
      assert.equal((options?.headers as Record<string, string>).authorization, 'Bearer test-only-memory-token');
      if (String(url).endsWith('/api/auth/me')) return Response.json({ user: { id: actorId, email: 'memory@test.invalid' } });
      if (String(url).endsWith('/api/memories/recall')) return Response.json({ memories: [{ id: memoryId, content: 'Use the controlled release fixture.', type: 'workflow', tags: ['sa-type:procedure'], version: 1 }] });
      return Response.json({ memories: [] });
    }) as typeof fetch });
}

test('cloud PostgreSQL + real NodeAgent: pair/sign, dispatch/accept, durable fake execution, costs and restart replay', { skip: !runtimeUrl || !migrationUrl, timeout: 120_000 }, async () => {
  const app = await setupApp(), directory = mkdtempSync(join(tmpdir(), 'super-agent-cloud-node-'));
  const requestLog: RequestLog[] = [], replay: { commands?: WireMessage[] } = {};
  const fetcher = fetchThroughInject(app, requestLog, replay);
  let agent: NodeAgent | undefined, restarted: NodeAgent | undefined;
  try {
    const owner = await client<AuthSession>(app, undefined, '/auth/dev', 'POST', { email: `node-${randomUUID()}@integration.invalid` });
    const other = await client<AuthSession>(app, undefined, '/auth/dev', 'POST', { email: `other-${randomUUID()}@integration.invalid` });
    await client(app, owner.access_token, '/settings/memory', 'PUT', { url: 'https://recall.integration.invalid', token: 'test-only-memory-token' });
    const paired = await pairNode(app, owner, directory, fetcher);
    let executions = 0;
    class CountedFake extends FakeRuntime { override async execute(context: RuntimeContext) { assert.equal(context.mcp,undefined,'Explicit FakeRuntime must not start a local tool server'); executions++; const attachments = await context.executeTool('artifacts_list',{}) as {items:unknown[]}; assert.equal(attachments.items.length,0); return super.execute(context); } }
    agent = new NodeAgent(paired.config, { api: paired.api, runtimeFactory: async () => new CountedFake(), log: () => {} });
    const task = await client<Task>(app, owner.access_token, '/tasks', 'POST', { goal: 'Read controlled release fixture', engine: 'grok', device_id: paired.config.device_id }, { 'idempotency-key': randomUUID() });
    await app.control.service.dispatchTenant(owner.user.tenant_id);
    const firstCommands = await paired.api.request<ListResponse<WireMessage>>('/node/commands');
    assert.equal(firstCommands.items.length, 1); replay.commands = firstCommands.items;
    let result = task;
    for (let i = 0; i < 30 && result.status !== 'awaiting_review'; i++) {
      await agent.tick(); await sleep(40);
      await agent.flush();
      result = await client<Task>(app, owner.access_token, `/tasks/${task.id}`);
    }
    assert.equal(result.status, 'awaiting_review'); assert.equal(executions, 1);
    const evidence = await client<TaskEvidence>(app, owner.access_token, `/tasks/${task.id}/evidence`);
    assert.equal(evidence.run!.state, 'succeeded'); assert.ok(evidence.checkpoint);
    assert.ok(evidence.steps.length >= 3); assert.ok(evidence.steps.every(step => step.status === 'succeeded'));
    assert.doesNotMatch(JSON.stringify(evidence.steps), /test-only-memory-token|test-result\.txt|content|result_hash/);
    await client(app, owner.access_token, `/tasks/${task.id}/reviews`, 'POST', { run_id: evidence.run!.id, verdict: 'accept', summary: 'Human test fixture explicitly verifies the deterministic fake result.', checks: evidence.deliverables.map((_criterion, index) => ({ deliverable_index: index, passed: true, evidence_refs: [{ kind: 'checkpoint', id: evidence.checkpoint!.id }] })) }, { 'if-match': `"${evidence.task.version}"`, 'idempotency-key': randomUUID() });
    result = await client<Task>(app, owner.access_token, `/tasks/${task.id}`); assert.equal(result.status, 'succeeded');
    const costs = await client<CostSummary>(app, owner.access_token, '/costs/summary');
    assert.equal(costs.request_count, 1); assert.equal(costs.unknown_count, 1); assert.deepEqual(costs.totals, []);
    assert.equal(costs.input_tokens, 10); assert.equal(costs.output_tokens, 5);
    const denied = await app.inject({ method: 'GET', url: `/v1/tasks/${task.id}`, headers: { authorization: `Bearer ${other.access_token}` } });
    assert.equal(denied.statusCode, 404);
    const otherCosts = await client<CostSummary>(app, other.access_token, '/costs/summary'); assert.equal(otherCosts.request_count, 0);
    await agent.stop(); agent.close(); agent = undefined;
    restarted = new NodeAgent(paired.config, { api: new NodeApi(paired.config, fetcher), runtimeFactory: async () => { executions++; throw new Error('DUPLICATE EXECUTION MUST NOT START'); }, log: () => {} });
    await restarted.recover(); await restarted.tick(); await restarted.flush();
    assert.equal(executions, 1); assert.equal((await client<CostSummary>(app, owner.access_token, '/costs/summary')).request_count, 1);
    assert.ok(requestLog.some(r => r.path === '/v1/devices/auth/token'));
    assert.ok(requestLog.some(r => r.path.endsWith('/accept')));
    assert.ok(requestLog.some(r => r.path === '/v1/node/memory/search'));
    assert.ok(requestLog.some(r => r.path === '/v1/artifacts'));
    assert.ok(requestLog.some(r => r.path.endsWith('/checkpoint')));
    assert.doesNotMatch(JSON.stringify(requestLog), /BEGIN PRIVATE KEY|api_key|XAI_API_KEY|refresh_token/);
  } finally { if (agent) { await agent.stop(); agent.close(); } if (restarted) { await restarted.stop(); restarted.close(); } await app.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('cloud coordinator: worker completion triggers a fresh read-only review, usage and durable user report', { skip: !runtimeUrl || !migrationUrl, timeout: 120_000 }, async () => {
  // Models and S3 transfer are explicit fixtures; PostgreSQL, identity, journal, tool broker and event/review APIs are real.
  const app = await setupApp(true), directory = mkdtempSync(join(tmpdir(), 'super-agent-cloud-review-'));
  let agent: NodeAgent | undefined, restarted: NodeAgent | undefined;
  let workerTurns = 0, verifierTurns = 0, published = '', objectReads = 0;
  try {
    const owner = await client<AuthSession>(app, undefined, '/auth/dev', 'POST', { email: `review-${randomUUID()}@integration.invalid` });
    const log: RequestLog[] = [], fetcher = fetchThroughInject(app, log);
    const paired = await pairNode(app, owner, directory, fetcher);
    await client(app, owner.access_token, '/settings/execution', 'PUT', { default_engine: 'grok', default_device_id: paired.config.device_id, assistant_device_id: paired.config.device_id });
    paired.config.assistant = true; paired.config.assistant_engine = 'grok';
    agent = new NodeAgent(paired.config, { api: paired.api, log: () => {}, artifactFetcher: (async (url, init) => {
      assert.equal(new URL(String(url)).origin, 'https://objects.integration.invalid');
      assert.equal(new Headers(init?.headers).get('authorization'), null); objectReads++;
      return new Response(published);
    }) as typeof fetch, runtimeFactory: async () => ({
      execute: async context => {
        if (context.runId.startsWith('review-')) {
          verifierTurns++;
          const evidence = await context.executeTool('delivery_evidence', {}) as TaskEvidence;
          const observed = await context.executeTool('delivery_artifact_read', { id: evidence.artifacts[0]!.id }) as { content: string };
          assert.equal(observed.content, 'VERIFIED');
          await context.executeTool('delivery_review', { verdict: 'accept', summary: '[Scripted verifier fixture] independently read the delivered object.', checks: evidence.deliverables.map((_criterion, index) => ({ deliverable_index: index, passed: true, evidence_refs: [{ kind: 'artifact', id: evidence.artifacts[0]!.id }] })) });
          await context.emit({ type: 'usage', usage: { request_key: 'scripted-verifier-only', input_tokens: 7, cached_input_tokens: 0, output_tokens: 2, reasoning_tokens: 0 } });
          return { text: '[Scripted verifier fixture] complete' };
        }
        workerTurns++;
        await context.executeTool('files_write', { path: 'report.md', content: 'VERIFIED' });
        const content = await context.executeTool('files_read', { path: 'report.md' }) as { content: string }; published = content.content;
        await app.control.store.tenant(owner.user.tenant_id, tx => tx.put('artifacts', { task_id: context.taskId, run_id: context.runId, name: 'report.md', mime: 'text/markdown', size: Buffer.byteLength(published), status: 'ready', integrity: 'server_snapshot', object_key: `fixture/${randomUUID()}` }));
        await context.emit({ type: 'usage', usage: { request_key: 'scripted-worker-only', input_tokens: 10, cached_input_tokens: 0, output_tokens: 5, reasoning_tokens: 0 } });
        return { text: published };
      }, stop: async () => {}, steer: async () => {},
    }) });
    const task = await client<Task>(app, owner.access_token, '/tasks', 'POST', { goal: 'Produce the controlled text report.', deliverables: ['Delivered report contains VERIFIED'], engine: 'grok', device_id: paired.config.device_id });
    await app.control.service.dispatchTenant(owner.user.tenant_id);
    let result = task;
    for (let i = 0; i < 50 && result.status !== 'succeeded'; i++) {
      await agent.tick(); await sleep(30); await agent.flush();
      result = await client<Task>(app, owner.access_token, `/tasks/${task.id}`);
    }
    assert.equal(result.status, 'succeeded'); assert.equal(result.delivery_status, 'accepted');
    for (let i = 0; i < 10 && agent.store.coordinatorPending().length; i++) { await agent.tick(); await sleep(30); }
    assert.equal(workerTurns, 1); assert.equal(verifierTurns, 1); assert.equal(objectReads, 1);
    assert.equal(agent.store.coordinatorPending().length, 0);
    const evidence = await client<TaskEvidence>(app, owner.access_token, `/tasks/${task.id}/evidence`);
    assert.equal(evidence.reviews.length, 1); assert.equal(evidence.reviews[0]!.verdict, 'accept');
    assert.ok(evidence.steps.length >= 3); assert.ok(evidence.steps.every(step => step.status === 'succeeded'));
    const events = await app.control.store.tenant(owner.user.tenant_id, tx => tx.all('coordinator_events'));
    assert.equal(events.length, 1); assert.equal(events[0]!.status, 'completed');
    const costs = await client<CostSummary>(app, owner.access_token, '/costs/summary');
    assert.equal(costs.request_count, 2); assert.equal(costs.input_tokens, 17); assert.equal(costs.output_tokens, 7);
    assert.equal((await client<ListResponse<Message>>(app, owner.access_token, '/messages')).items.filter(message => message.role === 'assistant').length, 1);
    await agent.stop(); agent.close(); agent = undefined;
    restarted = new NodeAgent(paired.config, { api: new NodeApi(paired.config, fetcher), runtimeFactory: async () => { throw new Error('NO MODEL REPLAY AFTER ACK'); }, log: () => {} });
    await restarted.recover(); await restarted.tick(); await sleep(30); await restarted.stop();
    assert.equal((await client<CostSummary>(app, owner.access_token, '/costs/summary')).request_count, 2);
    assert.equal(workerTurns, 1); assert.equal(verifierTurns, 1);
  } finally { if (agent) { await agent.stop(); agent.close(); } if (restarted) { await restarted.stop(); restarted.close(); } await app.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('cloud PostgreSQL + selected assistant Mac: durable plan routes task to user-selected second computer', { skip: !runtimeUrl || !migrationUrl, timeout: 120_000 }, async () => {
  const app = await setupApp(), directory = mkdtempSync(join(tmpdir(), 'super-agent-cloud-plan-'));
  let assistant: NodeAgent | undefined;
  try {
    const owner = await client<AuthSession>(app, undefined, '/auth/dev', 'POST', { email: `assistant-${randomUUID()}@integration.invalid` });
    const log: RequestLog[] = [], fetcher = fetchThroughInject(app, log);
    const first = await pairNode(app, owner, join(directory, 'assistant'), fetcher);
    const second = await pairNode(app, owner, join(directory, 'executor'), fetcher);
    await client(app, owner.access_token, '/settings/execution', 'PUT', { default_engine: 'codex', default_device_id: first.config.device_id, assistant_device_id: first.config.device_id });
    first.config.assistant = true;
    assistant = new NodeAgent(first.config, { api: first.api, log: () => {} });
    const message = await client<Message>(app, owner.access_token, '/messages', 'POST', { client_message_id: randomUUID(), text: 'Inspect the controlled website on the second computer', execution_preference: { engine: 'grok', device_id: second.config.device_id, selection_mode: 'pinned' } });
    for (let i = 0; i < 40 && !assistant.store.get(`assistant:${message.id}`); i++) { await assistant.tick(); await sleep(40); }
    assert.ok(assistant.store.get(`assistant:${message.id}`));
    let tasks = (await client<ListResponse<Task>>(app, owner.access_token, '/tasks')).items;
    assert.equal(tasks.length, 0, 'Ordinary chat must not execute before goal confirmation');
    const plans = (await client<ListResponse<{ id: string; items: {deliverables:string[]}[]; summary:string }>>(app, owner.access_token, '/assistant/plans?state=awaiting_confirmation')).items;
    assert.equal(plans.length,1); assert.ok(plans[0]!.summary.includes('引擎：grok')); assert.ok(plans[0]!.summary.includes(second.config.device_id!.slice(0,8)));
    assert.deepEqual(plans[0]!.items[0]!.deliverables,['任务结果与执行说明']);
    await assistant.stop(); assistant.close();
    assistant = new NodeAgent(first.config,{api:first.api,log:()=>{}});
    const confirmation = await client<Message>(app, owner.access_token, '/messages', 'POST', {client_message_id:randomUUID(),text:`确认 ${plans[0]!.id.slice(0,8)}`});
    for (let i = 0; i < 40 && !assistant.store.get(`assistant:${confirmation.id}`); i++) { await assistant.tick(); await sleep(40); }
    tasks = (await client<ListResponse<Task>>(app, owner.access_token, '/tasks')).items;
    assert.equal(tasks.length,1); assert.equal(tasks[0]!.device_id,second.config.device_id); assert.equal(tasks[0]!.engine,'grok');
    await assistant.tick(); await sleep(50);
    assert.equal((await client<ListResponse<Task>>(app, owner.access_token, '/tasks')).items.length, 1);
    // Replayed confirm after a lost response returns the same task, never another run.
    const replay = await client<{tasks:Task[]}>(app,owner.access_token,`/assistant/plans/${plans[0]!.id}/confirm`,'POST',{source_message_id:confirmation.id});
    assert.equal(replay.tasks[0]!.id,tasks[0]!.id);
    const revised = await client<Message>(app,owner.access_token,'/messages','POST',{client_message_id:randomUUID(),text:'Prepare another inspection proposal'});
    for(let i=0;i<40&&!assistant.store.get(`assistant:${revised.id}`);i++){await assistant.tick();await sleep(40);}
    assert.equal((await client<ListResponse<Task>>(app,owner.access_token,'/tasks')).items.length,1);
    const cancelled = await client<Message>(app,owner.access_token,'/messages','POST',{client_message_id:randomUUID(),text:'取消'});
    for(let i=0;i<40&&!assistant.store.get(`assistant:${cancelled.id}`);i++){await assistant.tick();await sleep(40);}
    assert.equal((await client<ListResponse<{id:string}>>(app,owner.access_token,'/assistant/plans?state=awaiting_confirmation')).items.length,0);
    assert.equal((await client<ListResponse<Task>>(app,owner.access_token,'/tasks')).items.length,1);
    const messages = (await client<ListResponse<Message>>(app, owner.access_token, '/messages')).items;
    assert.equal(messages.filter(m => m.role === 'assistant').length, 4);
    assert.ok(log.some(r => r.path === '/v1/node/devices'));
    await app.control.service.dispatchTenant(owner.user.tenant_id);
    assert.equal((await first.api.request<ListResponse<WireMessage>>('/node/commands')).items.filter(m => m.kind === 'run.start').length, 0);
    assert.equal((await second.api.request<ListResponse<WireMessage>>('/node/commands')).items.filter(m => m.kind === 'run.start').length, 1);
  } finally { if (assistant) { await assistant.stop(); assistant.close(); } await app.close(); rmSync(directory, { recursive: true, force: true }); }
});


test('cloud view/control: pause before takeover, natural-pixel input, stale frame rejection and tenant isolation', { skip: !runtimeUrl || !migrationUrl, timeout: 120_000 }, async () => {
  const app = await setupApp(), directory = mkdtempSync(join(tmpdir(), 'super-agent-cloud-view-'));
  let agent: NodeAgent | undefined;
  try {
    const owner = await client<AuthSession>(app, undefined, '/auth/dev', 'POST', { email: `view-${randomUUID()}@integration.invalid` });
    const other = await client<AuthSession>(app, undefined, '/auth/dev', 'POST', { email: `view-other-${randomUUID()}@integration.invalid` });
    const calls: { action: string; args: Record<string, unknown> }[] = [];
    const imagePath = join(directory, 'retina.png'), png = Buffer.alloc(24);
    Buffer.from([137,80,78,71,13,10,26,10]).copy(png); png.writeUInt32BE(1600,16); png.writeUInt32BE(1200,20); writeFileSync(imagePath,png);
    const browser = new BrowserActor('http://csi.integration.invalid', (async (_url: unknown, init: RequestInit) => {
      const command = JSON.parse(String(init.body)); calls.push(command);
      return Response.json({ success: true, data: command.action === 'screenshot' ? { path: imagePath } : command.action === 'evaluate' ? { value: JSON.stringify({width:800,height:600,scale:2,url:'https://fixture.invalid',scroll_x:0,scroll_y:0}) } : {} });
    }) as typeof fetch);
    const paired = await pairNode(app, owner, join(directory,'node'), fetchThroughInject(app, []));
    await client(app, owner.access_token, '/settings/memory', 'PUT', { url: 'https://recall.integration.invalid', token: 'test-only-memory-token' });
    paired.config.renew_interval_ms = 1;
    let interrupted = false;
    agent = new NodeAgent(paired.config, { api: paired.api, browser, log: () => {}, runtimeFactory: async () => ({
      execute: async (context: RuntimeContext) => {
        await context.executeTool('browser_navigate', {url:'https://fixture.invalid'});
        await new Promise<void>((_resolve,reject) => context.signal.addEventListener('abort',()=>{interrupted=true;reject(new DOMException('Stopped','AbortError'));},{once:true}));
        return {text:'unreachable'};
      }, stop: async () => {}, steer: async () => {},
    }) });
    const task = await client<Task>(app, owner.access_token, '/tasks','POST',{goal:'Wait at controlled browser fixture',engine:'codex',device_id:paired.config.device_id});
    await app.control.service.dispatchTenant(owner.user.tenant_id); await agent.tick();
    for(let i=0;i<20&&!calls.some(c=>c.action==='navigate');i++) await sleep(10);
    assert.ok(calls.some(c=>c.action==='navigate'));
    const running = await client<Task>(app,owner.access_token,`/tasks/${task.id}`), runId = running.current_run_id!;
    const view = await client<{id:string}>(app,owner.access_token,`/runs/${runId}/views`,'POST',{});
    await agent.tick();
    const firstFrame = await client<{frame_id:string;viewport_version:string;width:number}>(app,owner.access_token,`/runs/${runId}/frame`);
    assert.equal(firstFrame.width,1600);
    const takeover = await client<{status:string}>(app,owner.access_token,`/views/${view.id}/control`,'POST',{});
    assert.equal(takeover.status,'pausing');
    const tooEarly = await app.inject({method:'POST',url:`/v1/views/${view.id}/inputs`,headers:{authorization:`Bearer ${owner.access_token}`},payload:{...firstFrame,type:'click',x:600,y:400}});
    assert.equal(tooEarly.statusCode,409);
    for(let i=0;i<20;i++){await sleep(10);await agent.tick();if((await client<Task>(app,owner.access_token,`/tasks/${task.id}`)).status==='paused')break;}
    assert.equal(interrupted,true); assert.equal((await client<Task>(app,owner.access_token,`/tasks/${task.id}`)).status,'paused');
    await agent.tick();
    const frame = await client<{frame_id:string;viewport_version:string}>(app,owner.access_token,`/runs/${runId}/frame`);
    await client(app,owner.access_token,`/views/${view.id}/inputs`,'POST',{...frame,type:'click',x:600,y:400});
    await agent.tick();
    const mouse = calls.find(c=>c.action==='cdp'&&(c.args.params as Record<string,unknown>)?.type==='mousePressed');
    assert.ok(mouse); assert.equal((mouse.args.params as Record<string,unknown>).x,300); assert.equal((mouse.args.params as Record<string,unknown>).y,200);
    const stale = await app.inject({method:'POST',url:`/v1/views/${view.id}/inputs`,headers:{authorization:`Bearer ${owner.access_token}`},payload:{...frame,type:'click',x:600,y:400}}); assert.equal(stale.statusCode,409);
    const typingFrame=await client<{frame_id:string;viewport_version:string}>(app,owner.access_token,`/runs/${runId}/frame`);
    await client(app,owner.access_token,`/views/${view.id}/inputs`,'POST',{...typingFrame,type:'text',text:'Native client typing fixture'});
    await agent.tick();assert.ok(calls.some(c=>c.action==='key_type'&&c.args.text==='Native client typing fixture'),'Native text input reaches the real node adapter');
    const denied = await app.inject({method:'GET',url:`/v1/runs/${runId}/frame`,headers:{authorization:`Bearer ${other.access_token}`}}); assert.equal(denied.statusCode,404);
    await client(app,owner.access_token,`/views/${view.id}/control`,'DELETE'); await agent.tick();
    const current = await client<{frame_id:string;viewport_version:string}>(app,owner.access_token,`/runs/${runId}/frame`);
    await assert.rejects(browser.input(runId,{...current,type:'click',x:1,y:1}),/human_control_not_active/);
  } finally { if(agent){await agent.stop();agent.close();} await app.close();rmSync(directory,{recursive:true,force:true}); }
});

test('cloud assistant clarification keeps conversation context and proposes work without early execution', {skip:!runtimeUrl||!migrationUrl,timeout:120_000}, async()=>{
  const app=await setupApp(),directory=mkdtempSync(join(tmpdir(),'super-agent-cloud-context-'));
  let agent:NodeAgent|undefined;
  try{
    const owner=await client<AuthSession>(app,undefined,'/auth/dev','POST',{email:`context-${randomUUID()}@integration.invalid`});
    const paired=await pairNode(app,owner,directory,fetchThroughInject(app,[]));
    await client(app,owner.access_token,'/settings/execution','PUT',{default_engine:'codex',default_device_id:paired.config.device_id,assistant_device_id:paired.config.device_id});
    paired.config.assistant=true;paired.config.fake_runtime=false;
    let turns=0;
    // Explicit scripted runtime fixture: tests assistant plumbing, never claims model quality.
    agent=new NodeAgent(paired.config,{api:paired.api,log:()=>{},runtimeFactory:async()=>({execute:async(context)=>{
      turns++;assert.match(context.developerInstructions??'',/separate explicit human confirmation/);
      if(turns===1)return{text:'请明确要检查哪个网站？'};
      assert.match(context.goal,/请明确要检查哪个网站/);assert.match(context.goal,/Inspect a company website/);assert.match(context.goal,/portal.example.invalid/);
      await context.executeTool('task_start',{item_key:'inspect',goal:'Inspect https://portal.example.invalid',deliverables:['检查结果'],engine:'codex',device_id:paired.config.device_id});
      return{text:'请确认网站检查目标。'};
    },steer:async()=>{},stop:async()=>{}})});
    const first=await client<Message>(app,owner.access_token,'/messages','POST',{client_message_id:randomUUID(),text:'Inspect a company website'});
    for(let i=0;i<40&&!agent.store.get(`assistant:${first.id}`);i++){await agent.tick();await sleep(40);}
    assert.ok(agent.store.get(`assistant:${first.id}`));assert.equal((await client<ListResponse<Task>>(app,owner.access_token,'/tasks')).items.length,0);
    assert.equal((await client<ListResponse<{id:string}>>(app,owner.access_token,'/assistant/plans?state=awaiting_confirmation')).items.length,0);
    const answer=await client<Message>(app,owner.access_token,'/messages','POST',{client_message_id:randomUUID(),text:'https://portal.example.invalid'});
    for(let i=0;i<40&&!agent.store.get(`assistant:${answer.id}`);i++){await agent.tick();await sleep(40);}
    assert.ok(agent.store.get(`assistant:${answer.id}`));assert.equal(turns,2);
    assert.equal((await client<ListResponse<{id:string}>>(app,owner.access_token,'/assistant/plans?state=awaiting_confirmation')).items.length,1);
    assert.equal((await client<ListResponse<Task>>(app,owner.access_token,'/tasks')).items.length,0);
  }finally{if(agent){await agent.stop();agent.close();}await app.close();rmSync(directory,{recursive:true,force:true});}
});

test('cloud assistant retains failed-turn usage and recovers an interrupted journal without replaying models', {skip:!runtimeUrl||!migrationUrl,timeout:120_000}, async()=>{
  const app=await setupApp(),directory=mkdtempSync(join(tmpdir(),'super-agent-cloud-planner-failure-'));
  let agent:NodeAgent|undefined,restarted:NodeAgent|undefined;
  try{
    const owner=await client<AuthSession>(app,undefined,'/auth/dev','POST',{email:`failed-planner-${randomUUID()}@integration.invalid`});
    const fetcher=fetchThroughInject(app,[]),paired=await pairNode(app,owner,directory,fetcher);
    await client(app,owner.access_token,'/settings/execution','PUT',{default_engine:'grok',default_device_id:paired.config.device_id,assistant_device_id:paired.config.device_id});
    paired.config.assistant=true;paired.config.assistant_engine='grok';paired.config.fake_runtime=false;
    paired.config.grok.model='';
    await paired.api.request(`/devices/${paired.config.device_id}/capabilities`,{generation:2,engines:[{engine:'grok',ready:true,models:['configured-default'],local_profile_id:'test-only'}],tools:['memory','files','questions'],slots:{browser:0,worker:1}},{method:'PUT'});
    let turns=0;
    agent=new NodeAgent(paired.config,{api:paired.api,log:()=>{},runtimeFactory:async()=>({execute:async(context)=>{
      turns++;
      assert.equal(context.modelId,'','Native Grok receives its default-model selection');
      await context.emit({type:'usage',usage:{request_key:'scripted-failed-planner',input_tokens:null,cached_input_tokens:null,output_tokens:null,reasoning_tokens:null}});
      throw new Error('fixture-provider-stream-disconnected');
    },steer:async()=>{},stop:async()=>{}})});
    const first=await client<Message>(app,owner.access_token,'/messages','POST',{client_message_id:randomUUID(),text:'Prepare an explicitly confirmed read-only inspection'});
    for(let i=0;i<60&&!agent.store.get(`assistant:${first.id}`);i++){await agent.tick();await sleep(40);}
    assert.ok(agent.store.get(`assistant:${first.id}`));
    for(let i=0;i<5;i++){await agent.tick();await sleep(20);}
    assert.equal(turns,1,'A failed paid prompt must never auto-retry on the next poll');
    assert.equal((await client<ListResponse<Task>>(app,owner.access_token,'/tasks')).items.length,0);
    const costs=await client<CostSummary>(app,owner.access_token,'/costs/summary');
    assert.equal(costs.request_count,1);assert.equal(costs.unknown_count,1);
    await agent.stop();agent.close();agent=undefined;

    const interrupted=await client<Message>(app,owner.access_token,'/messages','POST',{client_message_id:randomUUID(),text:'An interrupted scripted planner attempt'});
    restarted=new NodeAgent(paired.config,{api:new NodeApi(paired.config,fetcher),log:()=>{},runtimeFactory:async()=>{turns++;throw new Error('Model replay forbidden');}});
    restarted.store.saveAssistant(interrupted.id,{phase:'running',text:'',usage:[],engine:'grok',model_id:'fixture',plan_id:randomUUID()});
    for(let i=0;i<60&&!restarted.store.get(`assistant:${interrupted.id}`);i++){await restarted.tick();await sleep(40);}
    assert.ok(restarted.store.get(`assistant:${interrupted.id}`));assert.equal(turns,1);
    assert.equal((await client<ListResponse<Task>>(app,owner.access_token,'/tasks')).items.length,0);
    const messages=await client<ListResponse<Message>>(app,owner.access_token,'/messages');
    assert.ok(messages.items.some(m=>m.role==='assistant'&&m.content.includes('没有自动重试模型')));
    assert.equal((await client<CostSummary>(app,owner.access_token,'/costs/summary')).request_count,1);
  }finally{if(agent){await agent.stop();agent.close();}if(restarted){await restarted.stop();restarted.close();}await app.close();rmSync(directory,{recursive:true,force:true});}
});

test('cloud assistant retries a durable successful proposal after usage transport failure without changing its body', {skip:!runtimeUrl||!migrationUrl,timeout:120_000}, async()=>{
  const app=await setupApp(),directory=mkdtempSync(join(tmpdir(),'super-agent-cloud-planner-transport-'));
  let agent:NodeAgent|undefined;
  try{
    const owner=await client<AuthSession>(app,undefined,'/auth/dev','POST',{email:`planner-transport-${randomUUID()}@integration.invalid`});
    let failUsage=true,turns=0;
    const injected=fetchThroughInject(app,[]);
    const fetcher:typeof fetch=async(input,init)=>{
      if(String(input).endsWith('/assistant/usage')&&failUsage){failUsage=false;return Response.json({error:{code:'fixture_temporarily_unavailable',message:'fixture transient failure'}},{status:503});}
      return injected(input,init);
    };
    const paired=await pairNode(app,owner,directory,fetcher);
    await client(app,owner.access_token,'/settings/execution','PUT',{default_engine:'codex',default_device_id:paired.config.device_id,assistant_device_id:paired.config.device_id});
    paired.config.assistant=true;paired.config.fake_runtime=false;
    paired.config.codex.model='fake-test-model';
    agent=new NodeAgent(paired.config,{api:paired.api,log:()=>{},runtimeFactory:async()=>({execute:async(context)=>{
      turns++;
      await context.executeTool('task_start',{item_key:'fixture',goal:'Read-only proposed fixture',deliverables:['可核对结果'],engine:'codex',device_id:paired.config.device_id});
      await context.emit({type:'usage',usage:{request_key:'scripted-success-before-transport',input_tokens:3,cached_input_tokens:0,output_tokens:2,reasoning_tokens:0}});
      return{text:'脚本方案已准备，请确认目标。'};
    },steer:async()=>{},stop:async()=>{}})});
    const message=await client<Message>(app,owner.access_token,'/messages','POST',{client_message_id:randomUUID(),text:'Prepare a fixture proposal only'});
    for(let i=0;i<80&&!agent.store.get(`assistant:${message.id}`);i++){await agent.tick();await sleep(40);}
    assert.ok(agent.store.get(`assistant:${message.id}`));assert.equal(turns,1);assert.equal(failUsage,false);
    const pending=await client<ListResponse<{summary:string}>>(app,owner.access_token,'/assistant/plans?state=awaiting_confirmation');
    assert.equal(pending.items.length,1);assert.match(pending.items[0]!.summary,/脚本方案已准备/);
    const replies=(await client<ListResponse<Message>>(app,owner.access_token,'/messages')).items.filter(m=>m.role==='assistant');
    assert.equal(replies.length,1);assert.match(replies[0]!.content,/脚本方案已准备/);assert.doesNotMatch(replies[0]!.content,/未完成/);
    assert.equal((await client<CostSummary>(app,owner.access_token,'/costs/summary')).request_count,1);
    assert.equal((await client<ListResponse<Task>>(app,owner.access_token,'/tasks')).items.length,0);
  }finally{if(agent){await agent.stop();agent.close();}await app.close();rmSync(directory,{recursive:true,force:true});}
});
