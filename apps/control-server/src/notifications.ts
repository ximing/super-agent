import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';
import { connect, type OutgoingHttpHeaders } from 'node:http2';
import { importPKCS8, SignJWT } from 'jose';
import type { PoolClient } from 'pg';
import { ApiError, MIGRATION_LOCK_KEY, Tx, type Doc, type Store } from './store.js';

/** No task text, tool input, URL or provider error message enters the push payload. */
export type NotificationKind = 'needs_input' | 'awaiting_review' | 'task_failed' | 'schedule_reminder';
export type PushProvider = 'apns' | 'expo';
export interface QuietHours { timezone: string; start: string; end: string }
export interface NotificationPreferences { enabled: boolean; quiet_hours: QuietHours | null }
export interface PushRegistration {
  id: string; provider: PushProvider; platform: 'macos' | 'android'; token: string;
  environment: 'production' | 'sandbox'; project_id: string | null;
}
export interface PushNotice { id: string; kind: NotificationKind; task_id: string | null }
export type ProviderResult =
  | { status: 'provider_accepted' }
  | { status: 'receipt_pending'; ticket: string }
  | { status: 'retry'; code: string; retry_after_ms?: number }
  | { status: 'invalid_token'; code: string }
  | { status: 'failed'; code: string }
  | { status: 'unconfigured'; code: string };
export interface PushSender {
  configured(provider: PushProvider): boolean;
  send(registration: PushRegistration, notice: PushNotice): Promise<ProviderResult>;
  receipt(ticket: string): Promise<ProviderResult>;
}
export interface NotificationConfig {
  /** Dedicated server secret; tokens are AES-GCM encrypted with tenant-bound AAD. */
  encryptionKey: string;
  apns?: { keyId: string; teamId: string; privateKey: string; topic: string; environment: 'production' | 'sandbox' };
  expo?: { projectId: string; accessToken?: string };
  fetch?: typeof fetch;
  apnsRequest?: APNsRequest;
  sender?: PushSender;
  now?: () => number;
  random?: () => number;
}
type APNsRequest = (origin: string, headers: OutgoingHttpHeaders, body: string) => Promise<{ status: number; body: Doc }>;
const COPY: Record<NotificationKind, { title: string; body: string }> = {
  needs_input: { title: '助理需要你的判断', body: '有待处理事项，请打开工作台查看。' },
  awaiting_review: { title: '任务等待验收', body: '执行结果已提交，请打开工作台核对交付。' },
  task_failed: { title: '任务需要关注', body: '执行未完成，请打开工作台查看状态。' },
  schedule_reminder: { title: '定时提醒已到', body: '请打开工作台确认目标，确认后才会执行。' }
};
const UUID = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i;
const time = /^([01]\d|2[0-3]):[0-5]\d$/;
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
function identity(value: string): string {
  const h = digest(value); return `${h.slice(0,8)}-${h.slice(8,12)}-5${h.slice(13,16)}-a${h.slice(17,20)}-${h.slice(20,32)}`;
}
function invalid(message: string): never { throw new ApiError(422, 'invalid_notification_settings', message); }
export function validatePreferences(input: Doc): NotificationPreferences {
  if (typeof input.enabled !== 'boolean') invalid('需要明确通知是否开启');
  if (input.quiet_hours === null || input.quiet_hours === undefined) return { enabled: input.enabled, quiet_hours: null };
  const quiet = input.quiet_hours;
  if (!quiet || typeof quiet !== 'object' || !time.test(quiet.start) || !time.test(quiet.end) || quiet.start === quiet.end || typeof quiet.timezone !== 'string' || quiet.timezone.length > 100) invalid('静默时段格式无效');
  try { new Intl.DateTimeFormat('en', { timeZone: quiet.timezone }).format(); } catch { invalid('静默时区无效'); }
  return { enabled: input.enabled, quiet_hours: { timezone: quiet.timezone, start: quiet.start, end: quiet.end } };
}
/** Search actual instants instead of converting wall time: DST gaps and folds are respected. */
export function quietUntil(timestamp: number, quiet: QuietHours | null): number | null {
  if (!quiet) return null;
  const formatter = new Intl.DateTimeFormat('en-GB', { timeZone: quiet.timezone, hourCycle: 'h23', hour: '2-digit', minute: '2-digit' });
  const minutes = (v: string) => Number(v.slice(0,2)) * 60 + Number(v.slice(3));
  const start = minutes(quiet.start), end = minutes(quiet.end);
  const inside = (t: number) => {
    const parts = formatter.formatToParts(t);
    const m = Number(parts.find(p => p.type === 'hour')!.value) * 60 + Number(parts.find(p => p.type === 'minute')!.value);
    return start < end ? m >= start && m < end : m >= start || m < end;
  };
  if (!inside(timestamp)) return null;
  let candidate = Math.floor(timestamp / 60000) * 60000 + 60000;
  for (let i = 0; i < 26 * 60; i++, candidate += 60000) if (!inside(candidate)) return candidate;
  return timestamp + 26 * 3600000;
}
export function retryDelay(attempt: number, random = Math.random): number {
  return Math.min(3600000, 1000 * 2 ** Math.min(12, Math.max(0, attempt - 1))) * (1 + Math.max(0, Math.min(1, random())));
}
/** Receipt polling never resends the notification. Transport failures have their
 * own bounded error budget; normal provider processing takes the 15-minute path. */
