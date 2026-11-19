import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { Auth } from '../src/auth.js';
import { buildApp } from '../src/app.js';
import { Store, type Doc } from '../src/store.js';
import { NotificationService, ProviderSender, deliveryOutcome, noticeFromEvent, quietUntil, retryDelay, validatePreferences, type ProviderResult, type PushRegistration, type PushSender } from '../src/notifications.js';
import { requireCloudTestDatabase } from './cloud-guard.js';

const secret = 'notification-unit-test-key-at-least-32-bytes';
const project = randomUUID();
const registration: PushRegistration = { id: randomUUID(), provider: 'expo', platform: 'android', token: 'ExpoPushToken[unit_fixture_token]', environment: 'production', project_id: project };
const notice = { id: randomUUID(), kind: 'awaiting_review' as const, task_id: randomUUID() };

test('notification payload routing is generic, deduplicates state echoes and excludes private business text', () => {
  const payload = { status: 'awaiting_review', current_run_id: randomUUID(), goal: 'private-goal', tool_arguments: { token: 'private-token' } };
  const first = noticeFromEvent({ type: 'task.changed', task_id: notice.task_id, event_id: randomUUID(), payload });
  const second = noticeFromEvent({ type: 'task.changed', task_id: notice.task_id, event_id: randomUUID(), payload });
  assert.deepEqual(first, second);
  assert.equal(first!.kind, 'awaiting_review');
  assert.ok(!JSON.stringify(first).includes('private'));
  assert.equal(noticeFromEvent({ type: 'step.updated', payload }), null);
  assert.equal(noticeFromEvent({ type: 'message.created', payload: { id: randomUUID(), schedule_id: randomUUID(), content: 'private-goal' } })?.kind, 'schedule_reminder');
  assert.equal(noticeFromEvent({ type: 'task.changed', task_id: notice.task_id, payload: { status: 'waiting_device', reason_code: 'run_result_requires_reconciliation' } })?.kind, 'needs_input');
});

test('quiet hours cross midnight and real DST boundaries, with bounded exponential backoff', () => {
  const quiet = validatePreferences({ enabled: true, quiet_hours: { timezone: 'America/New_York', start: '22:00', end: '07:00' } }).quiet_hours;
  // The spring-forward night has only eight actual hours between 22:00 and 07:00.
  assert.equal(quietUntil(Date.parse('2026-03-08T03:00:00Z'), quiet), Date.parse('2026-03-08T11:00:00Z'));
  assert.equal(quietUntil(Date.parse('2026-03-08T11:00:00Z'), quiet), null);
  assert.equal(quietUntil(Date.parse('2026-11-01T02:00:00Z'), quiet), Date.parse('2026-11-01T12:00:00Z'));
  for (const hours of [{ timezone: 'Unknown/Private', start: '22:00', end: '07:00' }, { timezone: 'UTC', start: '22:00', end: '22:00' }, { timezone: 'UTC', start: '25:00', end: '07:00' }]) assert.throws(() => validatePreferences({ enabled: true, quiet_hours: hours }));
  assert.ok(retryDelay(3, () => 0) > retryDelay(1, () => 0));
  assert.ok(retryDelay(99, () => 1) <= 7200000);
});

