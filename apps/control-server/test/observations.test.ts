import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { ApiError, type Doc, type Tx } from '../src/store.js';
import { Auth } from '../src/auth.js';
import { Service } from '../src/service.js';
import { decideSuggestion, observationInput, observeDue, reportObservation } from '../src/observations.js';
import { readEvents, sseFrame } from '../src/events-stream.js';
import { assertSwitchTarget, takeoverPreflight } from '../src/takeover.js';
import { assessMemory, proposeRetrospective, proposeUserCorrection, setPreferenceEnabled, workerAccess } from '../src/memory-governance.js';

function memoryTx(): Tx {
  const tables = new Map<string, Map<string, Doc>>();
  const table = (name: string) => { if (!tables.has(name)) tables.set(name, new Map()); return tables.get(name)!; };
  const put = async (name: string, doc: Doc, id: string = doc.id ?? randomUUID()) => {
    const value = { ...doc, id, version: (table(name).get(id)?.version ?? 0) + 1, created_at: table(name).get(id)?.created_at ?? new Date().toISOString(), updated_at: new Date().toISOString() };
    table(name).set(id, value);
    return value;
  };
  return { tenant: randomUUID(), client: { query: async () => ({ rows: [] }) }, get: async (name: string, id: string) => table(name).get(id) ?? null, all: async (name: string) => [...table(name).values()], need: async (name: string, id: string) => { const value = table(name).get(id); if (!value) throw new ApiError(404, 'not_found', '资源不存在'); return value; }, remove: async (name: string, id: string) => { table(name).delete(id); }, put, emit: async () => {}, insertNew: put } as unknown as Tx;
}

test('task observation suggests once per fingerprint and confirm keeps the rule scope', async () => {
  const tx = memoryTx();
  const device = await tx.put('devices', { name: 'mac', last_seen_at: new Date().toISOString(), capabilities: { slots: { browser: 1 }, engines: [{ engine: 'grok', ready: true }] } });
  const task = await tx.put('tasks', { title: '核对', goal: '看页面', status: 'awaiting_review', delivery_status: 'pending', updated_at: '2026-11-19T00:00:00.000Z', scope: { memory: { project: 'alpha', sites: ['a.example'] } } });
  const rule = await tx.put('schedules', { ...observationInput({ title: '验收后跟进', goal: '整理验收差异', device_id: device.id, engine: 'grok', source: 'task_result', task_id: task.id, match: 'status', value: 'awaiting_review', sites: ['a.example'], project: 'alpha', cooldown_minutes: 30 }), next_eligible_at: '2020-01-01T00:00:00.000Z', last_status: 'idle', suggestions: [], history: [] });
  await observeDue(tx, Date.parse('2026-11-19T01:00:00.000Z'));
  await observeDue(tx, Date.parse('2026-11-19T01:00:01.000Z'));
  const saved = await tx.need('schedules', rule.id);
  assert.equal(saved.suggestions.length, 1);
  assert.match(saved.suggestions[0].reason, /实际记忆范围/);
  assert.equal((await tx.all('messages')).length, 0);
  const decided = await decideSuggestion(tx, rule.id, saved.suggestions[0].id, 'confirm', body => new Service({} as never, {} as Auth).createTask(tx, body));
  assert.equal(decided.task.scope.memory.global_preference, false);
  assert.deepEqual(decided.task.scope.memory.sites, ['a.example']);
  assert.equal(decided.task.scope.memory.project, 'alpha');
  const again = await decideSuggestion(tx, rule.id, saved.suggestions[0].id, 'confirm', body => new Service({} as never, {} as Auth).createTask(tx, body));
  assert.equal(again.suggestions[0].task_id, decided.task.id);
  assert.equal((await tx.all('tasks')).length, 2);
});

test('a busy device and a page rule do not invent a reminder', async () => {
  const tx = memoryTx();
  const now = Date.parse('2026-11-19T01:00:00.000Z');
  const device = await tx.put('devices', { name: 'mac', last_seen_at: new Date(now).toISOString(), capabilities: { slots: { browser: 1 }, engines: [{ engine: 'grok', ready: true }] } });
  await tx.put('runs', { device_id: device.id, state: 'running', lease_expires_at: new Date(now + 60_000).toISOString() });
  const rule = await tx.put('schedules', { ...observationInput({ title: '看页面', goal: '价格变化后告诉我', device_id: device.id, engine: 'grok', source: 'page', url: 'https://a.example/item', condition: '价格低于 10', sites: ['a.example'], cooldown_minutes: 15 }), next_eligible_at: '2020-01-01T00:00:00.000Z', last_status: 'idle', suggestions: [], history: [] });
  await observeDue(tx, now);
  assert.equal((await tx.need('schedules', rule.id)).last_status, 'suppressed');
  assert.equal((await tx.all('commands')).length, 0);
  assert.equal((await tx.all('messages')).length, 0);
  let rejected: unknown;
  try { observationInput({ title: '越权', goal: '看别的站', device_id: device.id, engine: 'grok', source: 'page', url: 'https://b.example/item', condition: '变化', sites: ['a.example'], cooldown_minutes: 15 }); }
  catch (error) { rejected = error; }
  assert.equal((rejected as ApiError).code, 'invalid_observation');
});

