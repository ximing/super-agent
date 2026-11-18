import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { RunContext, WireMessage } from '@super-agent/protocol';
import { NodeAgent } from '../src/agent.js';
import type { NodeConfig } from '../src/config.js';
import type { NodeApi } from '../src/api.js';
import { sleep } from '@super-agent/tool-broker/runtime';

const config = (dir: string): NodeConfig => ({ server_url: 'https://control.example', name: 'Test Mac', device_id: 'device1', public_key: '', private_key_path: '', data_dir: dir, poll_interval_ms: 20, allow_shell: false, fake_runtime: true, codex: { enabled: true, command: 'codex', model: 'fake-test-model', sandbox: 'workspace-write' }, grok: { enabled: true, key_env: 'NONEXISTENT_TEST_KEY', model: 'fake-test-model', base_url: 'https://api.x.ai/v1' }, assistant: false });
const context: RunContext = {
  run: { id: 'run1', task_id: 'task1', state: 'starting', engine: 'codex', device_id: 'device1', model_id: 'fake-test-model', lease_epoch: '1', summary: '', created_at: '2026-11-18T00:00:00Z' },
  task: { id: 'task1', title: 'Test', goal: 'Exercise node lifecycle', status: 'running', reason_code: null, engine: 'codex', model_id: 'fake-test-model', device_id: 'device1', current_run_id: 'run1', created_at: '2026-11-18T00:00:00Z', updated_at: '2026-11-18T00:00:00Z', version: 1 },
  scope: {}, checkpoint: null, run_ticket: 'test-ticket', lease_valid_for_ms: 45000,
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
    const cost = reports.find(r => r.kind === 'usage.report')!.payload.cost as { source: string; amount: null };
    assert.equal(cost.source, 'unavailable'); assert.equal(cost.amount, null);
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
