import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { buildApp } from '../src/app.js';
import { Store } from '../src/store.js';
import { requireCloudTestDatabase } from './cloud-guard.js';

const databaseUrl = process.env.TEST_DATABASE_URL, ownerUrl = process.env.TEST_MIGRATION_DATABASE_URL;
if (databaseUrl) requireCloudTestDatabase(databaseUrl, ownerUrl);
test('push HTTP routes bind only the current user/session, redact tokens and revoke registrations on logout', { skip: !databaseUrl || !ownerUrl, timeout: 60000 }, async () => {
  const migration = new Store(ownerUrl!); try { await migration.migrate(); } finally { await migration.close(); }
  const app = await buildApp({ databaseUrl: databaseUrl!, jwtSecret: 'push-api-only-synthetic-secret-over-32-bytes', allowDevAuth: true, runScheduler: false });
  const request = async (token: string | undefined, path: string, method: string = 'GET', payload?: unknown, headers: Record<string, string> = {}) => app.inject({ method: method as never, url: `/v1${path}`, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers }, ...(payload === undefined ? {} : { payload }) });
  try {
    const a = (await request(undefined, '/auth/dev', 'POST', { email: `push-api-${randomUUID()}@test.invalid` })).json();
    const b = (await request(undefined, '/auth/dev', 'POST', { email: `push-api-other-${randomUUID()}@test.invalid` })).json();
    const registration = { provider: 'expo', platform: 'android', token: `ExpoPushToken[TEST_ONLY_${randomUUID().replaceAll('-', '')}]` };
    assert.equal((await request(undefined, '/clients/push-registrations', 'POST', registration)).statusCode, 401);
    const first = await request(a.access_token, '/clients/push-registrations', 'POST', registration);
    assert.equal(first.statusCode, 200); assert.equal(first.json().status, 'unconfigured');
    assert.doesNotMatch(first.body, /ExpoPushToken|ciphertext|token_hash/);
    const repeated = await request(a.access_token, '/clients/push-registrations', 'POST', registration);
    assert.equal(repeated.json().version, first.json().version);
    assert.deepEqual((await request(b.access_token, '/clients/push-registrations')).json().items, []);
    assert.equal((await request(b.access_token, `/clients/push-registrations/${first.json().id}`, 'DELETE')).statusCode, 404);
    const preferences = (await request(a.access_token, '/settings/notifications')).json();
    assert.equal((await request(a.access_token, '/settings/notifications', 'PUT', { enabled: true, quiet_hours: { timezone: 'Asia/Shanghai', start: '22:00', end: '08:00' } }, { 'if-match': `"${preferences.version}"` })).statusCode, 200);
    assert.equal((await request(a.access_token, '/settings/notifications', 'PUT', { enabled: false, quiet_hours: null }, { 'if-match': `"${preferences.version}"` })).statusCode, 412);
    const logout = await request(a.access_token, '/auth/logout', 'POST', {}); assert.equal(logout.statusCode, 200);
    assert.equal((await request(a.access_token, '/clients/push-registrations')).statusCode, 401);
    const stored = await app.control.store.tenant(a.user.tenant_id, tx => tx.client.query('SELECT data FROM sa_push_registrations WHERE tenant_id=$1', [tx.tenant]));
    assert.equal(stored.rows[0].data.enabled, false);
    assert.notEqual(stored.rows[0].data.secret.ciphertext, registration.token);
  } finally { await app.close(); }
});