test('page reports dedupe, back off, and do not treat suppression as failure', async () => {
  const tx = memoryTx();
  const deviceId = randomUUID();
  const rule = await tx.put('schedules', { kind: 'observation', device_id: deviceId, source: 'page', cooldown_minutes: 5, last_fingerprint: null, consecutive_failures: 0, suggestions: [], history: [], goal: '跟进', title: '页面', sites: ['a.example'], project: null, engine: 'grok' });
  const now = Date.parse('2026-11-19T01:00:00.000Z');
  const matched = await reportObservation(tx, rule.id, deviceId, { status: 'matched', reason: '价格变为 9', fingerprint: 'price-9' }, now);
  const replay = await reportObservation(tx, rule.id, deviceId, { status: 'matched', reason: '价格变为 9', fingerprint: 'price-9' }, now + 1000);
  assert.equal(matched.suggestions.length, 1);
  assert.equal(replay.suggestions.length, 1);
  const suppressed = await reportObservation(tx, rule.id, deviceId, { status: 'suppressed', reason: 'browser_busy' }, now + 2000);
  assert.equal(suppressed.consecutive_failures, 0);
  const failed = await reportObservation(tx, rule.id, deviceId, { status: 'failed', reason: 'page_unread' }, now + 3000);
  assert.equal(failed.consecutive_failures, 1);
  assert.ok(Date.parse(failed.next_eligible_at) >= now + 5 * 60_000);
});

test('event frames keep the cursor and do not echo tool arguments', async () => {
  const secret = 'tool-argument-canary';
  const frame = sseFrame({ stream_seq: '4', type: 'step.updated', payload: { tool: 'other', args: secret } });
  assert.match(frame, /^id: 4\nevent: step\.updated\ndata: /);
  assert.equal(frame.includes(secret), true);
  const tx = { tenant: 'tenant', client: { query: async () => ({ rows: [{ data: { event_id: 'e', stream_seq: '4', type: 'step.updated', payload: { tool: 'browser_navigate', args: { password: secret }, url: secret, status: 'succeeded', started_at: 'private', completed_at: null, error_code: null } } }] }) } } as unknown as Tx;
  const page = await readEvents(tx, '3');
  assert.equal(page.cursor, '4');
  assert.equal(JSON.stringify(page.items).includes(secret), false);
  await assert.rejects(() => readEvents(tx, 'abc'), (error: unknown) => error instanceof ApiError && error.code === 'invalid_cursor');
});

test('takeover stays blocked while the old lease is live, unknown, or the engine is offline', async () => {
  const tx = memoryTx();
  const now = Date.parse('2026-11-19T01:00:00.000Z');
  const device = await tx.put('devices', { name: 'other', last_seen_at: new Date(now).toISOString(), capabilities: { slots: { browser: 1 }, engines: [{ engine: 'grok', ready: true }] } });
  const task = await tx.put('tasks', { title: '接任', goal: '继续', current_run_id: 'run-1', scope: { memory: { sites: ['a.example'] } } });
  await tx.put('runs', { id: 'run-1', state: 'running', lease_expires_at: new Date(now + 30_000).toISOString() }, 'run-1');
  const live = await takeoverPreflight(tx, task.id, device.id, 'grok', now);
  assert.equal(live.ready, false);
  assert.equal(live.checks.find((check: Doc) => check.name === 'authority')?.status, 'fail');
  assert.throws(() => assertSwitchTarget(live), (error: unknown) => error instanceof ApiError && error.code === 'execution_authority_live');
  await tx.put('runs', { id: 'run-1', state: 'result_unknown', lease_expires_at: '2020-01-01T00:00:00.000Z' }, 'run-1');
  const unknown = await takeoverPreflight(tx, task.id, device.id, 'grok', now);
  assert.equal(unknown.checks.find((check: Doc) => check.name === 'reconciliation')?.status, 'fail');
  await tx.put('runs', { id: 'run-1', state: 'failed', lease_expires_at: '2020-01-01T00:00:00.000Z' }, 'run-1');
  await tx.put('devices', { ...device, last_seen_at: '2020-01-01T00:00:00.000Z' }, device.id);
  const offline = await takeoverPreflight(tx, task.id, device.id, 'grok', now);
  assert.equal(offline.checks.find((check: Doc) => check.name === 'engine')?.status, 'fail');
  assert.equal(offline.checks.find((check: Doc) => check.name === 'site_login')?.status, 'unknown');
});

test('same titles are not semantic conflicts, and a disabled preference is hidden from the worker', async () => {
  const tx = memoryTx();
  const task = { id: 'task', title: '同一标题', goal: '核对', scope: { memory: { project: 'alpha', sites: ['a.example'] } } };
  await tx.put('memories', { title: '复盘：同一标题', content: '旧事实', type: 'experience', site: 'a.example', status: 'verified' });
  const saved = await proposeRetrospective(tx, { id: 'run', summary: '模型摘要' }, task, 'succeeded');
  assert.equal(saved.status, 'candidate');
  assert.equal(saved.provenance, 'model_inference');
  assert.equal(saved.governance.verification, 'candidate');
  assert.deepEqual(saved.governance.conflicts_with, []);
  const correction = await proposeUserCorrection(tx, task, { id: 'run' }, '这里应该看价格而不是标题');
  assert.equal(correction.provenance, 'user_statement');
  assert.equal(correction.status, 'candidate');
  const preference = await tx.put('memories', { title: '偏好', content: '用中文', type: 'preference', status: 'verified', site: 'a.example', governance: { preference_enabled: true, verification: 'verified', applicability: { project: 'alpha', sites: ['a.example'], global: false } } });
  const access = workerAccess({ scope: { memory: { project: 'alpha', sites: ['a.example'], statuses: ['verified'] } } }, null);
  assert.equal(assessMemory(preference, access).allowed, true);
  const disabled = await setPreferenceEnabled(tx, preference.id, false);
  assert.equal(assessMemory(disabled, access).allowed, false);
  assert.equal(assessMemory(disabled, { ...access, role: 'user' }).allowed, true);
});
