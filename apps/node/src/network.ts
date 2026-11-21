import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { ProxyAgent, fetch as undiciFetch } from 'undici';
import { normalizeModelProxyUrl } from '@super-agent/protocol';
import type { NodeConfig } from './config.js';

export interface NetworkOptions {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  readSystemProxy?: () => Promise<string>;
}
export interface NetworkSetup {
  source: 'device' | 'environment' | 'config' | 'macos-system' | 'direct';
  proxied: boolean;
  /** Canonical proxy for model clients. Never log or return this to the control service. */
  url?: string;
  restore: () => void;
  reset: () => void;
}
const LOCAL_BYPASS = ['localhost', '127.0.0.1', '::1', '[::1]'];
function preferred(env: NodeJS.ProcessEnv, name: string): string | undefined { return env[name.toLowerCase()] || env[name] || undefined; }
function bypassList(env: NodeJS.ProcessEnv): string {
  return [...new Set([...(env.NO_PROXY ?? '').split(','), ...(env.no_proxy ?? '').split(','), ...LOCAL_BYPASS].map(value => value.trim()).filter(Boolean))].join(',');
}
export function macosProxySettings(text: string): { http?: string; https?: string } {
  const fields = new Map<string, string>();
  for (const match of text.matchAll(/^\s*([A-Za-z]+)\s*:\s*(.*?)\s*$/gm)) fields.set(match[1]!, match[2]!);
  const endpoint = (prefix: string) => {
    if (fields.get(`${prefix}Enable`) !== '1') return undefined;
    const host = fields.get(`${prefix}Proxy`), port = Number(fields.get(`${prefix}Port`));
    if (!host || /[\s/@?#]/.test(host) || !Number.isInteger(port) || port < 1 || port > 65535) throw new Error('macOS HTTP(S) proxy settings are invalid; set a local proxy_url');
    const authority = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
    return normalizeModelProxyUrl(`http://${authority}:${port}`);
  };
  const result = { http: endpoint('HTTP'), https: endpoint('HTTPS') };
  if (!result.http && !result.https && (fields.get('ProxyAutoConfigEnable') === '1' || fields.get('ProxyAutoDiscoveryEnable') === '1' || fields.get('SOCKSEnable') === '1')) throw new Error('macOS only exposes a PAC/SOCKS proxy; configure local proxy_url with an HTTP(S) endpoint');
  return result;
}
function setup(source: NetworkSetup['source'], url?: string): NetworkSetup {
  return { source, proxied: !!url, ...(url ? { url } : {}), restore() {}, reset() {} };
}
/**
 * Resolve the proxy for Grok and Codex only. Does not change process.env or the global fetch dispatcher.
 * Device setting wins. An empty device setting falls back to env, then node.json proxy_url, then the macOS system proxy.
 */
export async function configureNetwork(config: Pick<NodeConfig, 'proxy_url' | 'model_proxy_url'>, options: NetworkOptions = {}): Promise<NetworkSetup> {
  const env = options.env ?? process.env;
  const deviceProxy = typeof config.model_proxy_url === 'string' ? config.model_proxy_url.trim() : '';
  if (deviceProxy) return setup('device', normalizeModelProxyUrl(deviceProxy));
  const explicitHttp = preferred(env, 'HTTP_PROXY'), explicitHttps = preferred(env, 'HTTPS_PROXY'), explicitAll = preferred(env, 'ALL_PROXY');
  const explicit = explicitHttps ?? explicitHttp ?? explicitAll;
  if (explicit) return setup('environment', normalizeModelProxyUrl(explicit));
  if (config.proxy_url) return setup('config', normalizeModelProxyUrl(config.proxy_url));
  if ((options.platform ?? process.platform) === 'darwin') {
    let text: string;
    try { text = await (options.readSystemProxy ?? (async () => (await promisify(execFile)('/usr/sbin/scutil', ['--proxy'], { timeout: 3000 })).stdout))(); }
    catch { throw new Error('Cannot read macOS proxy settings; configure a local proxy_url or explicit HTTP(S)_PROXY'); }
    const system = macosProxySettings(text);
    const url = system.https ?? system.http;
    if (url) return setup('macos-system', url);
  }
  return setup('direct');
}
/** Keys to overlay onto a model child. Loopback tool bridges stay in NO_PROXY. */
export function proxyEnvOverlay(proxyUrl: string | undefined, base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const bypass = bypassList(base);
  const overlay: NodeJS.ProcessEnv = { NO_PROXY: bypass, no_proxy: bypass };
  if (proxyUrl) overlay.HTTP_PROXY = overlay.http_proxy = overlay.HTTPS_PROXY = overlay.https_proxy = overlay.ALL_PROXY = overlay.all_proxy = proxyUrl;
  return overlay;
}
/** Cloud `null` clears the device setting. An invalid value throws and must not be logged. */
export function acceptCloudModelProxy(current: string | undefined, cloud: string | null): { changed: boolean; value?: string } {
  const next = cloud === null || cloud.trim() === '' ? undefined : normalizeModelProxyUrl(cloud);
  if ((current ?? undefined) === next) return { changed: false, value: next };
  return { changed: true, value: next };
}
/** Fetch used only for the Grok API. Control-plane fetch stays on the global dispatcher. */
export function grokProxyFetch(proxyUrl: string | undefined): typeof fetch {
  if (!proxyUrl) return fetch;
  const dispatcher = new ProxyAgent(proxyUrl);
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    try { return await undiciFetch(input as Parameters<typeof undiciFetch>[0], { ...(init ?? {}), dispatcher } as Parameters<typeof undiciFetch>[1]) as unknown as Response; }
    catch (error) {
      if (error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError')) throw error;
      throw new Error('grok_proxy_unreachable');
    }
  }) as typeof fetch;
}
