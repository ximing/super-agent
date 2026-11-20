import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { RunContext, WireMessage } from '@super-agent/protocol';
import { NodeAgent } from '../src/agent.js';
import type { NodeConfig } from '../src/config.js';
import { ApiFailure, type NodeApi } from '../src/api.js';
import type { BrowserActor } from '@super-agent/tool-broker';
import { sleep, type RuntimeContext } from '@super-agent/tool-broker/runtime';

const config = (dir: string): NodeConfig => ({ server_url: 'https://control.example', name: 'Test Mac', device_id: 'device1', public_key: '', private_key_path: '', data_dir: dir, poll_interval_ms: 20, renew_interval_ms: 0, allow_shell: false, fake_runtime: true, codex: { enabled: true, command: 'codex', model: 'fake-test-model', sandbox: 'workspace-write' }, grok: { enabled: true, key_env: 'NONEXISTENT_TEST_KEY', model: 'fake-test-model', base_url: 'https://api.x.ai/v1' }, assistant: false });
const context: RunContext = {
  run: { id: 'run1', task_id: 'task1', state: 'starting', engine: 'codex', device_id: 'device1', model_id: 'fake-test-model', lease_epoch: '1', summary: '', created_at: '2026-11-18T00:00:00Z' },
  task: { id: 'task1', title: 'Test', goal: 'Exercise node lifecycle', status: 'running', reason_code: null, engine: 'codex', model_id: 'fake-test-model', device_id: 'device1', current_run_id: 'run1', created_at: '2026-11-18T00:00:00Z', updated_at: '2026-11-18T00:00:00Z', version: 1 },
  scope: {}, checkpoint: null, run_ticket: 'test-ticket', lease_valid_for_ms: 45000,
  budget: { grant_id: 'grant-run1', category: 'worker', limits: { max_total_tokens: 200_000, max_model_calls: 40, max_tool_steps: 80, max_runtime_ms: 1_200_000 }, money_treatment: 'unconfigured', in_flight_boundary: 'test', dollar_cap: 'not_enforced', status: 'reserved', expires_at: '2099-01-01T00:00:00.000Z', activity_id: 'run:run1', activity_kind: 'run', device_id: 'device1', executable: true },
};
const network = { source: 'direct' as const, proxied: false, restore() {}, reset() {} };