test('Expo ticket is pending until receipt; invalid token, credentials and retry errors are classified without echoing provider text', async () => {
  const requests: { url: string; body: Doc }[] = [];
  const replies = [
    new Response(JSON.stringify({ data: { status: 'ok', id: 'unit-ticket' } })),
    new Response(JSON.stringify({ data: {} })),
    new Response(JSON.stringify({ data: { 'unit-ticket': { status: 'ok' } } })),
    new Response(JSON.stringify({ data: { status: 'error', message: 'private-token', details: { error: 'DeviceNotRegistered' } } })),
    new Response('', { status: 429 }),
    new Response('', { status: 403 }),
    new Response(JSON.stringify({ data: { status: 'error', details: { error: 'InvalidCredentials' } } }))
  ];
  const sender = new ProviderSender({ encryptionKey: secret, expo: { projectId: project, accessToken: 'unit-access-token' }, fetch: async (url, init) => {
    requests.push({ url: String(url), body: JSON.parse(String(init!.body)) });
    assert.equal((init!.headers as Doc).authorization, 'Bearer unit-access-token');
    return replies.shift()!;
  } });
  assert.deepEqual(await sender.send(registration, notice), { status: 'receipt_pending', ticket: 'unit-ticket' });
  assert.deepEqual(await sender.receipt('unit-ticket'), { status: 'receipt_pending', ticket: 'unit-ticket' });
  assert.deepEqual(await sender.receipt('unit-ticket'), { status: 'provider_accepted' });
  assert.deepEqual(await sender.send(registration, notice), { status: 'invalid_token', code: 'device_unregistered' });
  assert.equal((await sender.send(registration, notice)).status, 'retry');
  assert.equal((await sender.send(registration, notice)).status, 'unconfigured');
  assert.equal((await sender.send(registration, notice)).status, 'unconfigured');
  assert.equal(requests[0]!.body.data.task_id, notice.task_id);
  assert.equal(requests[0]!.body.channelId, 'assistant');
  assert.equal(requests[1]!.url, 'https://exp.host/--/api/v2/push/getReceipts');
  assert.deepEqual(requests[1]!.body, { ids: ['unit-ticket'] });
});

test('APNs sends authenticated HTTP/2 request, caches provider JWT and records acceptance rather than display', async () => {
  const key = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
  let status = 200; const headers: Doc[] = [];
  const sender = new ProviderSender({ encryptionKey: secret, now: () => Date.parse('2026-11-19T00:00:00Z'), apns: { privateKey: key, keyId: 'UNITKEY123', teamId: 'UNITTEAM12', topic: 'com.superagent.control', environment: 'sandbox' }, apnsRequest: async (origin, h, body) => {
    assert.equal(origin, 'https://api.sandbox.push.apple.com'); headers.push(h);
    assert.equal(h['apns-topic'], 'com.superagent.control'); assert.equal(h['apns-id'], notice.id);
    assert.equal(h['apns-push-type'], 'alert'); assert.equal(h[':method'], 'POST');
    assert.equal(JSON.parse(body).aps.alert.title, '任务等待验收');
    return { status, body: { reason: status === 410 ? 'Unregistered' : 'private-provider-message' } };
  } });
  const mac = { ...registration, provider: 'apns' as const, platform: 'macos' as const, token: 'a'.repeat(64), environment: 'sandbox' as const, project_id: null };
  assert.deepEqual(await sender.send(mac, notice), { status: 'provider_accepted' });
  status = 410; assert.deepEqual(await sender.send(mac, notice), { status: 'invalid_token', code: 'device_unregistered' });
  status = 429; assert.equal((await sender.send(mac, notice)).status, 'retry');
  assert.equal(headers[0]!.authorization, headers[1]!.authorization);
  const malformed = new ProviderSender({ encryptionKey: secret, apns: { privateKey: 'not-a-key', keyId: 'UNIT', teamId: 'UNIT', topic: 'com.superagent.control', environment: 'sandbox' } });
  assert.deepEqual(await malformed.send(mac, notice), { status: 'unconfigured', code: 'provider_credentials_invalid' });
});

test('missing configuration never contacts a provider or claims success', async () => {
  const sender = new ProviderSender({ encryptionKey: secret, fetch: async () => { throw new Error('must-not-connect'); } });
  assert.deepEqual(await sender.send(registration, notice), { status: 'unconfigured', code: 'provider_unconfigured' });
  assert.deepEqual(await sender.receipt('unit-ticket'), { status: 'unconfigured', code: 'provider_unconfigured' });
});

test('receipt transport failures back off independently, retain the ticket and exhaust a bounded error budget', () => {
  let current: Doc = { attempts: 1, ticket: 'already-sent-ticket', status: 'receipt_pending' };
  let now = 0, previousDelay = 0;
  for (let attempt = 1; attempt <= 8; attempt++) {
    current = deliveryOutcome(current, { status: 'retry', code: 'provider_unavailable' }, now, () => 0);
    const delay = Date.parse(current.next_attempt_at) - now;
    assert.ok(delay > previousDelay); assert.ok(delay <= 3600000);
    assert.equal(current.receipt_retry_attempts, attempt); assert.equal(current.attempts, 1);
    assert.equal(current.ticket, 'already-sent-ticket'); assert.equal(current.status, attempt === 8 ? 'failed' : 'retry');
    previousDelay = delay; now += delay;
  }
  assert.equal(current.last_code, 'receipt_retries_exhausted');
  const stillProcessing = deliveryOutcome({ attempts: 1, ticket: 'ticket', receipt_retry_attempts: 2 }, { status: 'receipt_pending', ticket: 'ticket' }, now, () => 0);
  assert.equal(stillProcessing.receipt_retry_attempts, 0); assert.equal(stillProcessing.attempts, 1);
  assert.equal(Date.parse(stillProcessing.next_attempt_at) - now, 15 * 60000);
});

