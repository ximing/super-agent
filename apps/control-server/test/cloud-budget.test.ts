import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { canonicalActivityId } from '@super-agent/protocol';
import { buildApp } from '../src/app.js';
import { ApiError } from '../src/store.js';
import { relateMemory } from '../src/memory-governance.js';
import { graphLock } from '../src/team.js';
import { requireCloudTestDatabase } from './cloud-guard.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
const migrationUrl = process.env.TEST_MIGRATION_DATABASE_URL;
if (databaseUrl) requireCloudTestDatabase(databaseUrl, migrationUrl);

test('cloud budget: cross-run remainder, review category, reservation identity and concurrent admission', { skip: !databaseUrl, timeout: 120000 }, async () => {
  const app = await buildApp({ databaseUrl: databaseUrl!, jwtSecret: 'cloud-budget-remainder-secret-at-least-32', allowDevAuth: true, runScheduler: false });
  try {
    const login = await app.inject({ method: 'POST', url: '/v1/auth/dev', payload: { email: `budget-${randomUUID()}@example.com` } });
    assert.equal(login.statusCode, 200);
    const session = login.json();
    const tenant = session.user.tenant_id;
    const headers = { authorization: `Bearer ${session.access_token}` };
    const fixture = await app.control.store.tenant(tenant, async tx => {
      const device = await tx.put('devices', { name: 'Budget fixture', last_seen_at: new Date().toISOString(), capabilities: { generation: 1, engines: [{ engine: 'codex', ready: true, models: ['fixture'] }], slots: { worker: 1 } } });
      await tx.put('budgets', { monthly_limit_usd: null, task_limit_usd: null, category_limits: { worker: { max_model_calls: 1 } } }, tenant);
      const task = await app.control.service.createTask(tx, { goal: 'Stay within one model call', engine: 'codex', device_id: device.id });
      await tx.put('usage_records', { task_id: task.id, run_id: randomUUID(), category: 'worker', request_key: 'spent-call', usage_revision: 1, engine: 'codex', model_id: 'fixture', input_tokens: 10, output_tokens: 1, cost: { source: 'unavailable', quality: 'missing', amount: null, currency: null }, occurred_at: '2026-01-15T00:00:00.000Z' });
      return { device, task };
    });
    await app.control.service.dispatchTenant(tenant);
    const blocked = await app.control.store.tenant(tenant, tx => tx.need('tasks', fixture.task.id));
    assert.equal(blocked.current_run_id, null);
    assert.equal(blocked.reason_code, 'model_call_limit');
    const raised = await app.inject({ method: 'PUT', url: `/v1/tasks/${fixture.task.id}/budget`, headers: { ...headers, 'if-match': String(blocked.version) }, payload: { max_model_calls: 2 } });
    assert.equal(raised.statusCode, 200, raised.body);
    await app.control.service.dispatchTenant(tenant);
    const running = await app.control.store.tenant(tenant, tx => tx.need('tasks', fixture.task.id));
    assert.ok(running.current_run_id);
    const grant = await app.control.store.tenant(tenant, async tx => (await tx.all('budget_reservations')).find(item => item.run_id === running.current_run_id));
    assert.equal(grant?.activity_kind, 'run');
    assert.equal(grant?.activity_id, canonicalActivityId('run', running.current_run_id));
    assert.equal(grant?.operation_key, canonicalActivityId('run', running.current_run_id));
    assert.equal(grant?.task_id, fixture.task.id);
    assert.equal(grant?.run_id, running.current_run_id);
    assert.equal(grant?.limits.max_model_calls, 1);
    const review = await app.control.store.tenant(tenant, tx => app.control.service.reserveActivity(tx, { operation_key: `review:${fixture.task.id}`, category: 'review', activity_kind: 'review', activity_id: `review:${fixture.task.id}`, task_id: fixture.task.id }));
    assert.equal(review.category, 'review');
    assert.equal(review.limits.max_total_tokens, 40_000);
    assert.equal(review.run_id, null);
    const again = await app.control.store.tenant(tenant, tx => app.control.service.reserveActivity(tx, { operation_key: `review:${fixture.task.id}`, category: 'review', activity_kind: 'review', activity_id: `review:${fixture.task.id}`, task_id: fixture.task.id }));
    assert.equal(again.grant_id, review.grant_id);
  } finally { await app.close(); }
});

