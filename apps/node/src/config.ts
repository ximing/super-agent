import { generateKeyPairSync } from 'node:crypto';
import { access, chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { constants } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
export interface NodeConfig {
  server_url: string;
  name: string;
  device_id?: string;
  tenant_id?: string;
  public_key: string;
  private_key_path: string;
  data_dir: string;
  poll_interval_ms: number;
  renew_interval_ms?: number;
  allow_shell: boolean;
  fake_runtime: boolean;
  codex: { enabled: boolean; command: string; model: string; sandbox: 'workspace-write' | 'danger-full-access' };
  grok: { enabled: boolean; mode?: 'api' | 'cli'; command?: string; model: string; key_env: string; key_file?: string; keychain_service?: string; base_url: string };
  assistant: boolean;
  assistant_engine?: 'codex' | 'grok';
  browser?: { enabled: boolean };
  proxy_url?: string;
  /** Last model proxy accepted from this device. Loopback is dialed on this computer. */
  model_proxy_url?: string | null;
}
export const defaultConfigPath = () => process.env.SUPER_AGENT_NODE_CONFIG ?? join(homedir(), '.super-agent', 'node.json');
export async function loadConfig(path = defaultConfigPath()): Promise<NodeConfig> {
  const config = JSON.parse(await readFile(path, 'utf8')) as NodeConfig;
  if (!config.server_url || !config.public_key || !config.private_key_path || !config.data_dir) throw new Error('Incomplete node config; run init first');
  const url = new URL(config.server_url);
  if (url.protocol !== 'https:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) throw new Error('Remote server must use HTTPS');
  config.server_url = config.server_url.replace(/\/$/, '').replace(/\/v1$/, '');
  return config;
}
export async function writeConfig(config: NodeConfig, path = defaultConfigPath()): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.tmp`;
  await writeFile(temp, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  const { rename } = await import('node:fs/promises'); await rename(temp, path); await chmod(path, 0o600);
}
export async function initConfig(server: string, name: string, path = defaultConfigPath(), fake = false): Promise<NodeConfig> {
  try { await access(path, constants.F_OK); throw new Error('Config already exists; refusing to overwrite device identity'); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
  const data = resolve(dirname(path)); await mkdir(data, { recursive: true, mode: 0o700 });
  const keys = generateKeyPairSync('ed25519', { privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
  const privatePath = join(data, 'device-key.pem');
  await writeFile(privatePath, keys.privateKey, { mode: 0o600, flag: 'wx' });
  let model = process.env.SUPER_AGENT_CODEX_MODEL ?? '';
  if (!model) {
    try { const publicConfig = await readFile(join(process.env.CODEX_HOME ?? join(homedir(), '.codex'), 'config.toml'), 'utf8'); model = /^model\s*=\s*"([^"]+)"/m.exec(publicConfig)?.[1] ?? ''; } catch { /* User can select a configured model in node.json. */ }
  }
  const config: NodeConfig = { server_url: server, name, public_key: keys.publicKey, private_key_path: privatePath, data_dir: data, poll_interval_ms: 2000, renew_interval_ms: 2000,
    allow_shell: false, fake_runtime: fake, codex: { enabled: true, command: 'codex', model: model || 'configured-default', sandbox: 'workspace-write' },
    grok: { enabled: true, model: process.env.SUPER_AGENT_GROK_MODEL ?? '', key_env: 'XAI_API_KEY', base_url: 'https://api.x.ai/v1' }, assistant: true };
  await writeConfig(config, path); return config;
}
export async function grokKey(config: NodeConfig): Promise<string | undefined> {
  if (config.grok.keychain_service) {
    try { const result = await promisify(execFile)('/usr/bin/security', ['find-generic-password', '-w', '-s', config.grok.keychain_service], { timeout: 10_000 }); return result.stdout.trim() || undefined; }
    catch { throw new Error('grok_keychain_unavailable'); }
  }
  if (config.grok.key_file) return (await readFile(config.grok.key_file, 'utf8')).trim();
  return process.env[config.grok.key_env] || undefined;
}