test('slow notification provider cannot stall later business dispatch and shutdown waits for both loops', { timeout: 10000 }, async () => {
  // No database call or local listener: this exercises the actual application
  // scheduler with the two owned ticker functions injected at its component seam.
  const app = await buildApp({ databaseUrl: 'postgresql://unused.invalid/unused_test', jwtSecret: secret, runScheduler: false });
  let businessCalls = 0, notificationCalls = 0, release!: () => void, entered!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { entered = resolve; });
  app.control.service.tick = async () => { businessCalls++; };
  app.control.notifications.tick = async () => { notificationCalls++; entered(); await blocked; };
  let first: Promise<void> | undefined, second: Promise<void> | undefined;
  try {
    await app.ready(); first = app.control.tick(); await started;
    await new Promise(resolve => setImmediate(resolve));
    second = app.control.tick(); await new Promise(resolve => setImmediate(resolve));
    assert.equal(businessCalls, 2, 'new business dispatch proceeds while provider is blocked');
    assert.equal(notificationCalls, 1, 'provider loop remains single-flight');
    let closed = false; const closing = app.close().then(() => { closed = true; });
    await new Promise(resolve => setImmediate(resolve)); assert.equal(closed, false);
    release(); await Promise.all([first, second, closing]); assert.equal(closed, true);
  } finally { release(); await Promise.allSettled([first, second]); await app.close(); }
});