test('cloud budget: one unknown hold does not count as zero and a second admission waits', { skip: !databaseUrl, timeout: 120000 }, async () => {
  const app = await buildApp({ databaseUrl: databaseUrl!, jwtSecret: 'cloud-budget-concurrency-secret-at-least-32', allowDevAuth: true, runScheduler: false });
  try {
    const login = await app.inject({ method: 'POST', url: '/v1/auth/dev', payload: { email: `hold-${randomUUID()}@example.com` } });
    assert.equal(login.statusCode, 200);
    const tenant = login.json().user.tenant_id;
    await app.control.store.tenant(tenant, tx => tx.put('budgets', { monthly_limit_usd: '10', task_limit_usd: null }, tenant));
    const results = await Promise.allSettled([
      app.control.store.tenant(tenant, tx => app.control.service.reserveActivity(tx, { operation_key: 'hold-a', category: 'assistant', activity_kind: 'assistant', activity_id: 'hold-a' })),
      app.control.store.tenant(tenant, tx => app.control.service.reserveActivity(tx, { operation_key: 'hold-b', category: 'assistant', activity_kind: 'assistant', activity_id: 'hold-b' })),
    ]);
    const saved = results.filter(result => result.status === 'fulfilled');
    const rejected = results.filter(result => result.status === 'rejected');
    assert.equal(saved.length, 1);
    assert.equal(rejected.length, 1);
    assert.equal((rejected[0] as PromiseRejectedResult).reason instanceof ApiError ? (rejected[0] as PromiseRejectedResult).reason.code : '', 'budget_unknown');
    const rows = await app.control.store.tenant(tenant, tx => tx.all('budget_reservations'));
    assert.equal(rows.filter(row => row.status === 'reserved').length, 1);
    assert.equal(rows.find(row => row.status === 'reserved')?.amount, null);
  } finally { await app.close(); }
});

test('cloud memory: future expiry keeps verified state and concurrent conflicts both persist', { skip: !databaseUrl, timeout: 120000 }, async () => {
  const app = await buildApp({ databaseUrl: databaseUrl!, jwtSecret: 'cloud-memory-relation-secret-at-least-32', allowDevAuth: true, runScheduler: false });
  try {
    const login = await app.inject({ method: 'POST', url: '/v1/auth/dev', payload: { email: `memory-${randomUUID()}@example.com` } });
    assert.equal(login.statusCode, 200);
    const tenant = login.json().user.tenant_id;
    const [left, right, third] = [randomUUID(), randomUUID(), randomUUID()];
    await app.control.store.tenant(tenant, async tx => {
      for (const id of [left, right, third]) await tx.put('memories', { title: id, content: 'fixture', status: 'verified', governance: { verification: 'verified', conflicts_with: [], operations: [], version: 1 } }, id);
      const dated = await relateMemory(tx, left, { relation: 'expires', operation_key: 'future-expiry', valid_until: '2099-01-01T00:00:00.000Z' });
      assert.equal(dated.governance.verification, 'verified');
      assert.equal(dated.governance.valid_until, '2099-01-01T00:00:00.000Z');
      const replaced = await relateMemory(tx, right, { relation: 'supersedes', other_id: third, operation_key: 'supersede-once' });
      const other = await tx.get('memories', third);
      assert.equal(replaced.governance.supersedes, third);
      assert.equal(other?.governance.verification, 'superseded');
      assert.equal(other?.governance.superseded_by, right);
    });
    const [alpha, beta] = [randomUUID(), randomUUID()];
    await app.control.store.tenant(tenant, async tx => {
      await tx.put('memories', { title: 'base', content: 'fixture', status: 'verified', governance: { verification: 'verified', conflicts_with: [], operations: [], version: 1 } }, alpha);
      await tx.put('memories', { title: 'one', content: 'fixture', status: 'verified', governance: { verification: 'verified', conflicts_with: [], operations: [] } }, beta);
      await tx.put('memories', { title: 'two', content: 'fixture', status: 'verified', governance: { verification: 'verified', conflicts_with: [], operations: [] } }, randomUUID());
    });
    const gamma = randomUUID();
    await app.control.store.tenant(tenant, tx => tx.put('memories', { title: 'gamma', content: 'fixture', status: 'verified', governance: { verification: 'verified', conflicts_with: [], operations: [] } }, gamma));
    await Promise.all([
      app.control.store.tenant(tenant, tx => relateMemory(tx, alpha, { relation: 'conflicts', other_id: beta, operation_key: 'conflict-beta' })),
      app.control.store.tenant(tenant, tx => relateMemory(tx, alpha, { relation: 'conflicts', other_id: gamma, operation_key: 'conflict-gamma' })),
    ]);
    const merged = await app.control.store.tenant(tenant, tx => tx.need('memories', alpha));
    assert.ok(merged.governance.conflicts_with.includes(beta));
    assert.ok(merged.governance.conflicts_with.includes(gamma));
    assert.ok(merged.governance.version >= 3);
  } finally { await app.close(); }
});

