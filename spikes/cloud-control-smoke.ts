/** Opt-in public TEST API smoke. No local listener/database or real model invocation. */
import { createHash, generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { AuthSession, CostSummary, Device, ListResponse, PairingResult, PairingStart, Run, Task, WireMessage } from '../packages/protocol/src/index.js';
import { NodeAgent } from '../apps/node/src/agent.js';
import { NodeApi } from '../apps/node/src/api.js';
import type { NodeConfig } from '../apps/node/src/config.js';
import { FakeRuntime } from '../apps/node/src/fake-runtime.js';

class SmokeFailure extends Error {}
class HttpFailure extends SmokeFailure { constructor(readonly status: number, readonly code: string, message: string) { super(message); } }
function check(value: unknown, message: string): asserts value { if (!value) throw new SmokeFailure(message); }
function url(value: string, label: string): URL {
  try { return new URL(value); } catch { throw new SmokeFailure(`${label} is not a valid URL.`); }
}
function publicHttps(value: string, label: string): URL {
  const parsed = url(value, label);
  check(parsed.protocol === 'https:' && !!parsed.hostname && !parsed.username && !parsed.password && !parsed.search && !parsed.hash && !/^(localhost|0\.0\.0\.0|\[?::1\]?|host\.docker\.internal)$/i.test(parsed.hostname) && !/^127\./.test(parsed.hostname) && !/\.localhost$/i.test(parsed.hostname), `${label} must be public HTTPS without URL credentials or query values.`);
  return parsed;
}
const form = (value: Record<string, string>) => new URLSearchParams(value);
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
const clientId = 'super-agent-native', redirectUri = 'superagent://oauth/callback';
const id = (value: unknown): value is string => typeof value === 'string' && /^[a-z0-9-]{8,80}$/i.test(value);
function token(body: unknown): string {
  const result = (body as { access_token?: unknown })?.access_token;
  check(typeof result === 'string' && result.length > 0, 'Token endpoint returned no access token.'); return result;
}
async function request(target: string, options: RequestInit = {}): Promise<Response> {
  return fetch(target, { ...options, redirect: 'manual', signal: AbortSignal.timeout(20_000) });
}
interface RecallBinding { url: string; token: string }
interface MemorySettings { configured: boolean; version: number }
interface UsageRecord { id: string; run_id: string; request_key: string; input_tokens: number; output_tokens: number; cost: { source: string; amount: string | null; currency: string | null } }
interface Trace {
  commands: WireMessage[]; reports: WireMessage[]; accepts: number; authentications: number; memorySearches: number;
}
async function run(): Promise<void> {
  const missing = ['OIDC_ADMIN_USERNAME', 'OIDC_ADMIN_PASSWORD', 'RECALL_BINDING_FILE'].filter(key => !process.env[key]);
  check(missing.length === 0, `Missing configuration: ${missing.join(', ')}. No requests were made.`);
  const origin = publicHttps(process.env.CONTROL_SERVER_URL ?? 'https://super-agent.aimo.plus', 'CONTROL_SERVER_URL');
  check(origin.pathname === '/' || origin.pathname === '', 'CONTROL_SERVER_URL must be an origin without a path.');
  const base = origin.origin;
  // This public, unauthenticated read must be the first request. Never create fixtures on prod.
  const authConfigResponse = await request(`${base}/v1/auth/config`);
  check(authConfigResponse.status === 200, 'TEST API authentication configuration unavailable.');
  const authConfig = await authConfigResponse.json() as { mode?: string; issuer?: string; client_id?: string };
  check(authConfig.mode === 'oidc' && typeof authConfig.issuer === 'string', 'TEST API must use OIDC; no fixture was created.');
  const issuer = publicHttps(authConfig.issuer, 'Configured OIDC issuer');
  const realmMatch = /^(.*)\/realms\/(aimo-plus-test)\/?$/.exec(issuer.pathname);
  check(realmMatch && !/prod/i.test(issuer.pathname), 'Refusing API whose issuer is not the exact aimo-plus-test realm.');
  const issuerUrl = issuer.href.replace(/\/$/, '');
  if (process.env.OIDC_ISSUER) check(process.env.OIDC_ISSUER.replace(/\/$/, '') === issuerUrl, 'OIDC_ISSUER differs from the verified TEST API issuer.');
  check(!authConfig.client_id || authConfig.client_id === clientId, 'TEST API native OIDC client does not match this smoke.');
  const keycloakBase = issuer.origin + realmMatch[1], realm = realmMatch[2]!;
  const binding = JSON.parse(await readFile(process.env.RECALL_BINDING_FILE!, 'utf8')) as RecallBinding;
  check(typeof binding.url === 'string' && typeof binding.token === 'string' && binding.token.trim().length > 0, 'RECALL_BINDING_FILE requires url and token.');
  publicHttps(binding.url, 'Recall URL');
  process.stdout.write('Verified public TEST API issuer; production execution is refused.\n');
  const adminHeaders = async () => {
    const response = await request(`${keycloakBase}/realms/master/protocol/openid-connect/token`, { method: 'POST', body: form({ grant_type: 'password', client_id: 'admin-cli', username: process.env.OIDC_ADMIN_USERNAME!, password: process.env.OIDC_ADMIN_PASSWORD! }) });
    check(response.status === 200, 'TEST OIDC administrator authentication failed.');
    return { authorization: `Bearer ${token(await response.json())}`, 'content-type': 'application/json' };
  };
  const headers = await adminHeaders();
  const usersEndpoint = `${keycloakBase}/admin/realms/${realm}/users`;
  const username = `cloud-smoke-${randomUUID()}`, email = `${username}@example.invalid`, password = randomBytes(32).toString('base64url');
  let userLocation: string | undefined, created = false, session: AuthSession | undefined;
  let config: NodeConfig | undefined, agent: NodeAgent | undefined, tempDir: string | undefined, taskId: string | undefined;
  let bindingInstalled = false, failed = false;
  async function product<T>(path: string, body?: unknown, options: { method?: string; version?: number; key?: string; authenticated?: boolean; expected?: number } = {}): Promise<T> {
    const response = await request(`${base}/v1${path}`, { method: options.method ?? (body === undefined ? 'GET' : 'POST'), headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(options.authenticated !== false && session ? { authorization: `Bearer ${session.access_token}` } : {}), ...(options.version !== undefined ? { 'if-match': `"${options.version}"` } : {}), ...(body !== undefined ? { 'idempotency-key': options.key ?? randomUUID() } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    if (response.status !== (options.expected ?? 200)) {
      let code = 'http_error';
      try { const data = await response.clone().json() as { code?: unknown; error?: { code?: unknown } }; const candidate = data.error?.code ?? data.code; if (typeof candidate === 'string' && /^[A-Za-z][A-Za-z0-9_]{0,79}$/.test(candidate)) code = candidate; } catch { /* Never expose arbitrary error bodies. */ }
      throw new HttpFailure(response.status, code, `Public TEST API ${options.method ?? (body === undefined ? 'GET' : 'POST')} ${path.split('?')[0]} returned HTTP ${response.status}, code=${code}.`);
    }
    return response.status === 204 ? {} as T : await response.json() as T;
  }
  try {
    const create = await request(usersEndpoint, { method: 'POST', headers, body: JSON.stringify({ username, enabled: true, email, emailVerified: true, firstName: 'Cloud Smoke', lastName: 'Test', credentials: [{ type: 'password', value: password, temporary: false }] }) });
    check(create.status === 201, 'Temporary TEST OIDC account creation failed.'); created = true;
    const location = create.headers.get('location');
    if (location) { const candidate = url(location, 'TEST user location'); if (candidate.origin === issuer.origin && candidate.pathname.startsWith(new URL(usersEndpoint).pathname + '/') && !candidate.search && !candidate.hash) userLocation = candidate.href; }
    check(userLocation, 'Temporary TEST account location unavailable or outside the TEST realm.');
    const verifier = randomBytes(48).toString('base64url'), state = randomBytes(24).toString('base64url');
    const authorization = await request(`${issuerUrl}/protocol/openid-connect/auth?${form({ client_id: clientId, redirect_uri: redirectUri, response_type: 'code', scope: 'openid profile email', state, code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256' })}`);
    check(authorization.status === 200, 'TEST OIDC S256 login form unavailable.');
    const cookie = authorization.headers.getSetCookie().map(value => value.split(';', 1)[0]).join('; ');
    const action = /<form[^>]+action="([^"]+)"/i.exec(await authorization.text())?.[1]?.replaceAll('&amp;', '&');
    check(action, 'TEST OIDC login action missing.');
    const loginUrl = url(action, 'TEST login action');
    check(loginUrl.origin === issuer.origin && loginUrl.pathname.startsWith(issuer.pathname.replace(/\/$/, '') + '/'), 'TEST OIDC login action outside TEST issuer.');
    const login = await request(loginUrl.href, { method: 'POST', headers: { cookie }, body: form({ username, password, credentialId: '' }) });
    check(login.status === 302 && login.headers.get('location'), 'TEST OIDC login did not redirect.');
    const callback = url(login.headers.get('location')!, 'OIDC callback');
    check(`${callback.protocol}//${callback.host}${callback.pathname}` === redirectUri && !callback.hash && callback.searchParams.get('state') === state && callback.searchParams.has('code') && !callback.searchParams.has('error'), 'OIDC callback URI/state/code verification failed.');
    const tokens = await request(`${issuerUrl}/protocol/openid-connect/token`, { method: 'POST', body: form({ grant_type: 'authorization_code', client_id: clientId, redirect_uri: redirectUri, code: callback.searchParams.get('code')!, code_verifier: verifier }) });
    check(tokens.status === 200, 'TEST OIDC authorization code exchange failed.');
    session = await product<AuthSession>('/auth/exchange', { access_token: token(await tokens.json()) }, { authenticated: false });
    check(typeof session.access_token === 'string' && session.user?.email === email, 'Product login identity differs from temporary TEST user.');
    const me = await product<{ email: string }>('/me'); check(me.email === email, 'Public API product session identity mismatch.');
    process.stdout.write('PASS: actual public HTTPS OIDC S256 login and product token exchange.\n');

    const previousMemory = await product<MemorySettings>('/settings/memory');
    check(!previousMemory.configured && previousMemory.version === 0, 'New temporary tenant already has a memory binding; refusing to replace it.');
    // Even an ambiguous network failure may have persisted the binding; always inspect/delete it in finally.
    bindingInstalled = true; await product<MemorySettings>('/settings/memory', binding, { method: 'PUT' });
    const memorySettings = await product<MemorySettings>('/settings/memory'); check(memorySettings.configured && memorySettings.version > 0, 'Temporary tenant Recall binding was not persisted.');
    // Read-only inventory is not printed; no existing Recall memory is written or deleted.
    await product<ListResponse<unknown>>('/memories?limit=1');

    tempDir = await mkdtemp(join(tmpdir(), 'super-agent-public-test-')); await chmod(tempDir, 0o700);
    const keys = generateKeyPairSync('ed25519', { privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
    const privatePath = join(tempDir, 'device-key.pem'); await writeFile(privatePath, keys.privateKey, { mode: 0o600, flag: 'wx' });
    config = { server_url: base, name: `Public TEST FakeRuntime ${username.slice(-8)}`, public_key: keys.publicKey, private_key_path: privatePath, data_dir: tempDir, poll_interval_ms: 150, renew_interval_ms: 1000, allow_shell: false, fake_runtime: true, codex: { enabled: true, command: process.execPath, model: 'fake-test-model', sandbox: 'workspace-write' }, grok: { enabled: false, key_env: `UNSET_SMOKE_${randomUUID().replaceAll('-', '')}`, model: 'fake-test-model', base_url: 'https://api.x.ai/v1' }, assistant: false };
    const trace: Trace = { commands: [], reports: [], accepts: 0, authentications: 0, memorySearches: 0 };
    const observedFetch: typeof fetch = async (input, init) => {
      const path = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url).pathname;
      const response = await fetch(input, init);
      if (response.ok) {
        if (path.endsWith('/devices/auth/token')) trace.authentications++;
        if (path.endsWith('/accept')) trace.accepts++;
        if (path.endsWith('/node/memory/search')) trace.memorySearches++;
        if (path.endsWith('/node/commands')) { const data = await response.clone().json() as ListResponse<WireMessage>; trace.commands.push(...data.items); }
        if (path.endsWith('/node/reports')) { const sent = JSON.parse(String(init?.body)) as { messages: WireMessage[] }; trace.reports.push(...sent.messages); }
      }
      return response;
    };
    let nodeApi = new NodeApi(config, observedFetch);
    const pairing = await nodeApi.raw<PairingStart>('/device-pairings', { name: config.name, public_key: config.public_key });
    const claim = await product<{ device_id: string }>('/device-pairings/claim', { code: pairing.code });
    check(id(claim.device_id), 'Device pairing claim returned an invalid identifier.'); config.device_id = claim.device_id;
    const paired = await nodeApi.raw<PairingResult>('/device-pairings/poll', { pairing_id: pairing.pairing_id, polling_secret: pairing.polling_secret });
    check(paired.status === 'claimed' && paired.device_id === config.device_id && paired.tenant_id === session.user.tenant_id, 'Device pairing poll did not match this temporary tenant.'); config.tenant_id = paired.tenant_id;
    let runtimeCalls = 0;
    const options = { api: nodeApi, log: (_message: string) => {}, runtimeFactory: async () => { runtimeCalls++; return new FakeRuntime(); } };
    agent = new NodeAgent(config, options);
    await nodeApi.authenticate();
    await nodeApi.request(`/devices/${config.device_id}/capabilities`, await agent.capabilities(), { method: 'PUT' });
    await agent.recover(); await agent.tick();
    check(trace.authentications > 0, 'Actual Ed25519 device authentication was not observed.');
    process.stdout.write('PASS: real pairing, claim, Ed25519 challenge, capability registration and SQLite node journal.\n');
    const goal = 'Public TEST explicit FakeRuntime: perform read-only memory search and write a local test result; do not change any company website or existing memory.';
    const task = await product<Task>('/tasks', { title: 'Public TEST FakeRuntime lifecycle', goal, engine: 'codex', device_id: config.device_id, model_id: 'fake-test-model' });
    check(id(task.id), 'Public TEST task returned an invalid identifier.'); taskId = task.id;
    let completed: Task | undefined;
    const deadline = Date.now() + 120_000;
    while (Date.now() < deadline) {
      await agent.tick();
      const current = await product<Task>(`/tasks/${task.id}`);
      if (current.status === 'succeeded') { completed = current; break; }
      check(!['failed', 'cancelled', 'paused', 'awaiting_review'].includes(current.status), `Public TEST task ended unexpectedly in ${current.status}.`);
      await sleep(250);
    }
    check(completed?.current_run_id, 'Public TEST task did not complete before the deadline.');
    await agent.flush();
    const runId = completed.current_run_id;
    const runs = await product<ListResponse<Run>>(`/tasks/${task.id}/runs`);
    check(runs.items.length === 1 && runs.items[0]?.id === runId && runs.items[0]?.state === 'succeeded' && runs.items[0]?.summary.includes('[FakeRuntime'), 'Public API run/result does not match the single FakeRuntime execution.');
    check(runtimeCalls === 1 && trace.accepts === 1 && trace.memorySearches === 1, 'Task did not accept/execute/search memory exactly once.');
    check(agent.store.run(runId)?.state === 'succeeded', 'SQLite journal did not persist succeeded state.');
    const result = await readFile(join(tempDir, 'workspaces', task.id, runId, 'test-result.txt'), 'utf8');
    check(result === `Explicit FakeRuntime result for: ${goal}`, 'Actual local FakeRuntime output differs from the assigned goal.');
    const records = await product<ListResponse<UsageRecord>>(`/costs/records?task_id=${task.id}`);
    check(records.items.length === 1 && records.items[0]?.run_id === runId && records.items[0]?.cost.source === 'unavailable' && records.items[0]?.cost.amount === null && records.items[0]?.cost.currency === null && records.items[0]?.input_tokens === 10 && records.items[0]?.output_tokens === 5, 'Public API usage must preserve unknown cost and exact FakeRuntime tokens.');
    const summary = await product<CostSummary>(`/costs/summary?task_id=${task.id}`);
    check(summary.request_count === 1 && summary.unknown_count === 1 && summary.totals.length === 0, 'Unknown costs were duplicated or synthesized as money in the API summary.');
    process.stdout.write('PASS: real dispatch, accept, scoped Recall read-only search, result/checkpoint and unknown-cost accounting.\n');

    const command = trace.commands.find(item => item.kind === 'run.start' && item.payload.run_id === runId);
    check(command, 'Actual delivered run command was not captured for restart verification.');
    const reports = trace.reports.filter(item => item.payload.run_id === runId);
    check(reports.some(item => item.kind === 'usage.report'), 'No actual usage report was captured for deduplication.');
    await agent.stop(); agent.close(); agent = undefined;
    nodeApi = new NodeApi(config, observedFetch);
    agent = new NodeAgent(config, { ...options, api: nodeApi });
    await nodeApi.authenticate();
    await nodeApi.request(`/devices/${config.device_id}/capabilities`, await agent.capabilities(), { method: 'PUT' });
    await agent.recover();
    // Replay the genuine persisted wire envelope into the durable inbox after a process restart.
    check(agent.store.command(command) === 'duplicate', 'Restarted SQLite inbox failed to deduplicate the original command.');
    agent.store.enqueue('command.ack', { command_id: command.payload.command_id, device_id: config.device_id, status: 'duplicate' });
    await agent.flush();
    // Replay genuine reports to the actual cloud endpoint; never replace API responses with mocks.
    const replay = await nodeApi.request<{ accepted: string[]; rejected?: unknown[] }>('/node/reports', { messages: reports });
    check(!replay.rejected?.length && reports.every(report => replay.accepted.includes(report.message_id)), 'Cloud endpoint did not acknowledge original report replay idempotently.');
    for (let i = 0; i < 3; i++) { await agent.tick(); await sleep(100); }
    const afterRuns = await product<ListResponse<Run>>(`/tasks/${task.id}/runs`);
    const afterRecords = await product<ListResponse<UsageRecord>>(`/costs/records?task_id=${task.id}`);
    const afterSummary = await product<CostSummary>(`/costs/summary?task_id=${task.id}`);
    const afterTask = await product<Task>(`/tasks/${task.id}`);
    check(runtimeCalls === 1 && trace.accepts === 1 && afterRuns.items.length === 1 && afterTask.status === 'succeeded' && afterTask.current_run_id === runId && agent.store.run(runId)?.state === 'succeeded', 'Restart caused task/run reexecution or state regression.');
    check(afterRecords.items.length === 1 && afterRecords.items[0]?.id === records.items[0]?.id && afterSummary.request_count === 1 && afterSummary.unknown_count === 1 && afterSummary.totals.length === 0, 'Replayed real reports duplicated cost records.');
    process.stdout.write('PASS: SQLite restart command dedupe, real report replay and public API run/cost invariants.\n');
  } catch (error) { failed = true; throw error; }
  finally {
    let cleanupFailed = false;
    const cleanup = async (label: string, action: () => Promise<void>) => { try { await action(); } catch (error) { cleanupFailed = true; const diagnostic = error instanceof HttpFailure ? ` HTTP ${error.status}, code=${error.code};` : ''; process.stderr.write(`Cleanup failed: ${label};${diagnostic} inspect only the cloud-smoke-* TEST fixture privately.\n`); } };
    if (agent) await cleanup('local test node', async () => { try { await agent!.stop(); } finally { agent!.close(); } });
    if (session) {
      if (taskId) await cleanup('unfinished test task', async () => { const task = await product<Task>(`/tasks/${taskId}`); if (!['succeeded', 'cancelled', 'failed'].includes(task.status)) await product(`/tasks/${taskId}/actions`, { action: 'cancel' }, { version: task.version }); });
      if (bindingInstalled) await cleanup('temporary Recall binding', async () => { const settings = await product<MemorySettings>('/settings/memory'); if (settings.configured) await product('/settings/memory', undefined, { method: 'DELETE', version: settings.version }); });
      if (config?.device_id) await cleanup('temporary device revocation', async () => { const devices = await product<ListResponse<Device>>('/devices'); const device = devices.items.find(item => item.id === config!.device_id); if (device) await product(`/devices/${device.id}`, undefined, { method: 'DELETE', version: device.version }); });
      await cleanup('product session revocation', async () => { await product('/auth/logout', {}); await product('/me', undefined, { expected: 401 }); });
    }
    if (created) await cleanup('temporary OIDC account', async () => {
      const freshHeaders = await adminHeaders();
      if (!userLocation) { const lookup = await request(`${usersEndpoint}?username=${encodeURIComponent(username)}&exact=true`, { headers: freshHeaders }); check(lookup.status === 200, 'Fixture cleanup lookup failed.'); const users = await lookup.json() as { id: string; username: string }[]; const fixture = users.find(user => user.username === username && id(user.id)); check(fixture, 'Fixture cleanup user missing.'); userLocation = `${usersEndpoint}/${fixture.id}`; }
      const response = await request(userLocation, { method: 'DELETE', headers: freshHeaders }); check([204, 404].includes(response.status), 'Fixture cleanup delete failed.');
    });
    if (tempDir) await cleanup('temporary local device key/journal', async () => { await rm(tempDir!, { recursive: true, force: true }); });
    if (!cleanupFailed) process.stdout.write('Temporary Recall binding removed; device/session revoked; TEST OIDC account and local identity removed.\n');
    if (cleanupFailed && !failed) throw new SmokeFailure('Public TEST smoke cleanup was incomplete.');
  }
}
try { await run(); }
catch (error) {
  // Never print arbitrary provider, HTTP body, SQLite or filesystem exceptions containing secrets.
  process.stderr.write(`${error instanceof SmokeFailure ? error.message : 'Public TEST smoke failed; inspect private configuration without logging credentials.'}\n`);
  process.exitCode = 1;
}
