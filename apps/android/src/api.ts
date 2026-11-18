import type { AuthConfig, Session } from './types';

export interface SessionStore { read(origin: string): Promise<Session | null>; write(origin: string, session: Session): Promise<void>; remove(origin: string): Promise<void> }
export class APIError extends Error { constructor(public readonly status: number, public readonly code: string, message: string) { super(message); this.name = 'APIError'; } }
export function validateServer(value: string): string {
  let url: URL;
  try { url = new URL(value.trim()); } catch { throw new APIError(0, 'invalid_server', '请输入云端 HTTPS 服务器地址'); }
  const local = ['localhost', '127.0.0.1', '10.0.2.2', '[::1]'].includes(url.hostname);
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) || url.username || url.password || url.search || url.hash || (url.pathname !== '/' && url.pathname !== '')) throw new APIError(0, 'invalid_server', '服务器应使用 HTTPS；HTTP 仅允许显式本机开发地址');
  return url.origin;
}
export class APIClient {
  server = '';
  session: Session | null = null;
  private refreshing: Promise<void> | null = null;
  constructor(private storage: SessionStore, private randomId: () => string, private transport: typeof fetch = fetch) {}
  async configure(value: string) { const server = validateServer(value); if (server !== this.server) { this.server = server; this.session = await this.storage.read(server); } }
  async setSession(value: Session) { await this.storage.write(this.server, value); this.session = value; }
  async signOut() { try { await this.request('/auth/logout', {method: 'POST', body: {}}); } finally { await this.storage.remove(this.server); this.session = null; } }
  async authConfig(): Promise<AuthConfig> { return this.request('/auth/config', {authenticated: false}); }
  async loginDevelopment(email: string, name: string) { const session = await this.request<Session>('/auth/dev', {method: 'POST', body: {email, name}, authenticated: false}); await this.setSession(session); return session; }
  async exchange(accessToken: string) { const session = await this.request<Session>('/auth/exchange', {method: 'POST', body: {access_token: accessToken}, authenticated: false}); await this.setSession(session); return session; }
  async request<T>(path: string, options: {method?: string; body?: unknown; version?: number; authenticated?: boolean; idempotencyKey?: string} = {}): Promise<T> {
    const method = options.method ?? 'GET';
    const key = options.idempotencyKey ?? (method === 'POST' ? this.randomId() : undefined);
    try { return await this.perform<T>(path, {...options, method, idempotencyKey: key}); }
    catch (error) {
      if (!(error instanceof APIError) || error.status !== 401 || options.authenticated === false || !this.session) throw error;
      await this.refresh();
      return this.perform<T>(path, {...options, method, idempotencyKey: key});
    }
  }
  private async refresh() {
    if (this.refreshing) return this.refreshing;
    const token = this.session?.refresh_token;
    if (!token) throw new APIError(401, 'signed_out', '会话已失效，请重新登录');
    this.refreshing = (async () => {
      try { const session = await this.perform<Session>('/auth/refresh', {method: 'POST', body: {refresh_token: token}, authenticated: false}); await this.setSession(session); }
      catch (error) { await this.storage.remove(this.server); this.session = null; throw error; }
    })();
    try { await this.refreshing; } finally { this.refreshing = null; }
  }
  private async perform<T>(path: string, options: {method: string; body?: unknown; version?: number; authenticated?: boolean; idempotencyKey?: string}): Promise<T> {
    if (!this.server || !path.startsWith('/') || path.includes('://')) throw new APIError(0, 'invalid_request', '先设置服务器地址');
    const headers: Record<string, string> = {Accept: 'application/json'};
    if (options.authenticated !== false) { if (!this.session) throw new APIError(401, 'signed_out', '请先登录'); headers.Authorization = `Bearer ${this.session.access_token}`; }
    if (options.idempotencyKey) headers['Idempotency-Key'] = options.idempotencyKey;
    if (options.version !== undefined) headers['If-Match'] = `"${options.version}"`;
    if (options.body !== undefined) headers['Content-Type'] = 'application/json';
    const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 25000);
    try {
      const response = await this.transport(`${this.server}/v1${path}`, {method: options.method, headers, body: options.body === undefined ? undefined : JSON.stringify(options.body), signal: controller.signal});
      const text = await response.text();
      let data: unknown = {};
      try { data = text ? JSON.parse(text) : {}; } catch { throw new APIError(response.status, 'invalid_response', '服务器返回了无法读取的内容'); }
      if (!response.ok) { const detail = data as {error?: {code?: string; message?: string}}; throw new APIError(response.status, detail.error?.code ?? 'http_error', detail.error?.message ?? `请求失败（${response.status}）`); }
      return data as T;
    } finally { clearTimeout(timer); }
  }
}