const databaseUrl = process.env.TEST_DATABASE_URL;
if (databaseUrl) requireCloudTestDatabase(databaseUrl, process.env.TEST_MIGRATION_DATABASE_URL);
test('cloud notification outbox: restart, receipts, owner transfer and logout serialize actual PG claims without real push', { skip: !databaseUrl, timeout: 120000 }, async t => {
  const store = new Store(databaseUrl!), tenants: string[] = [], users: string[] = [];
  const scoped = Object.assign(Object.create(store), { tenants: async () => tenants }) as Store;
  const auth = new Auth(store, { databaseUrl: databaseUrl!, jwtSecret: secret, allowDevAuth: true });
  let now = Date.now(), sendCount = 0;
  let behavior = async (): Promise<ProviderResult> => ({ status: 'unconfigured', code: 'provider_unconfigured' });
  let receiptBehavior = async (): Promise<ProviderResult> => ({ status: 'invalid_token', code: 'device_unregistered' });
  const sender: PushSender = { configured: () => true, send: async () => { sendCount++; return behavior(); }, receipt: async () => receiptBehavior() };
  const service = () => new NotificationService(scoped, { encryptionKey: secret, sender, now: () => now, random: () => 0 });
  try {
    const schema = await store.pool.query("SELECT to_regclass('sa_push_token_owners') AS table_name");
    if (!schema.rows[0]?.table_name) { t.skip('Cloud TEST schema 003 is not deployed; no tables or migration are created by this test'); return; }
    const login = async () => {
      const session = await auth.development({ email: `notification-${randomUUID()}@example.com` }), p = await auth.principal(`Bearer ${session.access_token}`);
      tenants.push(p.tenant); users.push(p.id); return p;
    };
    const a = await login(), b = await login(), token = `ExpoPushToken[${randomUUID()}]`;
    let module = service();
    const register = (p: typeof a) => store.tenant(p.tenant, tx => module.register(tx, p.session!, { provider: 'expo', platform: 'android', token, project_id: project }));
    const emit = async (p: typeof a, key = randomUUID()) => store.tenant(p.tenant, async tx => {
      await tx.emit('message.created', { id: key, schedule_id: randomUUID(), content: 'private-business-content' });
      await module.collect(tx);
    });
    const deliveries = async (p: typeof a) => store.tenant(p.tenant, async tx => (await tx.client.query('SELECT data FROM sa_notification_deliveries WHERE tenant_id=$1 ORDER BY created_at,id', [tx.tenant])).rows.map(r => r.data as Doc));
    const regA = await register(a); assert.ok(!JSON.stringify(regA).includes(token));
    const unique = randomUUID(); await emit(a, unique); await emit(a, unique);
    assert.equal((await deliveries(a)).length, 1, 'stable event identity creates one durable delivery');
    const repeated = await register(a); assert.equal(repeated.version, regA.version, 'same-session registration is semantically idempotent');
    assert.equal((await deliveries(a))[0]!.registration_version, repeated.version);
    const raw = await store.tenant(a.tenant, async tx => (await tx.client.query('SELECT data FROM sa_push_registrations WHERE tenant_id=$1', [tx.tenant])).rows[0].data);
    assert.ok(!JSON.stringify(raw).includes(token)); assert.equal(raw.secret.ciphertext.length > 0, true);
    await module.tick(); assert.equal((await deliveries(a))[0]!.status, 'unconfigured'); assert.equal((await deliveries(a))[0]!.attempts, 0);
    behavior = async () => ({ status: 'receipt_pending', ticket: 'unit-persisted-ticket' }); now += 300001;
    await module.tick(); assert.equal((await deliveries(a))[0]!.status, 'receipt_pending');
    now += 15 * 60000 + 1; module = service(); await module.tick();
    assert.equal((await deliveries(a))[0]!.status, 'failed', 'new service instance reads persisted ticket receipt');
    assert.equal((await store.tenant(a.tenant, tx => module.registrations(tx))).items[0].enabled, false);

    await register(a); await emit(a); await module.tick();
    const onceSent = sendCount; receiptBehavior = async () => ({ status: 'retry', code: 'provider_unavailable' });
    let previousDelay = 0;
    for (let error = 1; error <= 8; error++) {
      let pending = (await deliveries(a)).find(d => d.status === 'receipt_pending' || d.status === 'retry')!;
      now = Date.parse(pending.next_attempt_at) + 1; module = service(); await module.tick();
      pending = (await deliveries(a)).find(d => d.ticket === 'unit-persisted-ticket' && d.receipt_retry_attempts === error)!;
      assert.ok(pending, 'receipt retry count survives service restart');
      const delay = Date.parse(pending.next_attempt_at) - now; assert.ok(delay > previousDelay); previousDelay = delay;
      assert.equal(sendCount, onceSent, 'receipt failure never resends original notification');
      assert.equal(pending.status, error === 8 ? 'failed' : 'retry');
    }
    await register(a); await emit(a); await register(b);
    const before = sendCount; await module.tick(); assert.equal(sendCount, before, 'new owner suppresses old tenant queued push');

    // A real PG advisory-lock race: once provider send has started, transfer must
    // wait for it to finish. No transport, HTTP listener, model or OS notification is used.
    await register(a); await emit(a);
    let entered!: () => void, release!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const blocked = new Promise<void>(resolve => { release = resolve; });
    behavior = async () => { entered(); await blocked; return { status: 'provider_accepted' }; };
    const sending = module.tick(); await started;
    let rebound = false; const rebinding = register(b).then(() => { rebound = true; });
    await new Promise(resolve => setTimeout(resolve, 75)); assert.equal(rebound, false, 'rebind waits for in-flight old-owner sender');
    release(); await Promise.all([sending, rebinding]); assert.equal(rebound, true);
    await emit(a); const afterRebind = sendCount; await module.tick(); assert.equal(sendCount, afterRebind);

    await register(a); await emit(a);
    const userBeforeLogout = (await store.pool.query('SELECT * FROM sa_users WHERE id=$1', [a.id])).rows[0];
    const replacementSession = await auth.session(userBeforeLogout), replacement = await auth.principal(`Bearer ${replacementSession.access_token}`);
    a.session = replacement.session;
    await register(a); const beforeSessionTransfer = sendCount; await module.tick();
    assert.equal(sendCount, beforeSessionTransfer, 'same tenant with a new session invalidates the old pending delivery');

    await register(a); await emit(a);
    const startedLogout = new Promise<void>(resolve => { entered = resolve; });
    const blockedLogout = new Promise<void>(resolve => { release = resolve; });
    behavior = async () => { entered(); await blockedLogout; return { status: 'provider_accepted' }; };
    const lastSending = module.tick(); await startedLogout;
    let loggedOut = false;
    const logout = store.tenant(a.tenant, async tx => { await module.revokeSession(tx, a.session!); await tx.client.query('UPDATE sa_sessions SET revoked_at=now() WHERE id=$1', [a.session]); }).then(() => { loggedOut = true; });
    await new Promise(resolve => setTimeout(resolve, 75)); assert.equal(loggedOut, false, 'logout does not complete while old-session send is active');
    release(); await Promise.all([lastSending, logout]);
    await emit(a); const afterLogout = sendCount; await module.tick(); assert.equal(sendCount, afterLogout);
    assert.equal((await store.tenant(a.tenant, tx => module.registrations(tx))).items[0].enabled, false);

    // APNs represents identical token bytes using either hex case. Rebinding a
    // different spelling must transfer one global owner, not create two owners.
    const userA = (await store.pool.query('SELECT * FROM sa_users WHERE id=$1', [a.id])).rows[0];
    const renewed = await auth.session(userA), a2 = await auth.principal(`Bearer ${renewed.access_token}`);
    const lower = 'abc123'.repeat(12), upper = lower.toUpperCase();
    const macB = await store.tenant(b.tenant, tx => module.register(tx, b.session!, { provider: 'apns', platform: 'macos', token: lower }));
    const macA = await store.tenant(a.tenant, tx => module.register(tx, a2.session!, { provider: 'apns', platform: 'macos', token: upper }));
    const owners = await store.pool.query('SELECT tenant_id FROM sa_push_token_owners WHERE registration_id=ANY($1::uuid[])', [[macA.id, macB.id]]);
    assert.equal(owners.rows.length, 1); assert.equal(owners.rows[0].tenant_id, a.tenant);
  } finally {
    // Only the two random test users and tenant rows created above are removed.
    for (const tenant of tenants) await store.tenant(tenant, async tx => {
      await tx.client.query('DELETE FROM sa_push_token_owners WHERE tenant_id=$1', [tenant]);
      for (const table of ['sa_notification_deliveries','sa_push_registrations','sa_notification_preferences','sa_notifications','sa_events','sa_streams']) await tx.client.query(`DELETE FROM ${table} WHERE tenant_id=$1`, [tenant]);
    });
    for (const user of users) { await store.pool.query('DELETE FROM sa_sessions WHERE user_id=$1', [user]); await store.pool.query('DELETE FROM sa_users WHERE id=$1', [user]); }
    await store.close();
  }
});