test('cloud budget: merge keeps sibling task limits and historical remainder', { skip: !databaseUrl, timeout: 120000 }, async () => {
  const app = await buildApp({ databaseUrl: databaseUrl!, jwtSecret: 'cloud-budget-merge-secret-at-least-32', allowDevAuth: true, runScheduler: false });
  try {
    const login = await app.inject({ method: 'POST', url: '/v1/auth/dev', payload: { email: `merge-${randomUUID()}@example.com` } });
    const session = login.json(), headers = { authorization: `Bearer ${session.access_token}` }, tenant = session.user.tenant_id;
    const fixture = await app.control.store.tenant(tenant, async tx => {
      const device = await tx.put('devices', { name: 'Merge fixture', last_seen_at: new Date().toISOString(), capabilities: { generation: 1, engines: [{ engine: 'codex', ready: true, models: ['fixture'] }], slots: { worker: 1 } } });
      const task = await app.control.service.createTask(tx, { goal: 'Keep every ceiling', engine: 'codex', device_id: device.id });
      const stored = { max_total_tokens: 100, max_model_calls: 1, max_tool_steps: 4, max_runtime_ms: 60000 };
      const seeded = await tx.put('tasks', { ...task, scope: { ...task.scope, budget: stored } });
      await tx.put('usage_records', { task_id: task.id, run_id: randomUUID(), category: 'worker', activity_id: 'historical', request_key: 'spent', usage_revision: 1, engine: 'codex', model_id: 'fixture', input_tokens: 10, output_tokens: 1, cost: { source: 'supplier_reported', quality: 'final', amount: '0.01', currency: 'USD' }, occurred_at: new Date().toISOString() });
      return { device, task: seeded };
    });
    const blocked = await app.inject({ method: 'PUT', url: `/v1/tasks/${fixture.task.id}/budget`, headers: { ...headers, 'if-match': String(fixture.task.version) }, payload: { max_model_calls: 3 } });
    assert.equal(blocked.statusCode, 200, blocked.body);
    assert.deepEqual(blocked.json().scope.budget, { max_total_tokens: 100, max_model_calls: 3, max_tool_steps: 4, max_runtime_ms: 60000 });
    await app.control.service.dispatchTenant(tenant);
    const running = await app.control.store.tenant(tenant, tx => tx.need('tasks', fixture.task.id));
    const grant = await app.control.store.tenant(tenant, async tx => (await tx.all('budget_reservations')).find(item => item.run_id === running.current_run_id));
    assert.equal(grant?.limits.max_model_calls, 2);
    assert.equal(grant?.limits.max_total_tokens, 89);
    assert.equal(grant?.limits.max_tool_steps, 4);
    assert.equal(grant?.limits.max_runtime_ms, 60000);
    assert.equal(grant?.activity_id, canonicalActivityId('run', running.current_run_id));
    const account = await app.inject({ method: 'PUT', url: '/v1/budgets', headers, payload: { monthly_limit_usd: '12', task_limit_usd: '3' } });
    assert.equal(account.statusCode, 200, account.body);
    const categories = await app.inject({ method: 'PUT', url: '/v1/budgets', headers: { ...headers, 'if-match': String(account.json().version) }, payload: { category_limits: { worker: { max_model_calls: 2, max_total_tokens: 80 } } } });
    assert.equal(categories.json().monthly_limit_usd, '12');
    assert.equal(categories.json().task_limit_usd, '3');
    assert.equal(categories.json().category_limits.worker.max_total_tokens, 80);
    const money = await app.inject({ method: 'PUT', url: '/v1/budgets', headers: { ...headers, 'if-match': String(categories.json().version) }, payload: { monthly_limit_usd: '15' } });
    assert.equal(money.json().monthly_limit_usd, '15');
    assert.equal(money.json().task_limit_usd, '3');
    assert.equal(money.json().category_limits.worker.max_model_calls, 2);
    assert.equal(money.json().category_limits.worker.max_total_tokens, 80);
  } finally { await app.close(); }
});