export function deliveryOutcome(current: Doc, outcome: ProviderResult, now: number, random = Math.random): Doc {
  const attempts = Number(current.attempts) + (outcome.status === 'unconfigured' || current.ticket ? 0 : 1);
  const update: Doc = { ...current, attempts, claim_id: null, claim_until: null, last_code: 'code' in outcome ? outcome.code : null };
  if (outcome.status === 'invalid_token') update.status = 'failed';
  else if (outcome.status === 'receipt_pending') {
    update.status = 'receipt_pending'; update.ticket = outcome.ticket; update.receipt_retry_attempts = 0;
    update.receipt_started_at ??= new Date(now).toISOString();
    update.next_attempt_at = new Date(now + 15 * 60000).toISOString();
  } else if (outcome.status === 'retry' && current.ticket) {
    const errors = Number(current.receipt_retry_attempts ?? 0) + 1;
    update.receipt_retry_attempts = errors; update.status = errors >= 8 ? 'failed' : 'retry';
    if (errors >= 8) update.last_code = 'receipt_retries_exhausted';
    update.next_attempt_at = new Date(now + Math.max(outcome.retry_after_ms ?? 0, Math.min(3600000, 15 * retryDelay(errors, random)))).toISOString();
  } else if (outcome.status === 'retry' || outcome.status === 'unconfigured') {
    update.status = attempts >= 8 ? 'failed' : outcome.status;
    update.next_attempt_at = new Date(now + (outcome.status === 'unconfigured' ? 300000 : Math.max(outcome.retry_after_ms ?? 0, retryDelay(attempts, random)))).toISOString();
  } else update.status = outcome.status;
  return update;
}
interface NoticeSource { kind: NotificationKind; source_key: string; task_id: string | null; run_id: string | null; question_id: string | null }
export function noticeFromEvent(event: Doc): NoticeSource | null {
  const p = event.payload ?? {}, task = typeof event.task_id === 'string' && UUID.test(event.task_id) ? event.task_id : null;
  const candidateRun = p.current_run_id ?? event.run_id ?? p.run_id;
  const run = typeof candidateRun === 'string' && UUID.test(candidateRun) ? candidateRun : null;
  if (event.type === 'question.created' && typeof p.id === 'string' && UUID.test(p.id)) return { kind: 'needs_input', source_key: `question:${p.id}`, task_id: task, run_id: run, question_id: p.id };
  if (event.type === 'task.changed' && task) {
    const kind = p.status === 'awaiting_review' ? 'awaiting_review' : p.status === 'failed' ? 'task_failed' : p.status === 'waiting_input' || ['result_unknown','run_result_requires_reconciliation'].includes(p.reason_code) ? 'needs_input' : null;
    // Same state re-emitted by retries is one notification per run, not per stream event.
    if (kind) return { kind, source_key: `${kind}:${task}:${run ?? 'unassigned'}`, task_id: task, run_id: run, question_id: null };
  }
  if (event.type === 'message.created' && typeof p.schedule_id === 'string' && typeof p.id === 'string') return { kind: 'schedule_reminder', source_key: `schedule:${p.id}`, task_id: null, run_id: null, question_id: null };
  return null;
}

/** Bounded HTTP/2 request with no redirect, no provider response text propagation. */
const apnsRequest: APNsRequest = (origin, headers, body) => new Promise((resolve, reject) => {
  const client = connect(origin); let settled = false;
  const finish = (error?: Error, result?: {status:number;body:Doc}) => {
    if (settled) return; settled = true; clearTimeout(timer); client.destroy();
    if (error) reject(error); else resolve(result!);
  };
  const timer = setTimeout(() => finish(new Error('push_timeout')), 10000); timer.unref();
  client.on('error', () => finish(new Error('push_transport')));
  const stream = client.request(headers); let status = 0; let chunks = '';
  stream.on('response', value => { status = Number(value[':status']); });
  stream.on('data', chunk => { chunks += chunk.toString(); if (chunks.length > 16384) finish(new Error('push_response_size')); });
  stream.on('error', () => finish(new Error('push_transport')));
  stream.on('end', () => { let value: Doc = {}; try { value = JSON.parse(chunks || '{}'); } catch { /* Only status/reason are used. */ } finish(undefined, { status, body: value }); });
  stream.end(body);
});

