import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { WireMessage } from '@super-agent/protocol';
import { observationActivityId } from '@super-agent/protocol';
import type { BrowserActor, RuntimeContext } from '@super-agent/tool-broker';
import { NodeAgent } from '../src/agent.js';
import type { NodeConfig } from '../src/config.js';
import type { NodeApi } from '../src/api.js';

const config = (dir: string): NodeConfig => ({ server_url: 'https://control.example', name: 'Test Mac', device_id: 'device1', public_key: '', private_key_path: '', data_dir: dir, poll_interval_ms: 20, allow_shell: false, fake_runtime: true, codex: { enabled: true, command: 'codex', model: 'fake-test-model', sandbox: 'workspace-write' }, grok: { enabled: true, key_env: 'NONEXISTENT_TEST_KEY', model: 'fake-test-model', base_url: 'https://api.x.ai/v1' }, assistant: false });

function command(id = 'obs1', version = 3): WireMessage {
  return { protocol_version: '1.0', message_id: id, kind: 'observation.check', sent_at: '2026-11-19T00:00:00Z', payload: { command_id: id, rule_id: 'rule-1', config_version: version, source: 'page', url: 'https://a.example/item', sites: ['a.example'], condition: '价格低于 10', engine: 'grok' } };
}

const limits = { max_total_tokens: 1000, max_model_calls: 2, max_tool_steps: 2, max_runtime_ms: 60_000 };
function executableGrant(commandId: string): Record<string, unknown> {
  return { status: 'reserved', executable: true, limits, activity_id: observationActivityId(commandId), device_id: 'device1', expires_at: '2099-01-01T00:00:00.000Z' };
}

