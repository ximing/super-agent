import * as http from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { NodeConfig } from './config.js';

type ProxySetter = (environment: NodeJS.ProcessEnv) => (() => void);
export interface NetworkOptions {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  readSystemProxy?: () => Promise<string>;
  setGlobalProxy?: ProxySetter | null;
}
export interface NetworkSetup { source: 'environment' | 'config' | 'macos-system' | 'direct'; proxied: boolean; restore: () => void; reset: () => void }
function proxyUrl(value: string): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error('Invalid local proxy URL; use an HTTP(S) proxy URL'); }
  if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.search || url.hash || url.pathname !== '/') throw new Error('Local model networking requires an HTTP(S) proxy URL without a path; SOCKS/PAC proxies need an HTTP(S) endpoint');
  return url.href;
}
function preferred(env: NodeJS.ProcessEnv, name: string): string | undefined { return env[name.toLowerCase()] || env[name] || undefined; }
export function macosProxySettings(text: string): { http?: string; https?: string } {
  const fields = new Map<string, string>();
  for (const match of text.matchAll(/^\s*([A-Za-z]+)\s*:\s*(.*?)\s*$/gm)) fields.set(match[1]!, match[2]!);
  const endpoint = (prefix: string) => {
    if (fields.get(`${prefix}Enable`) !== '1') return undefined;
    const host = fields.get(`${prefix}Proxy`), port = Number(fields.get(`${prefix}Port`));
    if (!host || /[\s/@?#]/.test(host) || !Number.isInteger(port) || port < 1 || port > 65535) throw new Error('macOS HTTP(S) proxy settings are invalid; set a local proxy_url');
    const authority = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
    return proxyUrl(`http://${authority}:${port}`);
  };
  const result = { http: endpoint('HTTP'), https: endpoint('HTTPS') };
  if (!result.http && !result.https && (fields.get('ProxyAutoConfigEnable') === '1' || fields.get('ProxyAutoDiscoveryEnable') === '1' || fields.get('SOCKSEnable') === '1')) throw new Error('macOS only exposes a PAC/SOCKS proxy; configure local proxy_url with an HTTP(S) endpoint');
  return result;
}
/** One process-wide setup before network I/O. Never returns/logs the proxy URL. */
export async function configureNetwork(config: Pick<NodeConfig, 'proxy_url'>, options: NetworkOptions = {}): Promise<NetworkSetup> {
  const env = options.env ?? process.env;
  const original = { ...env };
  let source: NetworkSetup['source'] = 'direct', httpProxy: string | undefined, httpsProxy: string | undefined;
  const explicitHttp = preferred(env, 'HTTP_PROXY'), explicitHttps = preferred(env, 'HTTPS_PROXY'), explicitAll = preferred(env, 'ALL_PROXY');
  if (explicitHttp || explicitHttps || explicitAll) {
    source = 'environment';
    httpProxy = proxyUrl(explicitHttp ?? explicitAll ?? explicitHttps!);
    httpsProxy = proxyUrl(explicitHttps ?? explicitAll ?? explicitHttp!);
  } else if (config.proxy_url) {
    source = 'config'; httpProxy = httpsProxy = proxyUrl(config.proxy_url);
  } else if ((options.platform ?? process.platform) === 'darwin') {
    let text: string;
    try { text = await (options.readSystemProxy ?? (async () => (await promisify(execFile)('/usr/sbin/scutil', ['--proxy'], { timeout: 3000 })).stdout))(); }
    catch { throw new Error('Cannot read macOS proxy settings; configure a local proxy_url or explicit HTTP(S)_PROXY'); }
    const system = macosProxySettings(text);
    if (system.http || system.https) { source = 'macos-system'; httpProxy = system.http ?? system.https; httpsProxy = system.https ?? system.http; }
  }
  const bypass = [...new Set([...(env.NO_PROXY ?? '').split(','), ...(env.no_proxy ?? '').split(','), 'localhost', '127.0.0.1', '::1', '[::1]'].map(value => value.trim()).filter(Boolean))].join(',');
  const updates: NodeJS.ProcessEnv = { NO_PROXY: bypass, no_proxy: bypass };
  let undoGlobal: (() => void) | undefined;
  const install = () => {
    if (!httpProxy || !httpsProxy) return;
    const setter = options.setGlobalProxy === undefined ? (http as typeof http & { setGlobalProxyFromEnv?: ProxySetter }).setGlobalProxyFromEnv : options.setGlobalProxy;
    if (!setter) throw new Error('Proxy networking requires Node.js 24.14+ with http.setGlobalProxyFromEnv; upgrade this Mac node before starting (proxy bypass is refused)');
    Object.assign(updates, { HTTP_PROXY: httpProxy, http_proxy: httpProxy, HTTPS_PROXY: httpsProxy, https_proxy: httpsProxy });
    const previous = undoGlobal;
    undoGlobal = undefined;
    previous?.();
    try { undoGlobal = setter({ ...env, ...updates }); }
    catch { throw new Error('Local proxy initialization failed; verify the proxy configuration privately'); }
  };
  install();
  Object.assign(env, updates);
  let restored = false;
  return { source, proxied: !!httpProxy, restore: () => {
    if (restored) return; restored = true; undoGlobal?.();
    for (const key of Object.keys(updates)) if (original[key] === undefined) delete env[key]; else env[key] = original[key];
  }, reset: () => { if (!restored) install(); } };
}
