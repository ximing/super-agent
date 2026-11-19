import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GrokCliRuntime, probeGrokCli } from '../src/cli.js';
import { prepareManagedHome, managedArgs } from '../src/managed.js';
import { AcpClient, initializeParams } from '../src/acp.js';
import type { RuntimeContext, RuntimeEvent } from '@super-agent/tool-broker/runtime';

async function fixture() {
 const dir = await mkdtemp(join(tmpdir(), 'super-agent-grok-test-')), auth = join(dir, 'existing-auth');
 await writeFile(auth, 'TEST_AUTH_NOT_READ_BY_ADAPTER', { mode: 0o600 });
 const command = join(dir, 'grok');
 await writeFile(command, `#!/bin/sh\nexec '${process.execPath.replaceAll("'", "'\\''")}' '${new URL('./mock-acp.mjs', import.meta.url).pathname}'\n`, { mode: 0o700 });
 return { dir, auth, command, close: () => rm(dir, { recursive: true, force: true }) };
}
function context(events: RuntimeEvent[], calls: string[]): RuntimeContext {
 return { runId: 'r', taskId: 't', goal: 'Read fixture', modelId: '', cwd: '/tmp', tools: [{ name: 'files_read', description: 'Read', parameters: { type: 'object' } }], signal: new AbortController().signal, emit: e => { events.push(e); }, executeTool: async name => { calls.push(name); return { content: 'fixture' }; } };
}
test('native ACP authenticates local login and uses a restricted bridge without leaking thoughts or credentials', async () => {
 const f = await fixture(), events: RuntimeEvent[] = [], calls: string[] = [];
 try {
  const diagnostics: unknown[] = [], ctx = context(events, calls); ctx.modelId = 'selected-model';
  const result = await new GrokCliRuntime({ command: f.command, authPath: f.auth, onDiagnostic: item => diagnostics.push(item) }).execute(ctx);
  assert.deepEqual(diagnostics, [{ phase: 'spawn' }, { phase: 'initialize' }, { phase: 'authenticate' }, { phase: 'session_new' }, { phase: 'verify_mcp' }, { phase: 'prompt' }, { phase: 'notification', kind: 'agent_message_chunk' }, { phase: 'notification', kind: 'tool_call', tool: 'use_tool' }, { phase: 'notification', kind: 'agent_thought_chunk' }, { phase: 'notification', kind: 'agent_message_chunk' }, { phase: 'completed' }]);
  assert.equal(result.text, 'BROKER_RESULT_OK'); assert.deepEqual(calls, ['files_read']);
  const usage = events.find(e => e.type === 'usage'); assert.equal(usage?.type, 'usage');
  if (usage?.type === 'usage') { assert.match(usage.usage.request_key, /^grok-cli:[0-9a-f-]{36}$/); assert.deepEqual({ ...usage.usage, request_key: '<attempt>' }, { request_key: '<attempt>', input_tokens: 12, output_tokens: 3, cached_input_tokens: 4, reasoning_tokens: 0 }); }
  assert.equal(JSON.stringify(events).includes('PRIVATE_THOUGHT'), false);
  assert.equal(JSON.stringify(events).includes('TEST_AUTH'), false);
  assert.equal(await readFile(f.auth, 'utf8'), 'TEST_AUTH_NOT_READ_BY_ADAPTER');
 } finally { await f.close(); }
});
test('native ACP fails closed on effective external MCP, and provider RPC errors are redacted', async () => {
 const f = await fixture();
 try {
  process.env.SUPER_AGENT_GROK_MOCK_MODE = 'old-version';
  await assert.rejects(new GrokCliRuntime({ command: f.command, authPath: f.auth }).execute(context([], [])), /^Error: grok_cli_version_incompatible$/);
  process.env.SUPER_AGENT_GROK_MOCK_MODE = 'external';
  await assert.rejects(new GrokCliRuntime({ command: f.command, authPath: f.auth }).execute(context([], [])), /^Error: grok_cli_unmanaged_mcp_detected$/);
  process.env.SUPER_AGENT_GROK_MOCK_MODE = 'error';
  await assert.rejects(new GrokCliRuntime({ command: f.command, authPath: f.auth }).execute(context([], [])), /^Error: grok_cli_rpc_-32001$/);
 } finally { delete process.env.SUPER_AGENT_GROK_MOCK_MODE; await f.close(); }
});
test('native ACP supports mid-turn steering, cancellation and total deadline', async () => {
 const f = await fixture(); process.env.SUPER_AGENT_GROK_MOCK_MODE = 'wait';
 try {
  let ready!: () => void;
  const started = new Promise<void>(r => { ready = r; }), ctx = context([], []);
  ctx.emit = e => { if (e.type === 'binding') ready(); };
  const runtime = new GrokCliRuntime({ command: f.command, authPath: f.auth });
  const work = runtime.execute(ctx); await started;
  // Wait for the prompt, after the binding emit's continuation.
  await new Promise(r => setTimeout(r, 30)); await runtime.steer('Additional authorized input');
  assert.equal((await work).text, 'BROKER_RESULT_OK');
  const cancelled = new GrokCliRuntime({ command: f.command, authPath: f.auth });
  const executing = cancelled.execute(context([], []));
  await new Promise(r => setTimeout(r, 100)); await cancelled.stop();
  await assert.rejects(executing, { name: 'AbortError' });
  await assert.rejects(new GrokCliRuntime({ command: f.command, authPath: f.auth, maxRunMs: 100 }).execute(context([], [])), { name: 'AbortError' });
 } finally { delete process.env.SUPER_AGENT_GROK_MOCK_MODE; await f.close(); }
});
test('managed discovery keeps HOME and original auth store while disabling vendor imports', async () => {
 const f = await fixture(), originalHome = process.env.HOME;
 const managed = await prepareManagedHome({ authPath: f.auth, systemPolicyDir: join(f.dir, 'no-system-policy') });
 try {
  assert.equal(managed.env.HOME, originalHome); assert.equal(managed.env.GROK_AUTH_PATH, await realpath(f.auth));
  assert.equal((await stat(managed.directory)).mode & 0o777, 0o700);
  assert.equal(managed.env.GROK_CLAUDE_HOOKS_ENABLED, '0');
  assert.equal(managed.env.GROK_CURSOR_MCPS_ENABLED, '0');
  assert.equal(managed.env.GROK_MEMORY, '0');
  assert.equal(managed.env.GROK_MANAGED_MCP_GATEWAY_TOOLS_ENABLED, '0');
  assert.equal(managed.env.GROK_WORKFLOWS, '0');
  const config = await readFile(join(managed.directory, 'config.toml'), 'utf8');
  assert.match(config, /load_envrc = false/);
  assert.match(config, /Read\(\*\*\)/);
  assert.ok(managedArgs.includes('Read(**)'));
  assert.equal(managedArgs.includes('Read'), false);
  assert.match(config, /MCPTool\(super_agent__\*\)/);
  const client = new AcpClient(f.command, [...managedArgs], managed.env, managed.cwd);
  try { await client.request('initialize', initializeParams()); assert.deepEqual(await client.request('test-permission', {}), {}); }
  finally { await client.close(); }
 } finally { await managed.close(); await f.close(); }
});