export class ProviderSender implements PushSender {
  private request: typeof fetch; private apple: APNsRequest;
  private appleToken: { value: string; expires: number } | null = null;
  constructor(private config: NotificationConfig) { this.request = config.fetch ?? fetch; this.apple = config.apnsRequest ?? apnsRequest; }
  configured(provider: PushProvider): boolean {
    const a = this.config.apns;
    return provider === 'apns' ? Boolean(a?.keyId && a.teamId && a.privateKey && a.topic) : Boolean(this.config.expo?.projectId);
  }
  async send(reg: PushRegistration, notice: PushNotice): Promise<ProviderResult> {
    if (!this.configured(reg.provider)) return { status: 'unconfigured', code: 'provider_unconfigured' };
    if (reg.provider === 'expo') {
      if (reg.project_id !== null && reg.project_id !== this.config.expo!.projectId) return { status: 'unconfigured', code: 'project_unconfigured' };
      const copy = COPY[notice.kind];
      return this.expo('/send', { to: reg.token, ...copy, data: { notification_id: notice.id, ...(notice.task_id ? { task_id: notice.task_id } : {}) }, channelId: 'assistant', sound: 'default', ttl: 86400, collapseId: notice.id, tag: notice.id });
    }
    const a = this.config.apns!;
    if (reg.environment !== a.environment) return { status: 'unconfigured', code: 'environment_unconfigured' };
    const now = this.config.now?.() ?? Date.now();
    try {
      if (!this.appleToken || this.appleToken.expires <= now) {
        const key = await importPKCS8(a.privateKey, 'ES256');
        const value = await new SignJWT({}).setProtectedHeader({ alg: 'ES256', kid: a.keyId }).setIssuer(a.teamId).setIssuedAt(Math.floor(now / 1000)).sign(key);
        this.appleToken = { value, expires: now + 50 * 60000 };
      }
    } catch { return { status: 'unconfigured', code: 'provider_credentials_invalid' }; }
    try {
      const response = await this.apple(a.environment === 'sandbox' ? 'https://api.sandbox.push.apple.com' : 'https://api.push.apple.com', {
        ':method': 'POST', ':path': `/3/device/${reg.token}`, authorization: `bearer ${this.appleToken.value}`, 'apns-topic': a.topic,
        'apns-push-type': 'alert', 'apns-priority': '10', 'apns-expiration': String(Math.floor(now / 1000) + 86400), 'apns-id': notice.id, 'apns-collapse-id': notice.id
      }, JSON.stringify({ aps: { alert: COPY[notice.kind], sound: 'default' }, notification_id: notice.id, ...(notice.task_id ? { task_id: notice.task_id } : {}) }));
      if (response.status === 200) return { status: 'provider_accepted' };
      const reason = response.body.reason;
      if (response.status === 410 || ['BadDeviceToken', 'DeviceTokenNotForTopic', 'Unregistered'].includes(reason)) return { status: 'invalid_token', code: 'device_unregistered' };
      if (response.status === 429 || response.status >= 500) return { status: 'retry', code: 'provider_unavailable' };
      if (response.status === 403) { this.appleToken = null; return { status: 'unconfigured', code: 'provider_credentials_invalid' }; }
      return { status: 'failed', code: 'provider_rejected' };
    } catch { return { status: 'retry', code: 'provider_unavailable' }; }
  }
  async receipt(ticket: string): Promise<ProviderResult> {
    if (!this.configured('expo')) return { status: 'unconfigured', code: 'provider_unconfigured' };
    return this.expo('/getReceipts', { ids: [ticket] }, ticket);
  }
  private async expo(path: string, body: Doc, ticket?: string): Promise<ProviderResult> {
    try {
      const response = await this.request(`https://exp.host/--/api/v2/push${path}`, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10000),
        headers: { 'content-type': 'application/json', accept: 'application/json', ...(this.config.expo?.accessToken ? { authorization: `Bearer ${this.config.expo.accessToken}` } : {}) }, body: JSON.stringify(body) });
      if (response.status === 429 || response.status >= 500) return { status: 'retry', code: 'provider_unavailable' };
      if (response.status === 401 || response.status === 403) return { status: 'unconfigured', code: 'provider_credentials_invalid' };
      if (!response.ok) return { status: 'failed', code: 'provider_rejected' };
      const value = await response.json() as Doc;
      const receipt = ticket ? value.data?.[ticket] : Array.isArray(value.data) ? value.data[0] : value.data;
      if (!receipt && ticket) return { status: 'receipt_pending', ticket };
      if (receipt?.status === 'ok') return ticket ? { status: 'provider_accepted' } : typeof receipt.id === 'string' ? { status: 'receipt_pending', ticket: receipt.id } : { status: 'retry', code: 'provider_response_invalid' };
      const error = receipt?.details?.error;
      if (error === 'DeviceNotRegistered') return { status: 'invalid_token', code: 'device_unregistered' };
      if (error === 'MessageRateExceeded') return { status: 'retry', code: 'provider_rate_limited' };
      if (['InvalidCredentials', 'MismatchSenderId'].includes(error)) return { status: 'unconfigured', code: 'provider_credentials_invalid' };
      return { status: 'failed', code: 'provider_rejected' };
    } catch { return { status: 'retry', code: 'provider_unavailable' }; }
  }
}