test('cloud actionable notifications: question echoes merge and resolved, accepted, cancelled or replaced work is suppressed', { skip: !databaseUrl, timeout: 120000 }, async t => {
  const store = new Store(databaseUrl!); let tenant: string | null = null, user: string | null = null;
  let sent = 0;
  const sender: PushSender = { configured: () => true, send: async () => { sent++; return { status: 'provider_accepted' }; }, receipt: async () => ({ status: 'provider_accepted' }) };
  try {
    const schema = await store.pool.query("SELECT to_regclass('sa_push_token_owners') AS table_name");
    if (!schema.rows[0]?.table_name) { t.skip('Cloud TEST schema 003 is not deployed'); return; }
    const auth = new Auth(store, { databaseUrl: databaseUrl!, jwtSecret: secret, allowDevAuth: true });
    const session = await auth.development({ email: `notification-actionable-${randomUUID()}@example.com` });
    const p = await auth.principal(`Bearer ${session.access_token}`); tenant = p.tenant; user = p.id;
    const scoped = Object.assign(Object.create(store), { tenants: async () => [p.tenant] }) as Store;
    const module = new NotificationService(scoped, { encryptionKey: secret, sender });
    await store.tenant(p.tenant, tx => module.register(tx, p.session!, { provider: 'expo', platform: 'android', token: `ExpoPushToken[${randomUUID()}]` }));
    const task = async (status: string, reason: string | null = null) => store.tenant(p.tenant, async tx => {
      const id = randomUUID(), run = randomUUID();
      const value = await tx.put('tasks', { status, reason_code: reason, current_run_id: run, delivery_status: status === 'awaiting_review' ? 'pending' : 'not_submitted' }, id);
      await tx.put('runs', { task_id: id, state: status === 'awaiting_review' ? 'succeeded' : status === 'failed' ? 'failed' : 'waiting_input' }, run);
      return value;
    });
    const changed = async (value: Doc) => store.tenant(p.tenant, async tx => { await tx.emit('task.changed', value, value.id, value.current_run_id); await module.collect(tx); });
    const forTask = async (id: string) => store.tenant(p.tenant, async tx => (await tx.all('notifications')).filter(n => n.task_id === id));
    const questionTask = await task('waiting_input');
    const ask = async () => store.tenant(p.tenant, async tx => {
      const question = await tx.put('questions', { task_id: questionTask.id, run_id: questionTask.current_run_id, status: 'open', text: 'private-question-content' });
      await tx.emit('question.created', question, questionTask.id, questionTask.current_run_id);
      await tx.emit('task.changed', questionTask, questionTask.id, questionTask.current_run_id);
      await module.collect(tx); return question;
    });
    const q1 = await ask();
    assert.equal((await forTask(questionTask.id)).length, 1, 'question.created + waiting_input emit one actionable notification');
    await module.tick(); assert.equal(sent, 1);
    await store.tenant(p.tenant, tx => tx.put('questions', { ...q1, status: 'resolved' }));
    const q2 = await ask();
    await store.tenant(p.tenant, async tx => {
      await tx.put('questions', { ...q2, status: 'resolved' });
      await tx.put('tasks', { ...questionTask, status: 'running' });
    });
    await module.tick(); assert.equal(sent, 1, 'already answered question does not send a delayed push');
    const unknown = await task('waiting_input', 'result_unknown'); await changed(unknown); await module.tick();
    assert.equal(sent, 2, 'uncertain result without an open question still notifies');

    const accepted = await task('awaiting_review'); await changed(accepted);
    await store.tenant(p.tenant, tx => tx.put('tasks', { ...accepted, status: 'succeeded', delivery_status: 'accepted' }));
    const cancelled = await task('awaiting_review'); await changed(cancelled);
    await store.tenant(p.tenant, tx => tx.put('tasks', { ...cancelled, status: 'cancelled', cancellation_requested: true }));
    const failed = await task('failed'); await changed(failed);
    const oldUnknown = await task('waiting_input', 'result_unknown'); await changed(oldUnknown);
    for (const old of [failed, oldUnknown]) await store.tenant(p.tenant, async tx => {
      const run = await tx.put('runs', { task_id: old.id, state: 'running' });
      await tx.put('tasks', { ...old, status: 'running', reason_code: null, current_run_id: run.id });
    });
    await module.tick(); assert.equal(sent, 2, 'accepted/cancelled/retried work never sends its stale prompt');
    const staleIds = (await Promise.all([accepted, cancelled, failed, oldUnknown].map(v => forTask(v.id)))).flat().map(v => v.id);
    const suppressed = await store.tenant(p.tenant, async tx => (await tx.client.query('SELECT data FROM sa_notification_deliveries WHERE tenant_id=$1 AND data->>\'notification_id\'=ANY($2::text[])', [tx.tenant, staleIds])).rows);
    assert.equal(suppressed.length, 4); assert.ok(suppressed.every(v => v.data.status === 'suppressed' && v.data.last_code === 'item_resolved_or_replaced'));
    await store.tenant(p.tenant, async tx => { await tx.emit('message.created', { id: randomUUID(), schedule_id: randomUUID() }); await module.collect(tx); });
    await module.tick(); assert.equal(sent, 3, 'schedule reminder without a task still sends');
  } finally {
    if (tenant) await store.tenant(tenant, async tx => {
      await tx.client.query('DELETE FROM sa_push_token_owners WHERE tenant_id=$1', [tenant]);
      for (const table of ['sa_notification_deliveries','sa_push_registrations','sa_notification_preferences','sa_notifications','sa_questions','sa_runs','sa_tasks','sa_events','sa_streams']) await tx.client.query(`DELETE FROM ${table} WHERE tenant_id=$1`, [tenant]);
    });
    if (user) { await store.pool.query('DELETE FROM sa_sessions WHERE user_id=$1', [user]); await store.pool.query('DELETE FROM sa_users WHERE id=$1', [user]); }
    await store.close();
  }
});
