import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { WireMessage } from '@super-agent/protocol';
import type { BrowserActor, RuntimeContext } from '@super-agent/tool-broker';
import { NodeAgent } from '../src/agent.js';
import type { NodeConfig } from '../src/config.js';
import type { NodeApi } from '../src/api.js';

const config = (dir: string): NodeConfig => ({ server_url: 'https://control.example', name: 'Test Mac', device_id: 'device1', public_key: '', private_key_path: '', data_dir: dir, poll_interval_ms: 20, allow_shell: false, fake_runtime: true, codex: { enabled: true, command: 'codex', model: 'fake-test-model', sandbox: 'workspace-write' }, grok: { enabled: true, key_env: 'NONEXISTENT_TEST_KEY', model: 'fake-test-model', base_url: 'https://api.x.ai/v1' }, assistant: false });

function command(): WireMessage {
  return { protocol_version: '1.0', message_id: 'obs1', kind: 'observation.check', sent_at: '2026-11-19T00:00:00Z', payload: { command_id: 'obs1', rule_id: 'rule-1', source: 'page', url: 'https://a.example/item', sites: ['a.example'], condition: '价格低于 10', engine: 'grok' } };
}

test('page observation does not call the model when the page is unread, the device is busy, or the grant is dead', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'super-agent-observe-'));
  const reports: Record<string, unknown>[] = [];
  let executes = 0, navigations = 0;
  const browser = { humanActive: () => false, call: async () => { navigations++; throw new Error('csi down'); }, capture: async () => { throw new Error('csi down'); }, release: async () => {} } as unknown as BrowserActor;
  const api = { request: async (path: string, body?: unknown) => {
    if (path === '/node/commands') return { items: [command()] };
    if (path.startsWith('/node/observations/')) { reports.push(body as Record<string, unknown>); return {}; }
    if (path === '/assistant/budget/reserve') return { status: 'settled', executable: false, limits: null, activity_id: 'proactive:observation:rule-1:x' };
    if (path === '/node/reports') return { accepted: ((body as { messages?: { message_id: string }[] })?.messages ?? []).map(message => message.message_id) };
    return {};
  } } as unknown as NodeApi;
  const agent = new NodeAgent(config(dir), { api, browser, runtimeFactory: async () => ({ execute: async () => { executes++; return { text: '{"matched":true}' }; }, stop: async () => {}, steer: async () => {} }), log: () => {} });
  try {
    await agent.tick();
    assert.equal(reports[0]?.status, 'failed');
    assert.equal(reports[0]?.reason, 'page_unread');
    assert.equal(executes, 0);
    assert.equal(navigations, 1);
    const caps = await agent.capabilities();
    assert.equal(caps.engines.find(engine => engine.engine === 'grok')?.vision, 'unsupported');
    assert.equal(caps.engines.find(engine => engine.engine === 'codex')?.vision, 'unsupported');
  } finally { await agent.stop(); agent.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('a live observation grant is used once and a dead grant never reaches the runtime', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'super-agent-observe-live-'));
  const reports: Record<string, unknown>[] = [];
  const reserves: string[] = [];
  let executes = 0;
  let grant: Record<string, unknown> = { status: 'reserved', executable: true, limits: { max_total_tokens: 1000, max_model_calls: 2, max_tool_steps: 2, max_runtime_ms: 60_000 }, activity_id: '', device_id: 'device1', expires_at: '2099-01-01T00:00:00.000Z' };
  const browser = { humanActive: () => false, call: async () => ({}), capture: async () => ({ url: 'https://a.example/item', snapshot: { text: '价格 9' }, source_uncertain: false, captured_at: '2026-11-19T00:00:00Z', frame: null, bytes: null, source_uncertain_reason: null }), release: async () => {} } as unknown as BrowserActor;
  let issued = 0;
  const api = { request: async (path: string, body?: unknown) => {
    if (path === '/node/commands') { issued += 1; const message = command(); message.message_id = `obs${issued}`; message.payload = { ...message.payload, command_id: `obs${issued}` }; return { items: [message] }; }
    if (path.startsWith('/node/observations/')) { reports.push(body as Record<string, unknown>); return {}; }
    if (path === '/assistant/budget/reserve') { const key = String((body as { operation_key?: string }).operation_key); reserves.push(key); return { ...grant, activity_id: key }; }
    if (path === '/node/reports') return { accepted: ((body as { messages?: { message_id: string }[] })?.messages ?? []).map(message => message.message_id) };
    return {};
  } } as unknown as NodeApi;
  const agent = new NodeAgent(config(dir), { api, browser, runtimeFactory: async () => ({ execute: async (context: RuntimeContext) => { executes++; assert.match(context.goal, /价格 9/); return { text: '{"matched":true,"reason":"价格是 9"}' }; }, stop: async () => {}, steer: async () => {} }), log: () => {} });
  try {
    await agent.tick();
    assert.equal(executes, 1);
    assert.equal(reports.at(-1)?.status, 'matched');
    assert.equal(reports.at(-1)?.fingerprint, reserves[0]?.split(':').at(-1));
    grant = { status: 'settled', executable: false, limits: null };
    reports.length = 0; executes = 0;
    await agent.tick();
    assert.equal(executes, 0);
    assert.equal(reports.at(-1)?.reason, 'grant_not_executable');
  } finally { await agent.stop(); agent.close(); rmSync(dir, { recursive: true, force: true }); }
});