test('cloud budget: expired in-force holds block admission and a stale assistant heartbeat does not', { skip: !databaseUrl, timeout: 120000 }, async () => {
  const app = await buildApp({ databaseUrl: databaseUrl!, jwtSecret: 'cloud-budget-force-secret-at-least-32', allowDevAuth: true, runScheduler: false });
  try {
    const login = await app.inject({ method: 'POST', url: '/v1/auth/dev', payload: { email: `force-${randomUUID()}@example.com` } });
    const tenant = login.json().user.tenant_id;
    const runId = randomUUID(), taskId = randomUUID(), deviceId = randomUUID();
    await app.control.store.tenant(tenant, async tx => {
      await tx.put('budgets', { monthly_limit_usd: '5', task_limit_usd: '4' }, tenant);
      await tx.put('devices', { name: 'Hold fixture', last_seen_at: new Date().toISOString(), capabilities: { generation: 1, engines: [], tools: [], slots: { worker: 1 } } }, deviceId);
      await tx.put('tasks', { title: 'Protected hold', goal: 'Keep the expired run hold', status: 'running', engine: 'codex', device_id: deviceId, deliverables: [] }, taskId);
      await tx.put('runs', { id: runId, task_id: taskId, device_id: deviceId, engine: 'codex', model_id: 'fixture', state: 'running', lease_epoch: '1', lease_expires_at: new Date(Date.now() + 600000).toISOString(), summary: 'running' }, runId);
      await tx.put('budget_reservations', { operation_key: canonicalActivityId('run', runId), activity_kind: 'run', activity_id: canonicalActivityId('run', runId), run_id: runId, category: 'worker', status: 'reserved', amount: '4', money_treatment: 'known', expires_at: '2020-01-01T00:00:00.000Z' });
    });
    await assert.rejects(() => app.control.store.tenant(tenant, tx => app.control.service.reserveActivity(tx, { operation_key: 'another-known', activity_kind: 'assistant', activity_id: 'another-known', category: 'assistant' })), (error: unknown) => error instanceof ApiError && error.code === 'budget_exhausted');
    const summary = await app.control.store.tenant(tenant, tx => app.control.service.budget(tx));
    assert.equal(summary.reserved_hold_usd, '4');
    await app.control.store.tenant(tenant, async tx => { await graphLock(tx); await app.control.service.sweepReservations(tx); });
    const renewed = await app.control.store.tenant(tenant, async tx => (await tx.all('budget_reservations')).find(row => row.run_id === runId));
    assert.equal(renewed?.status, 'reserved');
    assert.equal(renewed?.amount, '4');
    assert.ok(Date.parse(renewed?.expires_at) > Date.now());
  } finally { await app.close(); }
});