test('a slow frame does not stop command polling', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'super-agent-frames-'));
  let commands = 0, started = false, releaseFrame = () => {};
  const gate = new Promise<void>(resolve => { releaseFrame = resolve; });
  let frames = 0;
  const message: WireMessage = { protocol_version: '1.0', message_id: 'cmd1', kind: 'run.start', sent_at: '2026-11-18T00:00:00Z', payload: { command_id: 'cmd1', run_id: 'run1', device_id: 'device1', lease_epoch: '1' } };
  const api = { authenticate: async () => {}, request: async (path: string, body?: unknown) => {
    if (path === '/node/commands') { commands += 1; if (!started) { started = true; return { items: [message] }; } return { items: [] }; }
    if (path.endsWith('/accept')) return structuredClone(context);
    if (path.endsWith('/renew')) return { run_ticket: 'test-ticket', lease_valid_for_ms: 45000, capture: true };
    if (path === '/node/reports') return { accepted: ((body as { messages?: WireMessage[] })?.messages ?? []).map(item => item.message_id) };
    if (path === '/node/reconcile' || path === '/node/heartbeat' || path.includes('/capabilities')) return {};
    if (path.startsWith('/node/events')) return { items: [], cursor: '0' };
    if (path.endsWith('/frames')) { frames += 1; await gate; return {}; }
    return { items: [] };
  } } as unknown as NodeApi;
  const browser = { frame: async () => { frames += 1; await gate; return { frame_id: 'frame-1', width: 2, height: 2, image_base64: 'aa', captured_at: '2026-11-20T00:00:00Z', viewport_version: '1' }; }, release: async () => {} } as unknown as BrowserActor;
  const agent = new NodeAgent(config(dir), { api, browser, network, log: () => {}, runtimeFactory: async () => ({ execute: (input: RuntimeContext) => new Promise(resolve => { input.signal.addEventListener('abort', () => resolve({ text: 'stopped' })); }), steer: async () => {}, stop: async () => {} }) });
  const running = agent.start();
  try {
    for (let i = 0; i < 40 && frames < 1; i++) await sleep(25);
    const seen = commands;
    await sleep(120);
    assert.ok(frames >= 1);
    assert.ok(commands >= seen + 2);
  } finally { releaseFrame(); await agent.stop(); await running; agent.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('pause records delivered and applying before the model returns', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'super-agent-pause-'));
  let started = false, executeDone = false, stopCalled = false;
  const message: WireMessage = { protocol_version: '1.0', message_id: 'cmd1', kind: 'run.start', sent_at: '2026-11-18T00:00:00Z', payload: { command_id: 'cmd1', run_id: 'run1', device_id: 'device1', lease_epoch: '1' } };
  const api = { request: async (path: string, body?: unknown) => {
    if (path === '/node/commands') return { items: started ? [] : [message] };
    if (path.endsWith('/accept')) { started = true; return structuredClone(context); }
    if (path.endsWith('/renew')) return { run_ticket: 'test-ticket', lease_valid_for_ms: 45000, control: { action: 'pause', action_id: 'action-1' } };
    if (path === '/node/reports') return { accepted: ((body as { messages: WireMessage[] }).messages ?? []).map(item => item.message_id) };
    if (path.startsWith('/node/events') || path.endsWith('/checkpoint')) return { items: [], cursor: '0' };
    return {};
  } } as unknown as NodeApi;
  const agent = new NodeAgent(config(dir), { api, log: () => {}, runtimeFactory: async () => ({
    execute: async (input: RuntimeContext) => { await new Promise((resolve, reject) => { const timer = setTimeout(resolve, 5000); input.signal.addEventListener('abort', () => { clearTimeout(timer); reject(new DOMException('Stopped', 'AbortError')); }); }); executeDone = true; return { text: 'late' }; },
    steer: async () => {}, stop: async () => { stopCalled = true; },
  }) });
  try {
    await agent.tick();
    await sleep(20);
    const began = Date.now();
    await agent.tick();
    const progress = agent.store.pendingReports().filter(item => item.kind === 'action.progress').map(item => item.payload.status);
    assert.equal(stopCalled, true);
    assert.equal(executeDone, false);
    assert.ok(Date.now() - began < 1000);
    assert.deepEqual(progress, ['delivered', 'applying']);
  } finally { await agent.stop(); agent.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('claim 404 still plans, and a running journal is not executed again', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'super-agent-claim-'));
  const calls: string[] = [];
  const posted: Record<string, unknown>[] = [];
  let executes = 0;
  const inbox = [{ id: 'msg-1', role: 'user', content: '请只回复这一句', task_id: null, created_at: '2026-11-20T00:00:00Z' }];
  const api = { request: async (path: string, body?: unknown) => {
    calls.push(path);
    if (path === '/assistant/messages') posted.push(body as Record<string, unknown>);
    if (path === `/assistant/messages/msg-1/claim`) throw new ApiFailure(404, 'not_found', 'missing');
    if (path === '/assistant/inbox') return { items: inbox.length ? [inbox.shift()] : [] };
    if (path === '/assistant/lease/claim' || path === '/assistant/lease/renew') return { epoch: 'epoch-1', lease_valid_for_ms: 60_000 };
    if (path === '/assistant/context') return { messages: [], tasks: [], pending_plans: [] };
    if (path === '/assistant/plans') return { id: 'plan-1', state: 'draft', tasks: [] };
    if (path === '/node/devices') return { items: [{ id: 'device1' }] };
    if (path === '/assistant/messages') return {};
    if (path === '/assistant/events' || path === '/node/commands' || path.startsWith('/node/events')) return { items: [] };
    if (path === '/node/reports') return { accepted: ((body as { messages?: WireMessage[] })?.messages ?? []).map(item => item.message_id) };
    return {};
  } } as unknown as NodeApi;
  const cfg = config(dir); cfg.assistant = true;
  const agent = new NodeAgent(cfg, { api, log: () => {}, runtimeFactory: async () => { executes += 1; return { execute: async () => { throw new Error('MUST NOT REPLAY'); }, steer: async () => {}, stop: async () => {} }; } });
  agent.store.saveAssistant('msg-old', { phase: 'running', text: '', usage: [] });
  try {
    await agent.tick();
    for (let i = 0; i < 20 && !calls.includes('/assistant/plans'); i++) { await sleep(20); await agent.tick(); }
    assert.ok(calls.includes('/assistant/messages/msg-1/claim'));
    assert.ok(calls.includes('/assistant/plans'));
    assert.equal(posted.some(item => item.source_message_id === 'msg-old' && item.processing_outcome === 'interrupted'), true);
    assert.equal(executes, 1);
  } finally { await agent.stop(); agent.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('server fast path skips model execution and a disabled fast path answers status locally', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'super-agent-fast-'));
  const posted: Record<string, unknown>[] = [];
  let executes = 0;
  const scripts = [
    { capability: { protocol: '2026-11-20', chat_fast_path: true }, content: '暂停' },
    { capability: { protocol: '2026-11-20', chat_fast_path: false }, content: '进度呢' },
  ];
  for (const script of scripts) {
    const inbox = [{ id: `msg-${script.content}`, role: 'user', content: script.content, task_id: null, created_at: '2026-11-20T00:00:00Z' }];
    const api = { request: async (path: string, body?: unknown) => {
      if (path === '/capabilities') return script.capability;
      if (path === '/assistant/inbox') return { items: inbox.length ? [inbox.shift()] : [] };
      if (path === '/assistant/lease/claim' || path === '/assistant/lease/renew') return { epoch: 'epoch-1', lease_valid_for_ms: 60_000 };
      if (path === '/node/tasks') return { items: [] };
      if (path === '/assistant/messages') { posted.push(body as Record<string, unknown>); return {}; }
      if (path === '/assistant/events' || path === '/node/commands' || path.startsWith('/node/events')) return { items: [] };
      if (path === '/node/reports') return { accepted: [] };
      if (path === '/assistant/context' || path === '/assistant/plans') throw new Error('planner must not run');
      return {};
    } } as unknown as NodeApi;
    const cfg = config(dir); cfg.assistant = true;
    const agent = new NodeAgent(cfg, { api, log: () => {}, runtimeFactory: async () => { executes += 1; throw new Error('MUST NOT EXECUTE'); } });
    try {
      await agent.tick();
      await sleep(50);
      await agent.tick();
    } finally { await agent.stop(); agent.close(); }
  }
  assert.equal(executes, 0);
  assert.equal(posted.some(item => String(item.content ?? '').includes('当前没有进行中的任务')), true);
  assert.equal(posted.some(item => String(item.content ?? '').includes('暂停')), false);
  rmSync(dir, { recursive: true, force: true });
});
