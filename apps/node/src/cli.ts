#!/usr/bin/env node
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { hostname } from 'node:os';
import { join, resolve } from 'node:path';
import type { PairingStart, PairingResult } from '@super-agent/protocol';
import { NodeAgent } from './agent.js';
import { NodeApi } from './api.js';
import { defaultConfigPath, initConfig, loadConfig, writeConfig } from './config.js';
import { sleep } from '@super-agent/tool-broker/runtime';
import { configureNetwork } from './network.js';
import { ensureCsiStarted, launchAgentPlist } from './startup.js';

const args = process.argv.slice(2);
const option = (key: string): string | undefined => { const i = args.indexOf(key); return i >= 0 ? args[i + 1] : undefined; };
const configPath = resolve(option('--config') ?? defaultConfigPath());
async function main(): Promise<void> {
  const command = args[0] ?? 'help';
  if (command === 'init') {
    const server = option('--server'); if (!server) throw new Error('init requires --server https://your-control-server');
    await initConfig(server, option('--name') ?? hostname(), configPath, args.includes('--fake-runtime'));
    process.stdout.write(`Node configuration created: ${configPath}\nModel credentials stay local. Set grok.model and local key source if needed, then run pair.\n`); return;
  }
  if (command === 'pair') {
    const config = await loadConfig(configPath); if (config.device_id) throw new Error('This node is already paired');
    await configureNetwork(config);
    const api = new NodeApi(config), pendingPath = join(config.data_dir, 'pairing-pending.json');
    let pairing: PairingStart | undefined;
    try { const saved = JSON.parse(await readFile(pendingPath, 'utf8')) as PairingStart; if (Date.parse(saved.expires_at) > Date.now()) pairing = saved; } catch { /* Start a fresh one-time pairing. */ }
    pairing ??= await api.raw<PairingStart>('/device-pairings', { name: config.name, public_key: config.public_key });
    await writeFile(pendingPath, JSON.stringify(pairing), { mode: 0o600 });
    process.stdout.write(`Pairing code: ${pairing.code}\nClaim this code in your Mac/Android control client. Expires: ${pairing.expires_at}\n`);
    if (args.includes('--no-wait')) return;
    const until = Math.min(Date.parse(pairing.expires_at), Date.now() + Number(option('--wait-seconds') ?? 300) * 1000);
    while (Date.now() < until) {
      const result = await api.raw<PairingResult>('/device-pairings/poll', { pairing_id: pairing.pairing_id, polling_secret: pairing.polling_secret });
      if (result.status === 'claimed' && result.device_id) { config.device_id = result.device_id; config.tenant_id = result.tenant_id; await writeConfig(config, configPath); process.stdout.write(`Paired device ${config.device_id}. Run start to connect.\n`); return; }
      await sleep(2000);
    }
    throw new Error('Pairing is not claimed yet; run pair again to resume');
  }
  if (command === 'start') {
    const config = await loadConfig(configPath);
    await ensureCsiStarted(config.fake_runtime || config.browser?.enabled === false, { log: message => process.stderr.write(`${message}\n`) });
    const agent = new NodeAgent(config);
    let stopping = false;
    const stop = () => { if (!stopping) { stopping = true; void agent.stop(); } };
    process.on('SIGINT', stop); process.on('SIGTERM', stop);
    try { await agent.start(); } finally { await agent.stop(); agent.close(); }
    return;
  }
  if (command === 'probe') {
    const config = await loadConfig(configPath), network = await configureNetwork(config), agent = new NodeAgent(config);
    try { process.stdout.write(`${JSON.stringify({ ...await agent.capabilities(), network: { proxy_source: network.source, proxied: network.proxied } }, null, 2)}\n`); } finally { agent.close(); network.restore(); }
    return;
  }
  if (command === 'launchagent') {
    const dir = resolve(option('--output') ?? join((await loadConfig(configPath)).data_dir, 'launchd')); await mkdir(dir, { recursive: true, mode: 0o700 });
    const plist = launchAgentPlist({ execPath: process.execPath, scriptUrl: new URL('./cli.js', import.meta.url), configPath, outputDir: dir, currentPath: process.env.PATH });
    const path = join(dir, 'com.superagent.node.plist'); await writeFile(path, plist, { mode: 0o600 });
    process.stdout.write(`LaunchAgent manifest written: ${path}\nReview/install as a user LaunchAgent. No system/root service or provider credentials are embedded.\n`); return;
  }
  process.stdout.write('super-agent-node init --server https://server --name "Office Mac" [--config path] [--fake-runtime]\nsuper-agent-node pair [--config path] [--no-wait]\nsuper-agent-node probe [--config path]\nsuper-agent-node start [--config path]\nsuper-agent-node launchagent [--config path] [--output dir]\n');
}
main().catch(error => { process.stderr.write(`${(error as Error).message}\n`); process.exitCode = 1; });