test('cloud budget: an expired unknown run hold is not zero and blocks the next admission', { skip: !databaseUrl, timeout: 120000 }, async () => {
  const app = await buildApp({ databaseUrl: databaseUrl!, jwtSecret: 'cloud-budget-unknown-force-secret-32', allowDevAuth: true, runScheduler: false });
  try {
    const login = await app.inject({ method: 'POST', url: '/v1/auth/dev', payload: { email: `unknown-force-${randomUUID()}@example.com` } });
    const tenant = login.json().user.tenant_id;
    const runId = randomUUID(), taskId = randomUUID(), deviceId = randomUUID();
    await app.control.store.tenant(tenant, async tx => {
      await tx.put('budgets', { monthly_limit_usd: '10', task_limit_usd: null }, tenant);
      await tx.put('devices', { name: 'Unknown hold fixture', last_seen_at: new Date().toISOString(), capabilities: { generation: 1, engines: [], tools: [], slots: { worker: 1 } } }, deviceId);
      await tx.put('tasks', { title: 'Unknown hold', goal: 'Keep the expired unknown hold', status: 'running', engine: 'codex', device_id: deviceId, deliverables: [] }, taskId);
      await tx.put('runs', { id: runId, task_id: taskId, device_id: deviceId, engine: 'codex', model_id: 'fixture', state: 'running', lease_epoch: '1', lease_expires_at: new Date(Date.now() + 600000).toISOString(), summary: 'running' }, runId);
      await tx.put('budget_reservations', { operation_key: canonicalActivityId('run', runId), activity_kind: 'run', activity_id: canonicalActivityId('run', runId), run_id: runId, category: 'worker', status: 'reserved', amount: null, money_treatment: 'unknown', expires_at: '2020-01-01T00:00:00.000Z' });
    });
    await assert.rejects(() => app.control.store.tenant(tenant, tx => app.control.service.reserveActivity(tx, { operation_key: 'after-unknown', activity_kind: 'assistant', activity_id: 'after-unknown', category: 'assistant' })), (error: unknown) => error instanceof ApiError && error.code === 'budget_unknown');
    const summary = await app.control.store.tenant(tenant, tx => app.control.service.budget(tx));
    assert.equal(summary.reserved_hold_usd, '0');
    assert.equal(summary.reserved_unknown_count, 1);
  } finally { await app.close(); }
});

test('cloud budget: a stale assistant hold is not kept alive by another assistant lease', { skip: !databaseUrl, timeout: 120000 }, async () => {
  const app = await buildApp({ databaseUrl: databaseUrl!, jwtSecret: 'cloud-budget-stale-assistant-secret-32', allowDevAuth: true, runScheduler: false });
  try {
    const login = await app.inject({ method: 'POST', url: '/v1/auth/dev', payload: { email: `stale-${randomUUID()}@example.com` } });
    const tenant = login.json().user.tenant_id;
    const activityId = canonicalActivityId('assistant', randomUUID());
    await app.control.store.tenant(tenant, async tx => {
      await tx.put('budgets', { monthly_limit_usd: '10', task_limit_usd: '2' }, tenant);
      await tx.put('assistant_leases', { device_id: randomUUID(), epoch: '1', expires_at: new Date(Date.now() + 600000).toISOString() }, tenant);
      await tx.put('budget_reservations', { operation_key: activityId, activity_kind: 'assistant', activity_id: activityId, category: 'assistant', status: 'reserved', amount: '9', money_treatment: 'known', heartbeat_at: '2020-01-01T00:00:00.000Z', expires_at: '2020-01-01T00:00:00.000Z' });
    });
    await app.control.store.tenant(tenant, async tx => { await graphLock(tx); await app.control.service.sweepReservations(tx); });
    const expired = await app.control.store.tenant(tenant, async tx => (await tx.all('budget_reservations')).find(row => row.activity_id === activityId));
    assert.equal(expired?.status, 'expired');
    assert.equal(expired?.settlement_state, 'open');
    assert.equal(expired?.amount, '9');
    const admitted = await app.control.store.tenant(tenant, tx => app.control.service.reserveActivity(tx, { operation_key: 'fresh-assistant', activity_kind: 'assistant', activity_id: 'fresh-assistant', category: 'assistant' }));
    assert.equal(admitted.dollar_cap, 'not_enforced');
    assert.equal(admitted.money_treatment, 'known');
    const fresh = await app.control.store.tenant(tenant, async tx => (await tx.all('budget_reservations')).find(row => row.activity_id === 'fresh-assistant'));
    assert.equal(fresh?.amount, '2');
    assert.equal(fresh?.status, 'reserved');
  } finally { await app.close(); }
});