const tables = { registrations: 'sa_push_registrations', deliveries: 'sa_notification_deliveries', preferences: 'sa_notification_preferences' } as const;
type Table = keyof typeof tables;
function row(raw: Doc): Doc { return { ...raw.data, id: raw.id, version: raw.version, created_at: new Date(raw.created_at).toISOString() }; }
async function get(tx: Tx, table: Table, id: string, lock = false): Promise<Doc | null> {
  const result = await tx.client.query(`SELECT id,data,version,created_at FROM ${tables[table]} WHERE tenant_id=$1 AND id=$2${lock ? ' FOR UPDATE' : ''}`, [tx.tenant, id]);
  return result.rows[0] ? row(result.rows[0]) : null;
}
async function put(tx: Tx, table: Table, value: Doc, id = value.id ?? randomUUID()): Promise<Doc> {
  const data = { ...value }; delete data.version; delete data.created_at; delete data.updated_at; data.id = id;
  const result = await tx.client.query(`INSERT INTO ${tables[table]} (tenant_id,id,data) VALUES($1,$2,$3) ON CONFLICT(tenant_id,id) DO UPDATE SET data=EXCLUDED.data,version=${tables[table]}.version+1,updated_at=now() RETURNING id,data,version,created_at`, [tx.tenant, id, data]);
  return row(result.rows[0]);
}
interface Claimed { tenant: string; delivery: Doc; registration: PushRegistration; notice: PushNotice; tokenHash: string; sessionId: string }

/** Durable PG outbox. tick can run on many replicas; no network occurs inside a tenant transaction.
 * Provider acceptance is not proof of device display. At-least-once external delivery remains
 * possible after provider acceptance + process crash; stable collapse/id keys minimize duplicates.
 */