test('page observation does not call the model when the page is unread, the device is busy, or the grant is dead', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'super-agent-observe-'));
  const reports: Record<string, unknown>[] = [];
  let executes = 0, navigations = 0, assistantReserves = 0;
  const browser = { humanActive: () => false, call: async () => { navigations++; throw new Error('csi down'); }, capture: async () => { throw new Error('csi down'); }, release: async () => {} } as unknown as BrowserActor;
  const api = { request: async (path: string, body?: unknown) => {
    if (path === '/assistant/budget/reserve') { assistantReserves += 1; throw new Error('assistant_lease_required'); }
    if (path === '/node/commands') return { items: [command()] };
    if (path.startsWith('/node/observations/')) { reports.push(body as Record<string, unknown>); return {}; }
    if (path === '/node/reports') return { accepted: ((body as { messages?: { message_id: string }[] })?.messages ?? []).map(message => message.message_id) };
    return {};
  } } as unknown as NodeApi;
  const agent = new NodeAgent(config(dir), { api, browser, runtimeFactory: async () => ({ execute: async () => { executes++; return { text: '{"matched":true}' }; }, stop: async () => {}, steer: async () => {} }), log: () => {} });
  try {
    await agent.tick();
    assert.equal(reports[0]?.status, 'failed');
    assert.equal(reports[0]?.reason, 'page_unread');
    assert.equal(reports[0]?.command_id, 'obs1');
    assert.equal(reports[0]?.config_version, 3);
    assert.equal(executes, 0);
    assert.equal(navigations, 1);
    assert.equal(assistantReserves, 0);
    const caps = await agent.capabilities();
    assert.equal(caps.engines.find(engine => engine.engine === 'grok')?.vision, 'unsupported');
    assert.equal(caps.engines.find(engine => engine.engine === 'codex')?.vision, 'unsupported');
  } finally { await agent.stop(); agent.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('a live observation grant is used once and a dead grant never reaches the runtime', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'super-agent-observe-live-'));
  const reports: Record<string, unknown>[] = [];
  const reserves: Record<string, unknown>[] = [];
  const releases: Record<string, unknown>[] = [];
  const usage = new Map<string, Record<string, unknown>>();
  let executes = 0, assistantReserves = 0;
  let grantMode: 'live' | 'terminal' | 'blocked' = 'live';
  const browser = { humanActive: () => false, call: async () => ({}), capture: async () => ({ url: 'https://a.example/item', snapshot: { text: '价格 9' }, source_uncertain: false, captured_at: '2026-11-19T00:00:00Z', frame: null, bytes: null, source_uncertain_reason: null }), release: async () => {} } as unknown as BrowserActor;
  const issued: WireMessage[] = [];
  const api = { request: async (path: string, body?: unknown) => {
    const record = (body ?? {}) as Record<string, unknown>;
    if (path === '/assistant/budget/reserve') { assistantReserves += 1; throw new Error('assistant_lease_required'); }
    if (path === '/node/commands') {
      const message = issued.length === 1 && grantMode === 'live' ? issued[0]! : command(`obs-${issued.length + 1}`);
      if (!issued.includes(message)) issued.push(message);
      return { items: [message] };
    }
    if (path.endsWith('/budget/reserve')) {
      reserves.push(record);
      const commandId = String(record.command_id);
      if (grantMode === 'terminal') return { status: 'settled', executable: false, limits: null, activity_id: observationActivityId(commandId), device_id: 'device1' };
      if (grantMode === 'blocked') return { ...executableGrant(commandId), executable: false };
      return executableGrant(commandId);
    }
    if (path.endsWith('/budget/heartbeat')) return {};
    if (path.endsWith('/budget/release')) { releases.push(record); return {}; }
    if (path.endsWith('/usage')) { usage.set(String(record.request_key), record); return {}; }
    if (path.endsWith('/report')) { reports.push(record); return {}; }
    if (path === '/node/reports') return { accepted: ((body as { messages?: { message_id: string }[] })?.messages ?? []).map(message => message.message_id) };
    return {};
  } } as unknown as NodeApi;
  const agent = new NodeAgent(config(dir), { api, browser, runtimeFactory: async () => ({ execute: async (context: RuntimeContext) => {
    executes += 1;
    assert.match(context.goal, /价格 9/);
    assert.equal(context.tools.length, 0);
    const sample = { request_key: 'obs-key', input_tokens: 3, cached_input_tokens: 0, output_tokens: 1, reasoning_tokens: 0, occurred_at: '2026-11-19T00:00:01.000Z' };
    await context.emit({ type: 'usage', usage: sample });
    await context.emit({ type: 'usage', usage: { ...sample, input_tokens: 9, output_tokens: 9 } });
    return { text: '{"matched":true,"reason":"价格是 9"}' };
  }, stop: async () => {}, steer: async () => {} }), log: () => {} });
  try {
    await agent.tick();
    const pageText = JSON.stringify({ text: '价格 9' });
    const fingerprint = createHash('sha256').update(`https://a.example/item\n${pageText}`).digest('hex');
    assert.equal(executes, 1);
    assert.equal(assistantReserves, 0);
    assert.equal(reserves.length, 1);
    assert.equal(reserves[0]?.command_id, 'obs-1');
    assert.equal(reserves[0]?.config_version, 3);
    assert.equal('new_attempt' in (reserves[0] ?? {}), false);
    assert.equal('operation_key' in (reserves[0] ?? {}), false);
    assert.equal(reports.at(-1)?.status, 'matched');
    assert.equal(reports.at(-1)?.fingerprint, fingerprint);
    assert.equal(reports.at(-1)?.command_id, 'obs-1');
    assert.equal(reports.at(-1)?.config_version, 3);
    assert.notEqual(reports.at(-1)?.fingerprint, observationActivityId('obs-1'));
    assert.equal(usage.size, 1);
    const posted = usage.get('obs-key');
    assert.equal(posted?.activity_id, observationActivityId('obs-1'));
    assert.equal(posted?.input_tokens, 3);
    assert.equal((posted?.cost as { source?: string; amount?: unknown })?.source, 'unavailable');
    assert.equal((posted?.cost as { amount?: unknown })?.amount, null);
    assert.match(String(posted?.occurred_at), /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(releases.at(-1)?.activity_id, observationActivityId('obs-1'));
    assert.equal(releases.at(-1)?.command_id, 'obs-1');
    const before = executes;
    await agent.tick();
    assert.equal(executes, before);
    assert.equal(reserves.length, 1);
    grantMode = 'terminal';
    reports.length = 0;
    await agent.tick();
    assert.equal(executes, before);
    assert.equal(reports.at(-1)?.reason, 'grant_not_executable');
    assert.equal(reports.at(-1)?.command_id, 'obs-2');
    assert.equal(reports.at(-1)?.config_version, 3);
    grantMode = 'blocked';
    reports.length = 0;
    await agent.tick();
    assert.equal(executes, before);
    assert.equal(reports.at(-1)?.reason, 'grant_not_executable');
  } finally { await agent.stop(); agent.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('restart does not execute again and still releases and reports observation_interrupted', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'super-agent-observe-restart-'));
  const commandId = 'obs-restart';
  const activityId = observationActivityId(commandId);
  const first = new NodeAgent(config(dir), { log: () => {} });
  const message = command(commandId, 4);
  first.store.command(message);
  first.store.saveObservation(commandId, {
    command_id: commandId, rule_id: 'rule-1', config_version: 4, activity_id: activityId, phase: 'running', engine: 'grok', model_id: 'fake-test-model',
    usage: [{ request_key: 'restart-key', usage_revision: 1, input_tokens: 2, output_tokens: 1, cached_input_tokens: 0, reasoning_tokens: 0, occurred_at: '2026-11-19T00:00:02.000Z', cost: { source: 'unavailable', quality: 'missing', amount: null, currency: null, price_version_id: null }, acked: false }],
  });
  first.close();
  const reports: Record<string, unknown>[] = [];
  const releases: Record<string, unknown>[] = [];
  const usage = new Map<string, Record<string, unknown>>();
  let executes = 0, assistantReserves = 0;
  const api = { request: async (path: string, body?: unknown) => {
    const record = (body ?? {}) as Record<string, unknown>;
    if (path === '/assistant/budget/reserve') { assistantReserves += 1; throw new Error('assistant_lease_required'); }
    if (path.endsWith('/budget/release')) { releases.push(record); return {}; }
    if (path.endsWith('/usage')) { usage.set(String(record.request_key), record); return {}; }
    if (path.endsWith('/report')) { reports.push(record); return {}; }
    if (path === '/node/reconcile') return {};
    if (path === '/node/reports') return { accepted: ((body as { messages?: { message_id: string }[] })?.messages ?? []).map(item => item.message_id) };
    if (path === '/node/commands') return { items: [message] };
    return {};
  } } as unknown as NodeApi;
  const agent = new NodeAgent(config(dir), { api, runtimeFactory: async () => ({ execute: async () => { executes += 1; return { text: '{"matched":true}' }; }, stop: async () => {}, steer: async () => {} }), log: () => {} });
  try {
    await agent.recover();
    assert.equal(executes, 0);
    assert.equal(assistantReserves, 0);
    assert.equal(reports.length, 1);
    assert.equal(reports[0]?.status, 'failed');
    assert.equal(reports[0]?.reason, 'observation_interrupted');
    assert.equal(reports[0]?.command_id, commandId);
    assert.equal(reports[0]?.config_version, 4);
    assert.equal(releases.length, 1);
    assert.equal(releases[0]?.activity_id, activityId);
    assert.equal(usage.size, 1);
    assert.equal(usage.get('restart-key')?.activity_id, activityId);
    assert.equal((usage.get('restart-key')?.cost as { amount?: unknown })?.amount, null);
    await agent.recover();
    assert.equal(executes, 0);
    assert.equal(reports.length, 1);
    assert.equal(usage.size, 1);
    assert.equal(releases.length, 1);
  } finally { await agent.stop(); agent.close(); rmSync(dir, { recursive: true, force: true }); }
});