test('cloud budget: two known admissions cannot both pass one monthly cap', { skip: !databaseUrl, timeout: 120000 }, async () => {
  const app = await buildApp({ databaseUrl: databaseUrl!, jwtSecret: 'cloud-budget-known-race-secret-at-least-32', allowDevAuth: true, runScheduler: false });
  try {
    const login = await app.inject({ method: 'POST', url: '/v1/auth/dev', payload: { email: `race-${randomUUID()}@example.com` } });
    const tenant = login.json().user.tenant_id;
    await app.control.store.tenant(tenant, tx => tx.put('budgets', { monthly_limit_usd: '5', task_limit_usd: '4' }, tenant));
    const results = await Promise.allSettled([
      app.control.store.tenant(tenant, tx => app.control.service.reserveActivity(tx, { operation_key: 'known-a', activity_kind: 'assistant', activity_id: 'known-a', category: 'assistant' })),
      app.control.store.tenant(tenant, tx => app.control.service.reserveActivity(tx, { operation_key: 'known-b', activity_kind: 'assistant', activity_id: 'known-b', category: 'assistant' })),
    ]);
    const saved = results.filter(result => result.status === 'fulfilled');
    const rejected = results.filter(result => result.status === 'rejected');
    assert.equal(saved.length, 1);
    assert.equal(rejected.length, 1);
    assert.equal((rejected[0] as PromiseRejectedResult).reason instanceof ApiError ? (rejected[0] as PromiseRejectedResult).reason.code : '', 'budget_exhausted');
    const rows = await app.control.store.tenant(tenant, tx => tx.all('budget_reservations'));
    assert.equal(rows.filter(row => row.status === 'reserved').length, 1);
    assert.equal(rows.find(row => row.status === 'reserved')?.amount, '4');
  } finally { await app.close(); }
});