export class NotificationService {
  private key: Buffer; private sender: PushSender; private clock: () => number; private random: () => number;
  private ticking = false;
  constructor(private store: Store, private config: NotificationConfig) {
    if (Buffer.byteLength(config.encryptionKey) < 32) throw new Error('Notification encryption key must have at least 32 bytes');
    this.key = createHash('sha256').update(`super-agent-push-v1:${config.encryptionKey}`).digest();
    this.sender = config.sender ?? new ProviderSender(config); this.clock = config.now ?? Date.now; this.random = config.random ?? Math.random;
  }
  private encrypt(tenant: string, token: string): Doc {
    const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', this.key, iv); cipher.setAAD(Buffer.from(tenant));
    return { iv: iv.toString('base64'), ciphertext: Buffer.concat([cipher.update(token, 'utf8'), cipher.final()]).toString('base64'), tag: cipher.getAuthTag().toString('base64') };
  }
  private decrypt(tenant: string, secret: Doc): string {
    const cipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(secret.iv, 'base64')); cipher.setAAD(Buffer.from(tenant)); cipher.setAuthTag(Buffer.from(secret.tag, 'base64'));
    return Buffer.concat([cipher.update(Buffer.from(secret.ciphertext, 'base64')), cipher.final()]).toString('utf8');
  }
  private publicRegistration(value: Doc): Doc {
    const matches = value.provider === 'expo' ? value.project_id === null || value.project_id === this.config.expo?.projectId : value.environment === this.config.apns?.environment;
    return { id: value.id, provider: value.provider, platform: value.platform, enabled: value.enabled, environment: value.environment, project_id: value.project_id, version: value.version,
      status: !value.enabled ? 'disabled' : this.sender.configured(value.provider) && (this.config.sender || matches) ? 'registered' : 'unconfigured' };
  }
  async register(tx: Tx, sessionId: string, input: Doc): Promise<Doc> {
    if (!UUID.test(sessionId)) invalid('通知需要有效登录会话');
    if (!(input.provider === 'apns' && input.platform === 'macos' || input.provider === 'expo' && input.platform === 'android')) invalid('通知设备类型无效');
    const rawToken = input.token;
    if (typeof rawToken !== 'string' || rawToken.length > 4096 || !(input.provider === 'apns' ? /^(?:[a-f\d]{2}){1,2048}$/i : /^(Exponent|Expo)PushToken\[[a-zA-Z0-9_-]{8,4000}\]$/).test(rawToken)) invalid('通知设备凭据无效');
    // APNs hexadecimal spelling is case-insensitive: canonicalize before the
    // global owner hash so upper/lowercase cannot bypass account isolation.
    const token = input.provider === 'apns' ? rawToken.toLowerCase() : rawToken;
    const environment = input.provider === 'apns' ? input.environment ?? this.config.apns?.environment ?? 'production' : 'production';
    if (!['production', 'sandbox'].includes(environment)) invalid('通知环境无效');
    const project = input.provider === 'expo' ? input.project_id ?? this.config.expo?.projectId ?? null : null;
    if (input.provider === 'expo' && project !== null && (typeof project !== 'string' || !UUID.test(project))) invalid('Expo项目标识无效');
    const tokenHash = digest(`${input.provider}:${token}`), id = identity(`${tx.tenant}:${tokenHash}`);
    // Global owner lock is also held by the transport while sending. A successful
    // account transfer cannot race a previously claimed old-account send.
    await tx.client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`push-owner:${tokenHash}`]);
    const session = await tx.client.query('SELECT s.id FROM sa_sessions s JOIN sa_users u ON u.id=s.user_id WHERE s.id=$1 AND u.tenant_id=$2 AND s.revoked_at IS NULL AND s.expires_at>now()', [sessionId, tx.tenant]);
    if (!session.rows.length) throw new ApiError(401, 'session_revoked', '通知需要有效登录会话');
    const existing = await get(tx, 'registrations', id, true);
    let readable = false;
    if (existing) { try { readable = this.decrypt(tx.tenant, existing.secret) === token; } catch { /* Re-register repairs unreadable encryption after key rotation. */ } }
    const sameProject = input.provider === 'apns' || (existing?.project_id ?? this.config.expo?.projectId ?? null) === project;
    const unchanged = existing?.enabled === true && existing.provider === input.provider && existing.platform === input.platform && existing.session_id === sessionId && existing.environment === environment && sameProject && readable;
    // App restarts and retried POSTs must not invalidate already queued pushes.
    // An actual session/target change still increments registration_version.
    const saved = unchanged ? existing : await put(tx, 'registrations', { provider: input.provider, platform: input.platform, environment, project_id: project, token_hash: tokenHash, secret: this.encrypt(tx.tenant, token), session_id: sessionId, enabled: true }, id);
    await tx.client.query(`INSERT INTO sa_push_token_owners(token_hash,tenant_id,registration_id,session_id) VALUES($1,$2,$3,$4)
      ON CONFLICT(token_hash) DO UPDATE SET tenant_id=EXCLUDED.tenant_id,registration_id=EXCLUDED.registration_id,session_id=EXCLUDED.session_id,version=sa_push_token_owners.version+1,updated_at=now()`, [tokenHash, tx.tenant, id, sessionId]);
    await this.preferences(tx); // Initialize stream cursor now, not at the first scheduler pass.
    return this.publicRegistration(saved);
  }
  async registrations(tx: Tx): Promise<Doc> {
    const result = await tx.client.query('SELECT id,data,version,created_at FROM sa_push_registrations WHERE tenant_id=$1 ORDER BY created_at', [tx.tenant]);
    return { items: result.rows.map(raw => this.publicRegistration(row(raw))) };
  }
  async revoke(tx: Tx, id: string, sessionId: string): Promise<Doc> {
    if (!UUID.test(id)) invalid('通知设备标识无效');
    const initial = await get(tx, 'registrations', id);
    if (!initial || initial.session_id !== sessionId) throw new ApiError(404, 'not_found', '通知设备不存在');
    await tx.client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`push-owner:${initial.token_hash}`]);
    const old = await get(tx, 'registrations', id, true);
    if (!old || old.session_id !== sessionId) throw new ApiError(404, 'not_found', '通知设备不存在');
    return this.publicRegistration(await put(tx, 'registrations', { ...old, enabled: false }));
  }
  /** Call BEFORE updating sa_sessions on logout/revocation. Lock order is migration
   * shared gate -> sorted token locks -> rows. Already accepted pushes cannot be recalled. */
  async revokeSession(tx: Tx, sessionId: string): Promise<void> {
    if (!UUID.test(sessionId)) return;
    const result = await tx.client.query("SELECT id,data,version,created_at FROM sa_push_registrations WHERE tenant_id=$1 AND data->>'session_id'=$2 AND data->>'enabled'='true'", [tx.tenant, sessionId]);
    const registrations = result.rows.map(row);
    for (const tokenHash of [...new Set(registrations.map(r => r.token_hash as string))].sort()) await tx.client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`push-owner:${tokenHash}`]);
    for (const registration of registrations) {
      const current = await get(tx, 'registrations', registration.id, true);
      if (current?.session_id === sessionId && current.enabled) await put(tx, 'registrations', { ...current, enabled: false });
    }
  }
  async preferences(tx: Tx): Promise<Doc> {
    const old = await get(tx, 'preferences', tx.tenant);
    if (old) return { enabled: old.enabled, quiet_hours: old.quiet_hours, version: old.version };
    const stream = await tx.client.query('SELECT seq FROM sa_streams WHERE tenant_id=$1', [tx.tenant]);
    const value = { enabled: true, quiet_hours: null, cursor: String(stream.rows[0]?.seq ?? '0') };
    // Do not overwrite another replica's preferences/cursor initialization.
    await tx.client.query('INSERT INTO sa_notification_preferences(tenant_id,id,data) VALUES($1,$1,$2) ON CONFLICT(tenant_id,id) DO NOTHING', [tx.tenant, value]);
    const saved = await get(tx, 'preferences', tx.tenant);
    return { enabled: saved!.enabled, quiet_hours: saved!.quiet_hours, version: saved!.version };
  }
  async updatePreferences(tx: Tx, input: Doc): Promise<Doc> {
    const value = validatePreferences(input); await this.preferences(tx);
    const old = await get(tx, 'preferences', tx.tenant, true);
    if (input.version !== undefined && Number(input.version) !== old!.version) throw new ApiError(409, 'version_conflict', '通知设置已变化，请刷新后重试');
    const saved = await put(tx, 'preferences', { ...old, ...value }, tx.tenant);
    return { enabled: saved.enabled, quiet_hours: saved.quiet_hours, version: saved.version };
  }
  async enqueue(tx: Tx, kind: NotificationKind, sourceKey: string, taskId: string | null, refs: { run_id?: string | null; question_id?: string | null } = {}): Promise<Doc> {
    if (!COPY[kind] || !sourceKey || sourceKey.length > 300 || taskId !== null && !UUID.test(taskId)) invalid('通知事件无效');
    if (refs.run_id && !UUID.test(refs.run_id) || refs.question_id && !UUID.test(refs.question_id)) invalid('通知事件引用无效');
    const id = identity(`${tx.tenant}:${kind}:${sourceKey}`);
    const inserted = await tx.client.query(`INSERT INTO sa_notifications(tenant_id,id,data) VALUES($1,$2,$3)
      ON CONFLICT(tenant_id,id) DO NOTHING RETURNING id,data,version,created_at`, [tx.tenant, id, { id, kind, task_id: taskId, run_id: refs.run_id ?? null, question_id: refs.question_id ?? null, ...COPY[kind], source_key: sourceKey }]);
    if (!inserted.rows[0]) return (await tx.get('notifications', id))!;
    const notice = row(inserted.rows[0]);
    const registrations = await tx.client.query('SELECT id,data,version,created_at FROM sa_push_registrations WHERE tenant_id=$1 AND data->>\'enabled\'=\'true\'', [tx.tenant]);
    for (const raw of registrations.rows) {
      const registration = row(raw), deliveryId = identity(`${id}:${registration.id}`);
      await put(tx, 'deliveries', { notification_id: id, registration_id: registration.id, registration_version: registration.version, status: 'pending', attempts: 0, next_attempt_at: new Date(this.clock()).toISOString(), expires_at: new Date(this.clock() + 86400000).toISOString(), ticket: null, claim_id: null, claim_until: null }, deliveryId);
    }
    await tx.emit('notification.created', { id, kind, task_id: taskId }, taskId);
    return notice;
  }
  /** Durable event cursor commits with inbox + per-registration outbox rows. */
  async collect(tx: Tx): Promise<void> {
    await this.preferences(tx); const preferences = await get(tx, 'preferences', tx.tenant, true);
    const events = await tx.client.query('SELECT seq,data FROM sa_events WHERE tenant_id=$1 AND seq>$2 ORDER BY seq LIMIT 200', [tx.tenant, preferences!.cursor ?? '0']);
    for (const event of events.rows) {
      const notice = noticeFromEvent(event.data); if (!notice) continue;
      // question_ask emits question.created before its waiting_input Run report.
      // Keep one actionable question push rather than another generic state echo.
      if (notice.kind === 'needs_input' && !notice.question_id && notice.task_id && await this.openQuestion(tx, notice.task_id, notice.run_id)) continue;
      await this.enqueue(tx, notice.kind, notice.source_key, notice.task_id, notice);
    }
    if (events.rows.length) await put(tx, 'preferences', { ...preferences, cursor: String(events.rows.at(-1).seq) }, tx.tenant);
  }
  private async openQuestion(tx: Tx, taskId: string, runId: string | null): Promise<boolean> {
    const result = await tx.client.query("SELECT id FROM sa_questions WHERE tenant_id=$1 AND data->>'task_id'=$2 AND data->>'run_id' IS NOT DISTINCT FROM $3::text AND data->>'status'='open' LIMIT 1", [tx.tenant, taskId, runId]);
    return result.rows.length > 0;
  }
  private async stillActionable(tx: Tx, notice: Doc): Promise<boolean> {
    if (notice.kind === 'schedule_reminder' && !notice.task_id) return true;
    if (!notice.task_id) return false;
    const task = await tx.get('tasks', notice.task_id);
    if (!task || ['succeeded','cancelled'].includes(task.status) || task.cancellation_requested || (task.current_run_id ?? null) !== (notice.run_id ?? null)) return false;
    if (notice.kind === 'awaiting_review') return task.status === 'awaiting_review' && task.delivery_status !== 'accepted';
    if (notice.kind === 'task_failed') return task.status === 'failed';
    if (notice.kind !== 'needs_input') return false;
    if (notice.question_id) {
      const question = await tx.get('questions', notice.question_id);
      return Boolean(question && question.status === 'open' && question.task_id === task.id && (question.run_id ?? null) === (task.current_run_id ?? null) && !['succeeded','failed'].includes(task.status));
    }
    if (await this.openQuestion(tx, task.id, task.current_run_id ?? null)) return false;
    return task.status === 'waiting_input' || task.status === 'waiting_device' && ['result_unknown','run_result_requires_reconciliation'].includes(task.reason_code);
  }
  private async candidate(tx: Tx): Promise<{ id: string; tokenHash: string } | null> {
    const result = await tx.client.query(`SELECT d.id,r.data->>'token_hash' AS token_hash FROM sa_notification_deliveries d
      JOIN sa_push_registrations r ON r.tenant_id=d.tenant_id AND r.id=(d.data->>'registration_id')::uuid WHERE d.tenant_id=$1
      AND d.data->>'status' IN ('pending','retry','unconfigured','receipt_pending','sending')
      AND (d.data->>'next_attempt_at')::timestamptz <= $2::timestamptz
      AND (d.data->>'claim_until' IS NULL OR (d.data->>'claim_until')::timestamptz <= $2::timestamptz)
      ORDER BY d.created_at,d.id LIMIT 1`, [tx.tenant, new Date(this.clock()).toISOString()]);
    return result.rows[0] ? { id: result.rows[0].id, tokenHash: result.rows[0].token_hash } : null;
  }
  private async claim(tx: Tx, deliveryId: string): Promise<Claimed | null> {
    const now = this.clock(), result = await tx.client.query(`SELECT id,data,version,created_at FROM sa_notification_deliveries WHERE tenant_id=$1
      AND id=$3 AND data->>'status' IN ('pending','retry','unconfigured','receipt_pending','sending')
      AND (data->>'next_attempt_at')::timestamptz <= $2::timestamptz
      AND (data->>'claim_until' IS NULL OR (data->>'claim_until')::timestamptz <= $2::timestamptz)
      ORDER BY created_at,id LIMIT 1 FOR UPDATE SKIP LOCKED`, [tx.tenant, new Date(now).toISOString(), deliveryId]);
    if (!result.rows[0]) return null;
    const delivery = row(result.rows[0]), registration = await get(tx, 'registrations', delivery.registration_id, true), notice = await tx.get('notifications', delivery.notification_id);
    const preferences = await get(tx, 'preferences', tx.tenant);
    let code: string | null = null;
    const session = registration ? await tx.client.query('SELECT id FROM sa_sessions WHERE id=$1 AND revoked_at IS NULL AND expires_at>now()', [registration.session_id]) : null;
    if (!registration?.enabled || !session?.rows.length || !notice) code = 'registration_inactive';
    if (registration) {
      const owner = await tx.client.query('SELECT token_hash FROM sa_push_token_owners WHERE token_hash=$1 AND tenant_id=$2 AND registration_id=$3 AND session_id=$4', [registration.token_hash, tx.tenant, registration.id, registration.session_id]);
      if (!owner.rows.length) code = 'ownership_changed';
    }
    if (registration && registration.version !== delivery.registration_version) code = 'registration_changed';
    if (Date.parse(delivery.expires_at) <= now) code = delivery.ticket ? 'receipt_unavailable' : 'notification_expired';
    if (preferences?.enabled === false) code = 'notifications_disabled';
    if (notice && !delivery.ticket && !await this.stillActionable(tx, notice)) code = 'item_resolved_or_replaced';
    if (code) { await put(tx, 'deliveries', { ...delivery, status: code === 'receipt_unavailable' ? 'failed' : 'suppressed', last_code: code, claim_until: null }); return null; }
    const quiet = quietUntil(now, preferences?.quiet_hours ?? null);
    if (quiet && !delivery.ticket) { await put(tx, 'deliveries', { ...delivery, next_attempt_at: new Date(quiet).toISOString() }); return null; }
    let token: string;
    try { token = this.decrypt(tx.tenant, registration!.secret); }
    catch { await put(tx, 'deliveries', { ...delivery, status: 'unconfigured', last_code: 'registration_unreadable', next_attempt_at: new Date(now + 300000).toISOString() }); return null; }
    const claimed = await put(tx, 'deliveries', { ...delivery, status: 'sending', claim_id: randomUUID(), claim_until: new Date(now + 60000).toISOString() });
    return { tenant: tx.tenant, delivery: claimed, tokenHash: registration!.token_hash, sessionId: registration!.session_id, notice: { id: notice!.id, kind: notice!.kind, task_id: notice!.task_id }, registration: { id: registration!.id, provider: registration!.provider, platform: registration!.platform, token, environment: registration!.environment, project_id: registration!.project_id } };
  }
  private async finish(tx: Tx, claim: Claimed, outcome: ProviderResult): Promise<void> {
    const current = await get(tx, 'deliveries', claim.delivery.id, true);
    if (!current || current.claim_id !== claim.delivery.claim_id) return;
    const registration = await get(tx, 'registrations', current.registration_id, true);
    if (!registration || registration.version !== current.registration_version || !registration.enabled) {
      await put(tx, 'deliveries', { ...current, status: 'suppressed', last_code: 'registration_changed', claim_id: null, claim_until: null }); return;
    }
    const update = deliveryOutcome(current, outcome, this.clock(), this.random);
    if (outcome.status === 'invalid_token') {
      await put(tx, 'registrations', { ...registration, enabled: false, invalidated_at: new Date(this.clock()).toISOString() });
    }
    await put(tx, 'deliveries', update);
  }
  async tick(): Promise<void> {
    if (this.ticking) return; this.ticking = true;
    try {
      for (const tenant of await this.store.tenants()) {
        await this.store.tenant(tenant, tx => this.collect(tx));
        // Bounded throughput per tenant and one network request at a time per process.
        for (let i = 0; i < 10; i++) {
          if (!await this.deliverOne(tenant)) break;
        }
      }
    } finally { this.ticking = false; }
  }
  private async tenantOn<T>(connection: PoolClient, tenant: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
    try {
      await connection.query('BEGIN'); await connection.query('SET LOCAL ROLE super_agent_app');
      await connection.query("SELECT set_config('app.tenant_id',$1,true)", [tenant]);
      const result = await fn(new Tx(connection, tenant)); await connection.query('COMMIT'); return result;
    } catch (error) { await connection.query('ROLLBACK'); throw error; }
  }
  private async deliverOne(tenant: string): Promise<boolean> {
    const connection = await this.store.pool.connect(); let lock: string | null = null; let migrationLocked = false;
    try {
      // Same connection and lock order as Store.tenant: migration gate precedes
      // token lock and rows. Retaining the shared gate avoids migration/register
      // deadlocks during bounded network I/O; no transaction spans the network.
      await connection.query('SELECT pg_advisory_lock_shared($1)', [MIGRATION_LOCK_KEY]); migrationLocked = true;
      const candidate = await this.tenantOn(connection, tenant, tx => this.candidate(tx));
      if (!candidate) return false;
      lock = `push-owner:${candidate.tokenHash}`;
      await connection.query('SELECT pg_advisory_lock(hashtextextended($1,0))', [lock]);
      const claim = await this.tenantOn(connection, tenant, tx => this.claim(tx, candidate.id));
      if (!claim) return true;
      let result: ProviderResult;
      try { result = claim.delivery.ticket ? await this.sender.receipt(claim.delivery.ticket) : await this.sender.send(claim.registration, claim.notice); }
      catch { result = { status: 'retry', code: 'provider_unavailable' }; }
      await this.tenantOn(connection, tenant, tx => this.finish(tx, claim, result));
      return true;
    } finally {
      let safe = false;
      try {
        if (lock) await connection.query('SELECT pg_advisory_unlock(hashtextextended($1,0))', [lock]);
        if (migrationLocked) await connection.query('SELECT pg_advisory_unlock_shared($1)', [MIGRATION_LOCK_KEY]);
        safe = true;
      } finally { connection.release(!safe); }
    }
  }
}
