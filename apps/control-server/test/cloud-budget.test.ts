import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { buildApp } from '../src/app.js';
import { ApiError } from '../src/store.js';
import { relateMemory } from '../src/memory-governance.js';
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