test('cloud memory: relation overlays an upstream memory without writing back to recall', { skip: !databaseUrl, timeout: 120000 }, async () => {
  const left = randomUUID(), right = randomUUID(), calls: { method: string }[] = [];
  const recallUser = `overlay-${randomUUID()}`;
  const rows = [left, right].map(id => ({ id, content: `记忆 ${id}`, type: 'fact', tags: ['existing'], version: 4, chainId: id, project: 'alpha', updatedAt: '2026-11-18T12:00:00Z' }));
  const recallFetch = (async (input: URL | string | Request, init?: RequestInit) => {
    const url = new URL(String(input)), method = init?.method ?? 'GET';
    calls.push({ method });
    if (url.pathname === '/api/auth/me') return Response.json({ user: { id: recallUser, email: `${recallUser}@example.com` } });
    const found = rows.find(memory => memory.id === url.pathname.split('/').at(-1));
    if (!found || method !== 'GET') return Response.json({ error: 'missing' }, { status: method === 'GET' ? 404 : 500 });
    return Response.json({ memory: found });
  }) as typeof fetch;
  const app = await buildApp({ databaseUrl: databaseUrl!, jwtSecret: 'cloud-memory-overlay-secret-at-least-32', allowDevAuth: true, runScheduler: false, recallFetch });
  try {
    const login = await app.inject({ method: 'POST', url: '/v1/auth/dev', payload: { email: `overlay-${randomUUID()}@example.com` } });
    const headers = { authorization: `Bearer ${login.json().access_token}` };
    const bound = await app.inject({ method: 'PUT', url: '/v1/settings/memory', headers, payload: { url: 'https://recall.aimo.plus', token: 'alice-pat', project: 'alpha' } });
    assert.equal(bound.statusCode, 200, bound.body);
    const current = await app.inject({ method: 'GET', url: `/v1/memories/${left}`, headers });
    assert.equal(current.statusCode, 200, current.body);
    const first = await app.inject({ method: 'POST', url: `/v1/memories/${left}/relations`, headers: { ...headers, 'if-match': String(current.json().version) }, payload: { relation: 'expires', operation_key: 'overlay-once', valid_until: '2099-01-01T00:00:00.000Z', governance_version: 0 } });
    assert.equal(first.statusCode, 200, first.body);
    assert.equal(first.json().governance.source, 'recall_overlay');
    assert.equal(first.json().governance.version, 1);
    const replay = await app.inject({ method: 'POST', url: `/v1/memories/${left}/relations`, headers: { ...headers, 'if-match': String(current.json().version) }, payload: { relation: 'expires', operation_key: 'overlay-once', valid_until: '2099-01-01T00:00:00.000Z' } });
    assert.equal(replay.statusCode, 200, replay.body);
    assert.equal(replay.json().governance.version, 1);
    const conflict = await app.inject({ method: 'POST', url: `/v1/memories/${left}/relations`, headers: { ...headers, 'if-match': String(current.json().version) }, payload: { relation: 'expires', operation_key: 'overlay-next', valid_until: '2099-01-01T00:00:00.000Z', governance_version: 0 } });
    assert.equal(conflict.statusCode, 409, conflict.body);
    const other = await app.inject({ method: 'GET', url: `/v1/memories/${right}`, headers });
    const superseded = await app.inject({ method: 'POST', url: `/v1/memories/${left}/relations`, headers: { ...headers, 'if-match': String(current.json().version) }, payload: { relation: 'supersedes', other_id: right, operation_key: 'overlay-super', governance_version: 1 } });
    assert.equal(superseded.statusCode, 200, superseded.body);
    assert.equal(superseded.json().governance.supersedes, right);
    const tenant = login.json().user.tenant_id;
    const otherRow = await app.control.store.tenant(tenant, tx => tx.get('memories', right));
    assert.equal(otherRow?.governance.superseded_by, left);
    assert.equal(otherRow?.governance.source, 'recall_overlay');
    assert.equal(other.json().version, 4);
    const missing = randomUUID();
    const absent = await app.inject({ method: 'POST', url: `/v1/memories/${missing}/relations`, headers: { ...headers, 'if-match': '1' }, payload: { relation: 'expires', operation_key: 'missing', valid_until: '2099-01-01T00:00:00.000Z' } });
    assert.equal(absent.statusCode, 404, absent.body);
    assert.equal(await app.control.store.tenant(tenant, tx => tx.get('memories', missing)), null);
    assert.equal(calls.some(call => call.method !== 'GET'), false);
  } finally { await app.close(); }
});

test('cloud messages: the same client id conflicts when the memory scope differs', { skip: !databaseUrl, timeout: 120000 }, async () => {
  const app = await buildApp({ databaseUrl: databaseUrl!, jwtSecret: 'cloud-message-scope-secret-at-least-32', allowDevAuth: true, runScheduler: false });
  try {
    const login = await app.inject({ method: 'POST', url: '/v1/auth/dev', payload: { email: `scope-${randomUUID()}@example.com` } });
    const headers = { authorization: `Bearer ${login.json().access_token}` };
    const clientId = randomUUID();
    const scope = { sites: ['Example.COM'], global_preference: false, project: 'alpha' };
    const first = await app.inject({ method: 'POST', url: '/v1/messages', headers, payload: { text: '记住范围', client_message_id: clientId, memory_scope: scope } });
    assert.equal(first.statusCode, 200, first.body);
    assert.deepEqual(first.json().memory_scope, { project: 'alpha', sites: ['example.com'], global_preference: false, statuses: ['verified'], max_version: null });
    const replay = await app.inject({ method: 'POST', url: '/v1/messages', headers, payload: { text: '记住范围', client_message_id: clientId, memory_scope: scope } });
    assert.equal(replay.statusCode, 200, replay.body);
    assert.equal(replay.json().id, first.json().id);
    const changed = await app.inject({ method: 'POST', url: '/v1/messages', headers, payload: { text: '记住范围', client_message_id: clientId, memory_scope: { sites: ['other.example'], global_preference: false } } });
    assert.equal(changed.statusCode, 409, changed.body);
  } finally { await app.close(); }
});
