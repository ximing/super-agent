import { readFile } from 'node:fs/promises';
import { sign } from 'node:crypto';
import type { NodeConfig } from './config.js';
export class ApiFailure extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); }
}
export class NodeApi {
  private token = '';
  private expires = 0;
  constructor(readonly config: NodeConfig, private readonly fetcher: typeof fetch = fetch) {}
  async authenticate(): Promise<void> {
    if (!this.config.device_id) throw new Error('Node is not paired; run pair and claim the code in your client');
    const challenge = await this.raw<{ nonce: string; challenge: string }>('/devices/auth/challenge', { device_id: this.config.device_id });
    const key = await readFile(this.config.private_key_path, 'utf8');
    const signature = sign(null, Buffer.from(challenge.challenge), key).toString('base64');
    const result = await this.raw<{ access_token: string; expires_in: number }>('/devices/auth/token', { device_id: this.config.device_id, nonce: challenge.nonce, signature });
    this.token = result.access_token; this.expires = Date.now() + result.expires_in * 1000;
  }
  async request<T = Record<string, unknown>>(path: string, body?: unknown, options: { runTicket?: string; assistantEpoch?: string; method?: string; idempotencyKey?: string; version?: number } = {}): Promise<T> {
    if (this.expires - Date.now() < 30_000) await this.authenticate();
    try { return await this.raw<T>(path, body, { ...options, token: this.token }); }
    catch (error) {
      if (error instanceof ApiFailure && error.status === 401) { await this.authenticate(); return this.raw<T>(path, body, { ...options, token: this.token }); }
      throw error;
    }
  }
  async raw<T = Record<string, unknown>>(path: string, body?: unknown, options: { token?: string; runTicket?: string; assistantEpoch?: string; method?: string; idempotencyKey?: string; version?: number } = {}): Promise<T> {
    if (options.version !== undefined && (!Number.isSafeInteger(options.version) || options.version < 1)) throw new Error('invalid_entity_version');
    const response = await this.fetcher(`${this.config.server_url}/v1${path}`, {
      method: options.method ?? (body === undefined ? 'GET' : 'POST'), headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...(options.token ? { authorization: `Bearer ${options.token}` } : {}), ...(options.runTicket ? { 'x-run-ticket': options.runTicket } : {}), ...(options.assistantEpoch ? { 'x-assistant-epoch': options.assistantEpoch } : {}), ...(options.idempotencyKey ? { 'idempotency-key': options.idempotencyKey } : {}), ...(options.version === undefined ? {} : { 'if-match': `"${options.version}"` }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) {
      let code = `http_${response.status}`, message = `Control API returned ${response.status}`;
      try { const data = await response.json() as { error?: { code: string; message: string } }; code = data.error?.code ?? code; message = data.error?.message ?? message; } catch { /* Keep non-sensitive fallback. */ }
      throw new ApiFailure(response.status, code, message);
    }
    if (response.status === 204) return {} as T;
    return await response.json() as T;
  }
}
