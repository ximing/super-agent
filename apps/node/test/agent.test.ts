import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { RunContext, WireMessage } from '@super-agent/protocol';
import { NodeAgent } from '../src/agent.js';
import type { NodeConfig } from '../src/config.js';
import { ApiFailure, type NodeApi } from '../src/api.js';
import { FakeRuntime } from '../src/fake-runtime.js';
import { sleep, type RuntimeContext, type RuntimeResult } from '@super-agent/tool-broker/runtime';

const config = (dir: string): NodeConfig => ({ server_url: 'https://control.example', name: 'Test Mac', device_id: 'device1', public_key: '', private_key_path: '', data_dir: dir, poll_interval_ms: 20, allow_shell: false, fake_runtime: true, codex: { enabled: true, command: 'codex', model: 'fake-test-model', sandbox: 'workspace-write' }, grok: { enabled: true, key_env: 'NONEXISTENT_TEST_KEY', model: 'fake-test-model', base_url: 'https://api.x.ai/v1' }, assistant: false });
const context: RunContext = {
  run: { id: 'run1', task_id: 'task1', state: 'starting', engine: 'codex', device_id: 'device1', model_id: 'fake-test-model', lease_epoch: '1', summary: '', created_at: '2026-11-18T00:00:00Z' },
  task: { id: 'task1', title: 'Test', goal: 'Exercise node lifecycle', status: 'running', reason_code: null, engine: 'codex', model_id: 'fake-test-model', device_id: 'device1', current_run_id: 'run1', created_at: '2026-11-18T00:00:00Z', updated_at: '2026-11-18T00:00:00Z', version: 1 },
  scope: {}, checkpoint: null, run_ticket: 'test-ticket', lease_valid_for_ms: 45000,
  budget: { grant_id: 'grant-run1', category: 'worker', limits: { max_total_tokens: 200_000, max_model_calls: 40, max_tool_steps: 80, max_runtime_ms: 1_200_000 }, money_treatment: 'unconfigured', in_flight_boundary: 'test', dollar_cap: 'not_enforced', status: 'reserved', expires_at: '2099-01-01T00:00:00.000Z', activity_id: 'run:run1', activity_kind: 'run', device_id: 'device1', executable: true },
};