test('readiness authenticates only the existing headless cache and redacts invalid authentication', async () => {
 const f = await fixture(), previousAuthPath = process.env.GROK_AUTH_PATH;
 process.env.GROK_AUTH_PATH = f.auth;
 try {
  assert.deepEqual(await probeGrokCli(f.command), { ready: true, models: ['configured-default'], version: '1.0.89' });
  process.env.SUPER_AGENT_GROK_MOCK_MODE = 'auth-invalid';
  const result = await probeGrokCli(f.command);
  assert.deepEqual(result, { ready: false, models: [], reason: 'grok_cli_local_login_unavailable' });
  assert.doesNotMatch(JSON.stringify(result), /SECRET|32077|TOKEN/);
 } finally {
  delete process.env.SUPER_AGENT_GROK_MOCK_MODE;
  if (previousAuthPath === undefined) delete process.env.GROK_AUTH_PATH; else process.env.GROK_AUTH_PATH = previousAuthPath;
  await f.close();
 }
});

test('failed initialization/auth/tool checks do not record model attempts, but lost prompt replies do', async () => {
 const f = await fixture();
 try {
  for (const mode of ['old-version', 'auth-invalid', 'external']) {
   process.env.SUPER_AGENT_GROK_MOCK_MODE = mode;
   const events: RuntimeEvent[] = [];
   await assert.rejects(new GrokCliRuntime({ command: f.command, authPath: f.auth }).execute(context(events, [])));
   assert.equal(events.filter(e => e.type === 'usage').length, 0, mode);
  }
  process.env.SUPER_AGENT_GROK_MOCK_MODE = 'error';
  const events: RuntimeEvent[] = [];
  await assert.rejects(new GrokCliRuntime({ command: f.command, authPath: f.auth }).execute(context(events, [])), /grok_cli_rpc_-32001/);
  const usage = events.filter(e => e.type === 'usage'); assert.equal(usage.length, 1);
  assert.match(usage[0]!.usage.request_key, /^grok-cli:[0-9a-f-]{36}$/);
  assert.deepEqual({ ...usage[0]!.usage, request_key: '<attempt>' }, { request_key: '<attempt>', input_tokens: null, cached_input_tokens: null, output_tokens: null, reasoning_tokens: null });
 } finally { delete process.env.SUPER_AGENT_GROK_MOCK_MODE; await f.close(); }
});

test('cancelled prompts preserve one usage record, retaining known counters or an unknown placeholder', async () => {
 const f = await fixture();
 try {
  process.env.SUPER_AGENT_GROK_MOCK_MODE = 'cancel-with-usage';
  const known: RuntimeEvent[] = [];
  await assert.rejects(new GrokCliRuntime({ command: f.command, authPath: f.auth }).execute(context(known, [])), /grok_cli_cancelled/);
  const usage = known.filter(e => e.type === 'usage'); assert.equal(usage.length, 1);
  assert.equal(usage[0]!.usage.input_tokens, 8); assert.equal(usage[0]!.usage.output_tokens, 2);
  process.env.SUPER_AGENT_GROK_MOCK_MODE = 'wait';
  const lost: RuntimeEvent[] = [];
  let promptSent!: () => void; const sent = new Promise<void>(r => { promptSent = r; });
  const ctx = context(lost, []);
  const withDiagnostics = new GrokCliRuntime({ command: f.command, authPath: f.auth, onDiagnostic: d => { if (d.phase === 'prompt') promptSent(); } });
  const work = withDiagnostics.execute(ctx); await sent;
  await withDiagnostics.stop();
  await assert.rejects(work, { name: 'AbortError' });
  const unknown = lost.filter(e => e.type === 'usage'); assert.equal(unknown.length, 1);
  assert.equal(unknown[0]!.usage.input_tokens, null); assert.equal(unknown[0]!.usage.output_tokens, null);
  assert.notEqual(unknown[0]!.usage.request_key, usage[0]!.usage.request_key);
 } finally { delete process.env.SUPER_AGENT_GROK_MOCK_MODE; await f.close(); }
});
