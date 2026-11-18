import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalStore } from '../src/store.js';
import { ticksToUsd } from '../src/agent.js';
import type { WireMessage } from '@super-agent/protocol';

test('durable command dedupe, conflicting replay rejection and producer continuation after restart', () => {
  const dir = mkdtempSync(join(tmpdir(), 'super-agent-store-'));
  let store = new LocalStore(join(dir, 'node.sqlite'));
  try {
    const command: WireMessage = { protocol_version: '1.0', message_id: 'm1', kind: 'run.start', sent_at: '2026-11-18T00:00:00Z', payload: { command_id: 'c1', run_id: 'r1' } };
    assert.equal(store.command(command), 'new'); assert.equal(store.command(command), 'duplicate');
    assert.throws(() => store.command({ ...command, payload: { ...command.payload, run_id: 'other' } }), /hash_conflict/);
    const first = store.enqueue('run.state', { state: 'running' }, 'r1');
    assert.equal(first.payload.producer_seq, '1'); store.close();
    store = new LocalStore(join(dir, 'node.sqlite'));
    assert.equal(store.command(command), 'duplicate');
    const second = store.enqueue('run.state', { state: 'succeeded' }, 'r1');
    assert.equal(second.payload.producer_seq, '2'); assert.equal(second.payload.producer_id, first.payload.producer_id);
    assert.equal(store.pendingReports().length, 2); store.acknowledge([first.message_id]); assert.equal(store.pendingReports().length, 1);
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('usage revisions update one request and atomically retain unacknowledged reporting', () => {
  const store = new LocalStore(':memory:');
  try {
    const payload = { request_key: 'q1', cost: { amount: null } };
    const one = store.recordUsage('run1', 'q1', payload)!;
    assert.equal(one.payload.usage_revision, 1);
    assert.equal(store.recordUsage('run1', 'q1', payload), null);
    const two = store.recordUsage('run1', 'q1', { ...payload, cost: { amount: '0.001' } })!;
    assert.equal(two.payload.usage_revision, 2); assert.equal(store.pendingReports().length, 2);
    store.saveAssistant('message1', { text: 'a durable reply', usage: [] });
    assert.equal(store.assistantPending().length, 1); store.assistantDone('message1'); assert.equal(store.assistantPending().length, 0);
  } finally { store.close(); }
});

test('Grok decimal ticks preserve precision and distinguish free from unavailable', () => {
  assert.equal(ticksToUsd('38000000'), '0.0038'); assert.equal(ticksToUsd('0'), '0');
  assert.equal(ticksToUsd('10000000001'), '1.0000000001'); assert.throws(() => ticksToUsd('-1'));
});