test('node accepts once, runs explicit FakeRuntime, persists result and flushes status/unknown cost', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'super-agent-node-'));
  let acceptCount = 0;
  const reports: WireMessage[] = [], checkpoints: unknown[] = [];
  const message: WireMessage = { protocol_version: '1.0', message_id: 'cmd1', kind: 'run.start', sent_at: '2026-11-18T00:00:00Z', payload: { command_id: 'cmd1', run_id: 'run1', device_id: 'device1', lease_epoch: '1' } };
  const api = {
    authenticate: async () => {},
    request: async (path: string, body?: unknown) => {
      if (path === '/node/commands') return { items: [message] };
      if (path.endsWith('/accept')) { acceptCount++; return structuredClone(context); }
      if (path === '/node/reports') { const messages = (body as { messages: WireMessage[] }).messages; reports.push(...messages); return { accepted: messages.map(m => m.message_id) }; }
      if (path === '/node/memory/search') return { items: [] };
      if (path.endsWith('/checkpoint')) { checkpoints.push(body); return {}; }
      return {};
    },
  } as unknown as NodeApi;
  const agent = new NodeAgent(config(dir), { api, log: () => {} });
  try {
    await agent.tick();
    for (let i = 0; i < 30 && agent.store.run('run1')?.state !== 'succeeded'; i++) { await sleep(20); await agent.tick(); }
    await agent.flush();
    assert.equal(acceptCount, 1); assert.equal(agent.store.run('run1')?.state, 'succeeded');
    assert.equal(checkpoints.length, 1);
    assert.ok(reports.some(r => r.kind === 'run.state' && r.payload.state === 'succeeded'));
    const usageReport = reports.find(r => r.kind === 'usage.report')!;
    const cost = usageReport.payload.cost as { source: string; amount: null };
    assert.equal(cost.source, 'unavailable'); assert.equal(cost.amount, null);
    assert.equal(usageReport.payload.category, 'worker');
    assert.equal(usageReport.payload.activity_id, 'run:run1');
  } finally { await agent.stop(); agent.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('restart never automatically replays an already-started run', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'super-agent-recover-'));
  let reconciled: unknown;
  const api = { request: async (path: string, body: unknown) => {
    if (path === '/node/reconcile') reconciled = body;
    if (path === '/node/reports') return { accepted: (body as { messages: WireMessage[] }).messages.map(m => m.message_id) };
    return {};
  } } as unknown as NodeApi;
  const agent = new NodeAgent(config(dir), { api, runtimeFactory: async () => { throw new Error('MUST NOT REPLAY'); }, log: () => {} });
  try {
    agent.store.saveRun(context, 'running'); await agent.recover();
    assert.equal(agent.store.run('run1')?.state, 'result_unknown');
    assert.deepEqual(reconciled, { runs: [{ run_id: 'run1', lease_epoch: '1', state: 'result_unknown' }] });
  } finally { agent.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('proactive planning keeps category, activity id and the original usage sample across drain replay', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'super-agent-proactive-'));
  const occurredAt = '2026-11-19T04:05:06.000Z';
  const proactiveKey = 'proactive-request-1';
  const assistantKey = 'assistant-request-1';
  const scope = { project: 'alpha', sites: ['news.example'], global_preference: false, statuses: ['verified'], max_version: 3 };
  const inbox = [
    { id: 'msg-proactive', role: 'user', content: 'Check the morning site', task_id: null, created_at: occurredAt, schedule_id: 'sched-1', memory_scope: scope },
    { id: 'msg-assistant', role: 'user', content: '只回复，不派发', task_id: null, created_at: '2026-11-19T05:00:00.000Z' },
  ];
  const reserves: Record<string, unknown>[] = [], usages: { body: Record<string, unknown>; key?: string }[] = [], proposals: Record<string, unknown>[] = [];
  let plans = 0, failUsage = true;
  const api = { request: async (path: string, body?: unknown, options?: { idempotencyKey?: string }) => {
    if (path === '/node/heartbeat' || path === '/assistant/budget/heartbeat' || path === '/assistant/messages') return {};
    if (path.startsWith('/node/events')) return { items: [], cursor: '1' };
    if (path === '/node/commands' || path === '/assistant/events') return { items: [] };
    if (path === '/assistant/lease/claim' || path === '/assistant/lease/renew') return { epoch: 'epoch-1', lease_valid_for_ms: 60_000 };
    if (path === '/assistant/inbox') return { items: inbox.length ? [inbox.shift()] : [] };
    if (path === '/assistant/context') return { messages: [], tasks: [], pending_plans: [] };
    if (path === '/assistant/plans') return { id: `plan-${++plans}`, state: 'draft', tasks: [] };
    if (path.endsWith('/propose')) { proposals.push(body as Record<string, unknown>); return { state: 'awaiting_confirmation' }; }
    if (path === '/node/devices') return { items: [{ id: 'device1', name: 'Test Mac' }] };
    if (path === '/assistant/budget/reserve') {
      const record = body as Record<string, unknown>;
      reserves.push(record);
      return { limits: { max_total_tokens: 40_000, max_model_calls: 4, max_tool_steps: 20, max_runtime_ms: 600_000 }, status: 'reserved', expires_at: new Date(Date.now() + 600_000).toISOString(), activity_id: record.activity_id, device_id: 'device1', executable: true };
    }
    if (path === '/assistant/usage') {
      usages.push({ body: body as Record<string, unknown>, key: options?.idempotencyKey });
      if (failUsage) { failUsage = false; throw new ApiFailure(503, 'unavailable', 'retry'); }
      return {};
    }
    return {};
  } } as unknown as NodeApi;
  class ExplicitPlanningRuntime extends FakeRuntime {
    turns = 0;
    override async execute(context: RuntimeContext): Promise<RuntimeResult> {
      this.turns += 1;
      if (this.turns === 1) {
        await context.executeTool('task_start', { item_key: 'kept', goal: 'Keep the narrower scope', deliverables: ['结果'], engine: 'codex', device_id: 'device1', memory_scope: { project: 'alpha', sites: ['news.example'], global_preference: false, statuses: ['verified'], max_version: 2 } });
        await context.executeTool('task_start', { item_key: 'wide-site', goal: 'Do not add a site', deliverables: ['结果'], engine: 'codex', device_id: 'device1', memory_scope: { project: 'alpha', sites: ['news.example', 'extra.example'] } });
        await context.executeTool('task_start', { item_key: 'wide-project', goal: 'Do not change project', deliverables: ['结果'], engine: 'codex', device_id: 'device1', memory_scope: { project: 'model' } });
        await context.executeTool('task_start', { item_key: 'wide-global', goal: 'Do not open global', deliverables: ['结果'], engine: 'codex', device_id: 'device1', memory_scope: { project: 'alpha', global_preference: true } });
        await context.executeTool('task_start', { item_key: 'wide-status', goal: 'Do not add a status', deliverables: ['结果'], engine: 'codex', device_id: 'device1', memory_scope: { project: 'alpha', statuses: ['verified', 'candidate'] } });
        await context.executeTool('task_start', { item_key: 'wide-version', goal: 'Do not raise the version', deliverables: ['结果'], engine: 'codex', device_id: 'device1', memory_scope: { project: 'alpha', max_version: 9 } });
        await context.executeTool('task_start', { item_key: 'inherit', goal: 'Inherit the message scope', deliverables: ['结果'], engine: 'codex', device_id: 'device1' });
        await context.emit({ type: 'usage', usage: { request_key: proactiveKey, occurred_at: occurredAt, input_tokens: 4, cached_input_tokens: 0, output_tokens: 2, reasoning_tokens: 0 } });
        return { text: '请确认定时目标。' };
      }
      await context.emit({ type: 'usage', usage: { request_key: assistantKey, occurred_at: '2026-11-19T05:06:07.000Z', input_tokens: 2, cached_input_tokens: 0, output_tokens: 1, reasoning_tokens: 0 } });
      return { text: '普通回复。' };
    }
  }
  const runtime = new ExplicitPlanningRuntime();
  const cfg = config(dir); cfg.assistant = true; cfg.fake_runtime = false;
  const agent = new NodeAgent(cfg, { api, runtimeFactory: async () => runtime, log: () => {} });
  const writes: { id: string; payload: Record<string, unknown> }[] = [];
  const save = agent.store.saveAssistant.bind(agent.store);
  agent.store.saveAssistant = (id, payload) => { writes.push({ id, payload: structuredClone(payload) }); save(id, payload); };
  const until = async (ready: () => boolean) => { for (let i = 0; i < 40 && !ready(); i++) { await agent.tick(); await sleep(25); } };
  try {
    await until(() => usages.length >= 1);
    const pending = agent.store.assistantPending().find(item => item.messageId === 'msg-proactive');
    assert.equal(pending?.payload.category, 'proactive');
    const pendingUsage = (pending?.payload.usage as { request_key: string; occurred_at: string }[])[0];
    assert.equal(pendingUsage?.request_key, proactiveKey);
    assert.equal(pendingUsage?.occurred_at, occurredAt);
    await until(() => Boolean(agent.store.get('assistant:msg-proactive')) && Boolean(agent.store.get('assistant:msg-assistant')));
    assert.equal(runtime.turns, 2);
    const proactiveWrites = writes.filter(item => item.id === 'msg-proactive');
    assert.ok(proactiveWrites.length >= 2);
    assert.ok(proactiveWrites.every(item => item.payload.category === 'proactive'));
    const proposed = proactiveWrites.find(item => item.payload.phase === 'propose');
    assert.equal((proposed?.payload.usage as { request_key: string; occurred_at: string }[])[0]?.request_key, proactiveKey);
    assert.equal((proposed?.payload.usage as { occurred_at: string }[])[0]?.occurred_at, occurredAt);
    const saved = agent.store.get<{ category: string; usage: { request_key: string; occurred_at: string }[] }>('assistant:msg-proactive');
    assert.equal(saved?.category, 'proactive');
    assert.equal(saved?.usage[0]?.request_key, proactiveKey);
    assert.equal(saved?.usage[0]?.occurred_at, occurredAt);
    assert.equal(agent.store.get<{ category: string }>('assistant:msg-assistant')?.category, 'assistant');
    const proactiveUsage = usages.filter(item => item.body.message_id === 'msg-proactive');
    assert.equal(proactiveUsage.length, 2);
    for (const item of proactiveUsage) {
      assert.equal(item.body.category, 'proactive');
      assert.equal(item.body.activity_id, 'proactive:msg-proactive');
      assert.equal(item.body.request_key, proactiveKey);
      assert.equal(item.body.occurred_at, occurredAt);
      assert.equal(item.body.usage_revision, 1);
      assert.equal(item.key, `assistant-usage:msg-proactive:${proactiveKey}`);
    }
    const assistantUsage = usages.filter(item => item.body.message_id === 'msg-assistant');
    assert.equal(assistantUsage.length, 1);
    assert.equal(assistantUsage[0]?.body.category, 'assistant');
    assert.equal(assistantUsage[0]?.body.activity_id, 'assistant:msg-assistant');
    assert.equal(assistantUsage[0]?.body.request_key, assistantKey);
    assert.equal(reserves.length, 2);
    assert.equal(reserves[0]?.operation_key, 'proactive:msg-proactive');
    assert.equal(reserves[0]?.activity_id, 'proactive:msg-proactive');
    assert.equal(reserves[0]?.category, 'proactive');
    assert.equal(reserves[1]?.operation_key, 'assistant:msg-assistant');
    assert.equal(reserves[1]?.activity_id, 'assistant:msg-assistant');
    assert.equal(reserves[1]?.category, 'assistant');
    const items = (proposals[0]?.items as { item_key: string; memory_scope?: unknown }[]);
    const kept = { project: 'alpha', sites: ['news.example'], global_preference: false, statuses: ['verified'], max_version: 2 };
    assert.deepEqual(items.find(item => item.item_key === 'kept')?.memory_scope, kept);
    for (const key of ['wide-site', 'wide-project', 'wide-global', 'wide-status', 'wide-version', 'inherit']) assert.deepEqual(items.find(item => item.item_key === key)?.memory_scope, scope);
    const summary = String(proposals[0]?.summary);
    assert.match(summary, /引擎：codex/);
    assert.match(summary, /device1/);
    assert.match(summary, /项目 alpha/);
    assert.match(summary, /站点 news\.example/);
    assert.match(summary, /全局 关/);
    assert.doesNotMatch(summary, /extra\.example/);
    assert.doesNotMatch(summary, /项目 model/);
    assert.doesNotMatch(summary, /全局 开/);
    assert.equal(reserves.every(item => item.new_attempt !== true && !String(item.operation_key).includes('#')), true);
    assert.deepEqual(proposals.at(-1)?.items, proposals[0]?.items);
    const before = usages.length;
    await agent.tick(); await sleep(30); await agent.tick();
    assert.equal(usages.length, before);
    assert.equal(runtime.turns, 2);
    assert.equal(agent.store.get<{ category: string }>('assistant:msg-proactive')?.category, 'proactive');
  } finally { await agent.stop(); agent.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('explicit FakeRuntime proposals copy message memory scope without inventing one', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'super-agent-scope-'));
  const scope = { project: 'alpha', sites: ['news.example'] };
  const inbox = [
    { id: 'msg-scoped', role: 'user', content: 'Morning check', task_id: null, created_at: '2026-11-19T04:00:00.000Z', schedule_id: 'sched-2', memory_scope: scope },
    { id: 'msg-plain', role: 'user', content: 'Plain goal', task_id: null, created_at: '2026-11-19T06:00:00.000Z' },
  ];
  const reserves: unknown[] = [], proposals: { id: string; items: { memory_scope?: unknown }[]; summary: string }[] = [];
  const api = { request: async (path: string, body?: unknown) => {
    if (path === '/assistant/inbox') return { items: inbox.length ? [inbox.shift()] : [] };
    if (path === '/assistant/context') return { messages: [], tasks: [], pending_plans: [] };
    if (path === '/assistant/plans') return { id: path, state: 'draft', tasks: [] };
    if (path.endsWith('/propose')) { const payload = body as { items: { memory_scope?: unknown }[]; summary?: string }; proposals.push({ id: '', items: payload.items, summary: String(payload.summary ?? '') }); return { state: 'awaiting_confirmation' }; }
    if (path === '/node/devices') return { items: [{ id: 'device1', name: 'Test Mac' }] };
    if (path === '/assistant/lease/claim' || path === '/assistant/lease/renew') return { epoch: 'epoch-1', lease_valid_for_ms: 60_000 };
    if (path === '/assistant/budget/reserve') { reserves.push(body); return {}; }
    if (path.startsWith('/node/events')) return { items: [], cursor: '1' };
    if (path === '/node/commands' || path === '/assistant/events') return { items: [] };
    return {};
  } } as unknown as NodeApi;
  const cfg = config(dir); cfg.assistant = true; cfg.fake_runtime = true;
  const agent = new NodeAgent(cfg, { api, log: () => {} });
  const until = async (ready: () => boolean) => { for (let i = 0; i < 40 && !ready(); i++) { await agent.tick(); await sleep(20); } };
  try {
    await until(() => Boolean(agent.store.get('assistant:msg-scoped')) && Boolean(agent.store.get('assistant:msg-plain')));
    assert.equal(reserves.length, 0);
    assert.equal(agent.store.get<{ category: string }>('assistant:msg-scoped')?.category, 'proactive');
    assert.equal(agent.store.get<{ category: string }>('assistant:msg-plain')?.category, 'assistant');
    assert.equal(proposals.length, 2);
    assert.deepEqual(proposals[0]?.items[0]?.memory_scope, scope);
    assert.match(proposals[0]!.summary, /引擎：codex/);
    assert.match(proposals[0]!.summary, /device1/);
    assert.match(proposals[0]!.summary, /项目 alpha/);
    assert.match(proposals[0]!.summary, /站点 news\.example/);
    assert.match(proposals[0]!.summary, /全局 关/);
    assert.equal(proposals[1]?.items[0]?.memory_scope, undefined);
    assert.match(proposals[1]!.summary, /项目 无/);
    assert.match(proposals[1]!.summary, /站点 无/);
    assert.match(proposals[1]!.summary, /全局 关/);
    assert.doesNotMatch(proposals[1]!.summary, /全局 开/);
  } finally { await agent.stop(); agent.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('dead budget grants throw before runtime execute and a live grant replays the same usage key', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'super-agent-grant-'));
  const occurredAt = '2026-11-19T07:08:09.000Z';
  const requestKey = 'grant-usage-1';
  const limits = { max_total_tokens: 11, max_model_calls: 1, max_tool_steps: 2, max_runtime_ms: 600_000 };
  const future = new Date(Date.now() + 600_000).toISOString();
  const past = new Date(Date.now() - 60_000).toISOString();
  const cases = ['msg-ok', 'msg-expired', 'msg-released', 'msg-settled', 'msg-blocked', 'msg-nolimits'] as const;
  const inbox = cases.map(id => ({ id, role: 'user' as const, content: id === 'msg-ok' ? 'Use the reserved grant' : `Refuse ${id}`, task_id: null, created_at: occurredAt }));
  const reserves: Record<string, unknown>[] = [], usages: { body: Record<string, unknown>; key?: string }[] = [], replies: { id: string; content: string }[] = [];
  let failUsage = true;
  const api = { request: async (path: string, body?: unknown, options?: { idempotencyKey?: string }) => {
    if (path === '/node/heartbeat' || path === '/assistant/budget/heartbeat') return {};
    if (path === '/assistant/messages') { const record = body as { source_message_id?: string; content?: string }; replies.push({ id: String(record.source_message_id), content: String(record.content) }); return {}; }
    if (path.startsWith('/node/events')) return { items: [], cursor: '1' };
    if (path === '/node/commands' || path === '/assistant/events') return { items: [] };
    if (path === '/assistant/lease/claim' || path === '/assistant/lease/renew') return { epoch: 'epoch-1', lease_valid_for_ms: 60_000 };
    if (path === '/assistant/inbox') return { items: inbox.length ? [inbox.shift()] : [] };
    if (path === '/assistant/context') return { messages: [], tasks: [], pending_plans: [] };
    if (path === '/assistant/plans') return { id: 'plan-grant', state: 'draft', tasks: [] };
    if (path === '/node/devices') return { items: [{ id: 'device1', name: 'Test Mac' }] };
    if (path === '/assistant/budget/reserve') {
      const record = body as Record<string, unknown>;
      reserves.push(record);
      const activityId = String(record.activity_id);
      const base = { grant_id: 'grant-1', category: 'assistant', limits, status: 'reserved', expires_at: future, activity_id: activityId, device_id: 'device1', executable: true };
      if (record.operation_key === 'assistant:msg-expired') return { ...base, status: 'expired', expires_at: past, executable: false };
      if (record.operation_key === 'assistant:msg-released') return { ...base, status: 'released', executable: false };
      if (record.operation_key === 'assistant:msg-settled') return { ...base, status: 'settled', executable: false };
      if (record.operation_key === 'assistant:msg-blocked') return { ...base, executable: false };
      if (record.operation_key === 'assistant:msg-nolimits') return { ...base, limits: null };
      return base;
    }
    if (path === '/assistant/usage') {
      usages.push({ body: body as Record<string, unknown>, key: options?.idempotencyKey });
      if (failUsage) { failUsage = false; throw new ApiFailure(503, 'unavailable', 'retry'); }
      return {};
    }
    return {};
  } } as unknown as NodeApi;
  class GrantRuntime extends FakeRuntime {
    turns = 0;
    limitEnforced = false;
    override async execute(context: RuntimeContext): Promise<RuntimeResult> {
      this.turns += 1;
      if (!context.goal.includes('Use the reserved grant')) throw new Error('model must not run');
      context.budget?.beforeModelCall();
      try { context.budget?.beforeModelCall(); } catch (error) { this.limitEnforced = error instanceof Error && error.message.includes('model_call_limit'); }
      if (!this.limitEnforced) throw new Error('grant limits were not applied');
      await context.emit({ type: 'usage', usage: { request_key: requestKey, occurred_at: occurredAt, input_tokens: 3, cached_input_tokens: 0, output_tokens: 1, reasoning_tokens: 0 } });
      return { text: '已使用授权。' };
    }
  }
  const runtime = new GrantRuntime();
  const cfg = config(dir); cfg.assistant = true; cfg.fake_runtime = false;
  const agent = new NodeAgent(cfg, { api, runtimeFactory: async () => runtime, log: () => {} });
  const until = async (ready: () => boolean) => { for (let i = 0; i < 80 && !ready(); i++) { await agent.tick(); await sleep(20); } };
  try {
    await until(() => cases.every(id => Boolean(agent.store.get(`assistant:${id}`))) && usages.length >= 2);
    assert.equal(runtime.turns, 1);
    assert.equal(runtime.limitEnforced, true);
    const content = (id: string) => replies.filter(item => item.id === id).map(item => item.content).join('\n');
    assert.match(content('msg-ok'), /已使用授权/);
    assert.doesNotMatch(content('msg-ok'), /grant_not_executable/);
    assert.match(content('msg-expired'), /grant_not_executable:expired/);
    assert.match(content('msg-released'), /grant_not_executable:released/);
    assert.match(content('msg-settled'), /grant_not_executable:settled/);
    assert.match(content('msg-blocked'), /grant_not_executable:reserved/);
    assert.match(content('msg-nolimits'), /grant_not_executable:reserved/);
    assert.deepEqual(reserves.map(item => item.operation_key), cases.map(id => `assistant:${id}`));
    for (const item of reserves) {
      assert.equal(item.new_attempt, undefined);
      assert.equal(item.prior_activity_id, undefined);
      assert.equal(item.operation_key, item.activity_id);
    }
    const okUsage = usages.filter(item => item.body.message_id === 'msg-ok');
    assert.equal(okUsage.length, 2);
    for (const item of okUsage) {
      assert.equal(item.body.request_key, requestKey);
      assert.equal(item.body.occurred_at, occurredAt);
      assert.equal(item.body.activity_id, 'assistant:msg-ok');
      assert.equal(item.body.category, 'assistant');
      assert.equal(item.key, `assistant-usage:msg-ok:${requestKey}`);
    }
    assert.equal(usages.length, 2);
    const reserveCount = reserves.length;
    await agent.tick(); await sleep(30); await agent.tick();
    assert.equal(usages.length, 2);
    assert.equal(reserves.length, reserveCount);
    assert.equal(runtime.turns, 1);
  } finally { await agent.stop(); agent.close(); rmSync(dir, { recursive: true, force: true }); }
});
