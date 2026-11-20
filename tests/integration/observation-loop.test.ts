import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { buildApp, type ControlApp } from '../../apps/control-server/src/app.js';
import { observeDue } from '../../apps/control-server/src/observations.js';
import { Store } from '../../apps/control-server/src/store.js';
import { ApiFailure, NodeApi } from '../../apps/node/src/api.js';
import { NodeAgent } from '../../apps/node/src/agent.js';
import { initConfig, writeConfig, type NodeConfig } from '../../apps/node/src/config.js';
import { observationActivityId, type AuthSession, type BudgetGrant, type Capabilities, type ListResponse, type Task, type WireMessage } from '../../packages/protocol/src/index.js';
import type { RuntimeAdapter, RuntimeContext, RuntimeResult } from '@super-agent/tool-broker/runtime';
import { BrowserActor } from '../../packages/tool-broker/src/browser.js';
import { sleep } from '../../packages/tool-broker/src/runtime.js';

// Explicit opt-in cloud integration. Never start a database or fall back to production.
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
function fetchThroughInject(app: ControlApp, log: RequestLog[]): typeof fetch {
  return (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    assert.equal(url.origin, 'https://control.integration.invalid');
    const body = init.body ? JSON.parse(String(init.body)) as Record<string, unknown> : undefined;
    log.push({ path: url.pathname, body });
    const headers: Record<string, string> = {};
    new Headers(init.headers).forEach((value, key) => { headers[key] = value; });
    const cap = AbortSignal.timeout(8_000);
    const signal = init.signal ? AbortSignal.any([init.signal, cap]) : cap;
    const method = (init.method ?? 'GET').toUpperCase();
    const aborted = () => Object.assign(new Error(`AbortError ${method} ${url.pathname}`), { name: 'AbortError' });
    if (signal.aborted) throw aborted();
    const injected = app.inject({ method: method as never, url: `${url.pathname}${url.search}`, headers, ...(init.body === undefined ? {} : { payload: String(init.body) }) });
    const response = await new Promise<Awaited<ReturnType<ControlApp['inject']>>>((resolve, reject) => {
      const onAbort = () => reject(aborted());
      signal.addEventListener('abort', onAbort, { once: true });
      injected.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
    });
    return new Response(response.statusCode === 204 ? null : response.body, { status: response.statusCode, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
}

async function client<T>(app: ControlApp, token: string | undefined, path: string, method = 'GET', body?: unknown, headers: Record<string, string> = {}): Promise<T> {
  const response = await app.inject({ method: method as never, url: `/v1${path}`, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers }, ...(body === undefined ? {} : { payload: body }) });
  assert.ok(response.statusCode >= 200 && response.statusCode < 300, `${method} ${path}: HTTP ${response.statusCode}, ${response.body}`);
  return response.json<T>();
}

async function setupApp(): Promise<ControlApp> {
  assert.ok(runtimeUrl && migrationUrl, 'Both cloud test database URLs are required');
  const runtime = dedicatedCloudDatabase(runtimeUrl, 'TEST_DATABASE_URL'), migration = dedicatedCloudDatabase(migrationUrl, 'TEST_MIGRATION_DATABASE_URL');
  assert.equal(runtime.hostname, migration.hostname);
  assert.equal(runtime.pathname, migration.pathname);
  const owner = new Store(migrationUrl);
  try { await owner.migrate(); } finally { await owner.close(); }
  return buildApp({ databaseUrl: runtimeUrl, jwtSecret: 'integration-only-secret-with-at-least-32-bytes', allowDevAuth: true, runScheduler: false, recallAllowedOrigins: ['https://recall.integration.invalid'] });
}

async function pairNode(app: ControlApp, user: AuthSession, dir: string, fetcher: typeof fetch): Promise<{ config: NodeConfig; api: NodeApi }> {
  const path = join(dir, 'node.json');
  const config = await initConfig('https://control.integration.invalid', 'Observation integration Mac', path, true);
  config.assistant = false;
  config.browser = { enabled: true };
  const api = new NodeApi(config, fetcher);
  const pairing = await api.raw<{ pairing_id: string; code: string; polling_secret: string }>('/device-pairings', { name: config.name, public_key: config.public_key });
  await client(app, user.access_token, '/device-pairings/claim', 'POST', { code: pairing.code });
  const result = await api.raw<{ status: string; device_id: string; tenant_id: string }>('/device-pairings/poll', { pairing_id: pairing.pairing_id, polling_secret: pairing.polling_secret });
  assert.equal(result.status, 'claimed');
  config.device_id = result.device_id; config.tenant_id = result.tenant_id;
  await writeConfig(config, path);
  await api.authenticate();
  const caps: Capabilities = { generation: 1, engines: [{ engine: 'grok', ready: true, models: ['configured-default', 'fake-test-model'], local_profile_id: 'test-only', vision: 'unsupported', vision_reason: 'fixture does not see images' }], tools: ['browser'], slots: { browser: 1, worker: 1 } };
  await api.request(`/devices/${config.device_id}/capabilities`, caps, { method: 'PUT' });
  return { config, api };
}

class PageFixture extends BrowserActor {
  override humanActive(): boolean { return false; }
  override async call(): Promise<Record<string, unknown>> { return {}; }
  override async capture(): Promise<{ url: string; captured_at: string; snapshot: Record<string, unknown>; frame: null; bytes: null; source_uncertain: boolean; source_uncertain_reason: null }> {
    return { url: 'https://fixture.example/page', captured_at: new Date().toISOString(), snapshot: { marker: 'READY' }, frame: null, bytes: null, source_uncertain: false, source_uncertain_reason: null };
  }
  override async release(): Promise<void> {}
}

class ConditionRuntime implements RuntimeAdapter {
  calls = 0;
  async execute(context: RuntimeContext): Promise<RuntimeResult> {
    this.calls += 1;
    assert.equal(context.tools.length, 0, 'page observation must not expose tools');
    context.budget?.beforeModelCall();
    await context.emit({ type: 'usage', usage: { request_key: `observation:${context.runId}`, input_tokens: 4, cached_input_tokens: 0, output_tokens: 3, reasoning_tokens: 0, occurred_at: new Date().toISOString() } });
    return { text: '{"matched":true,"reason":"fixture marker READY"}' };
  }
  async steer(): Promise<void> {}
  async stop(): Promise<void> {}
  supportsVision(): boolean { return false; }
}

interface ObservationRule { id: string; version: number; last_status?: string; suggestions?: { id: string; status: string; reason: string; task_id?: string }[] }

test('cloud TEST: page observation reads a fixture page, judges with a fixture model, and confirms into a bounded task', { skip: !runtimeUrl || !migrationUrl, timeout: 120_000 }, async () => {
  const app = await setupApp(), directory = mkdtempSync(join(tmpdir(), 'super-agent-observation-'));
  const requestLog: RequestLog[] = [];
  const fetcher = fetchThroughInject(app, requestLog);
  const runtime = new ConditionRuntime();
  let agent: NodeAgent | undefined;
  try {
    const owner = await client<AuthSession>(app, undefined, '/auth/dev', 'POST', { email: `observe-${randomUUID()}@integration.invalid` });
    const paired = await pairNode(app, owner, directory, fetcher);
    agent = new NodeAgent(paired.config, { api: paired.api, browser: new PageFixture(), runtimeFactory: async () => runtime, log: () => {} });
    await agent.tick();
    const rule = await client<ObservationRule>(app, owner.access_token, '/observation-rules', 'POST', {
      title: '隔离页标记', goal: '标记出现后整理一句说明', device_id: paired.config.device_id, engine: 'grok',
      source: 'page', url: 'https://fixture.example/page', condition: '页面出现 READY', sites: ['fixture.example'], project: 'fixture', cooldown_minutes: 5,
    }, { 'idempotency-key': randomUUID() });
    await app.control.store.tenant(owner.user.tenant_id, tx => observeDue(tx));
    await agent.tick();
    await waitForRule(app, owner.access_token, rule.id, item => (item.suggestions ?? []).some(suggestion => suggestion.status === 'pending'));
    const matched = await client<{ items: ObservationRule[] }>(app, owner.access_token, '/observation-rules');
    const saved = matched.items.find(item => item.id === rule.id);
    assert.ok(saved);
    assert.equal(saved.last_status, 'matched');
    const suggestion = saved.suggestions?.find(item => item.status === 'pending');
    assert.ok(suggestion);
    assert.match(suggestion.reason, /实际记忆范围|fixture/);
    assert.equal(runtime.calls, 1);
    assert.equal(requestLog.some(entry => entry.path === '/v1/assistant/budget/reserve'), false);
    const reserve = requestLog.find(entry => entry.path.endsWith('/budget/reserve'));
    assert.ok(reserve, 'observation must reserve through the device observation route');
    assert.equal(reserve.body?.command_id !== undefined, true);
    assert.equal(typeof reserve.body?.config_version, 'number');
    const records = await client<{ items: { activity_id: string; category: string; cost?: { amount: null | string; source: string } }[] }>(app, owner.access_token, `/costs/records?device_id=${paired.config.device_id}`);
    const usage = records.items.filter(item => item.category === 'proactive');
    assert.equal(usage.length, 1);
    assert.equal(usage[0]?.cost?.amount, null);
    assert.equal(usage[0]?.cost?.source, 'unavailable');
    assert.match(usage[0]?.activity_id ?? '', /^proactive:observation:/);
    const confirmed = await client<{ task: Task }>(app, owner.access_token, `/observation-rules/${rule.id}/suggestions/${suggestion.id}`, 'POST', { action: 'confirm' }, { 'if-match': `"${saved.version}"`, 'idempotency-key': randomUUID() });
    const task = await client<Task>(app, owner.access_token, `/tasks/${confirmed.task.id}`);
    const scope = (task as Task & { scope?: { memory?: { sites?: string[]; project?: string | null; global_preference?: boolean } } }).scope?.memory;
    assert.deepEqual(scope?.sites, ['fixture.example']);
    assert.equal(scope?.project, 'fixture');
    assert.equal(scope?.global_preference, false);
    const again = await client<{ items: ObservationRule[] }>(app, owner.access_token, '/observation-rules');
    assert.equal(again.items.find(item => item.id === rule.id)?.suggestions?.filter(item => item.status === 'pending').length ?? 0, 0);
    await app.control.store.tenant(owner.user.tenant_id, tx => observeDue(tx));
    await agent.tick();
    assert.equal(runtime.calls, 1, 'cooldown must not run the model again');
  } finally {
    await agent?.stop(); agent?.close(); await app.close(); rmSync(directory, { recursive: true, force: true });
  }
});

test('cloud TEST: a second observation attempt is admitted, billed, and released on its own activity id', { skip: !runtimeUrl || !migrationUrl, timeout: 120_000 }, async () => {
  const app = await setupApp(), directory = mkdtempSync(join(tmpdir(), 'super-agent-observation-attempt-'));
  const fetcher = fetchThroughInject(app, []);
  try {
    const owner = await client<AuthSession>(app, undefined, '/auth/dev', 'POST', { email: `attempt-${randomUUID()}@integration.invalid` });
    const paired = await pairNode(app, owner, directory, fetcher);
    await paired.api.request('/node/heartbeat', {});
    const rule = await client<ObservationRule>(app, owner.access_token, '/observation-rules', 'POST', {
      title: '第二次尝试', goal: '只验证预算', device_id: paired.config.device_id, engine: 'grok',
      source: 'page', url: 'https://fixture.example/page', condition: 'READY', sites: ['fixture.example'], cooldown_minutes: 5,
    }, { 'idempotency-key': randomUUID() });
    await app.control.store.tenant(owner.user.tenant_id, tx => observeDue(tx));
    const commands = await paired.api.request<ListResponse<WireMessage>>('/node/commands');
    const command = commands.items.find(item => item.kind === 'observation.check');
    assert.ok(command);
    const commandId = String(command.payload.command_id ?? '');
    const configVersion = Number(command.payload.config_version);
    assert.equal(commandId.length > 0, true);
    assert.equal(Number.isInteger(configVersion), true);
    const root = observationActivityId(commandId);
    const first = await paired.api.request<BudgetGrant>(`/node/observations/${rule.id}/budget/reserve`, { command_id: commandId, config_version: configVersion });
    assert.equal(first.executable, true);
    assert.equal(first.activity_id, root);
    await paired.api.request(`/node/observations/${rule.id}/budget/release`, { command_id: commandId, activity_id: root, config_version: configVersion });
    const second = await paired.api.request<BudgetGrant>(`/node/observations/${rule.id}/budget/reserve`, { command_id: commandId, config_version: configVersion, new_attempt: true });
    assert.equal(second.executable, true);
    assert.equal(second.activity_id, `${root}#2`);
    assert.equal(second.prior_activity_id, root);
    await paired.api.request(`/node/observations/${rule.id}/budget/heartbeat`, { command_id: commandId, activity_id: second.activity_id, config_version: configVersion });
    const usage = { command_id: commandId, config_version: configVersion, activity_id: second.activity_id, request_key: 'attempt-2', usage_revision: 1, engine: 'grok', model_id: 'configured-default', input_tokens: 2, output_tokens: 1, cached_input_tokens: 0, reasoning_tokens: 0, occurred_at: new Date().toISOString(), cost: { source: 'unavailable', quality: 'missing', amount: null, currency: null, price_version_id: null } };
    await paired.api.request(`/node/observations/${rule.id}/usage`, usage);
    await paired.api.request(`/node/observations/${rule.id}/usage`, usage);
    await assert.rejects(
      () => paired.api.request(`/node/observations/${rule.id}/usage`, { ...usage, activity_id: root, request_key: 'root-must-not-book' }),
      (error: unknown) => error instanceof ApiFailure && error.status === 422 && error.code === 'activity_mismatch',
    );
    await paired.api.request(`/node/observations/${rule.id}/budget/release`, { command_id: commandId, activity_id: second.activity_id, config_version: configVersion });
    const records = await client<{ items: { activity_id: string; category: string; request_key: string; cost?: { amount: null | string; source: string } }[] }>(app, owner.access_token, `/costs/records?device_id=${paired.config.device_id}`);
    const billed = records.items.filter(item => item.request_key === 'attempt-2');
    assert.equal(billed.length, 1);
    assert.equal(billed[0]?.activity_id, `${root}#2`);
    assert.equal(billed[0]?.category, 'proactive');
    assert.equal(billed[0]?.cost?.amount, null);
    assert.equal(billed[0]?.cost?.source, 'unavailable');
    const replay = await paired.api.request<BudgetGrant>(`/node/observations/${rule.id}/budget/reserve`, { command_id: commandId, config_version: configVersion, new_attempt: true });
    assert.notEqual(replay.activity_id, `${root}#2`);
    assert.equal(replay.executable, true);
  } finally { await app.close(); rmSync(directory, { recursive: true, force: true }); }
});

async function waitForRule(app: ControlApp, token: string, id: string, ready: (rule: ObservationRule) => boolean): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < 15_000) {
    const listed = await client<{ items: ObservationRule[] }>(app, token, '/observation-rules');
    const rule = listed.items.find(item => item.id === id);
    if (rule && ready(rule)) return;
    await sleep(50);
  }
  throw new Error('observation rule did not reach the expected state within 15000ms');
}
