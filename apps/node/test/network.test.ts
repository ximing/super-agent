import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { acceptCloudModelProxy, configureNetwork, grokProxyFetch, macosProxySettings, proxyEnvOverlay } from '../src/network.js';

const system = `<dictionary> {
  HTTPEnable : 1
  HTTPProxy : 127.0.0.1
  HTTPPort : 7890
  HTTPSEnable : 1
  HTTPSProxy : 127.0.0.1
  HTTPSPort : 7890
}`;

test('device proxy wins and does not change the process environment', async () => {
  const env = { PATH: '/usr/bin', HTTPS_PROXY: 'http://shell.invalid:9', NO_PROXY: '.company.invalid' } as NodeJS.ProcessEnv;
  const original = { ...env };
  const setup = await configureNetwork({ model_proxy_url: '127.0.0.1:7890', proxy_url: 'http://config.invalid:8123' }, { env, platform: 'linux', readSystemProxy: async () => { throw new Error('Must not inspect system when the device sets a proxy'); } });
  assert.equal(setup.source, 'device');
  assert.equal(setup.proxied, true);
  assert.equal(setup.url, 'http://127.0.0.1:7890/');
  assert.deepEqual(env, original);
  const child = await promisify(execFile)(process.execPath, ['-e', `process.stdout.write(JSON.stringify({proxy:process.env.HTTPS_PROXY,bypass:process.env.NO_PROXY.split(',').includes('127.0.0.1'),company:process.env.NO_PROXY.includes('.company.invalid')}))`], { env: { ...env, ...proxyEnvOverlay(setup.url, env) } });
  const summary = JSON.parse(child.stdout) as { proxy: string; bypass: boolean; company: boolean };
  assert.equal(summary.proxy, 'http://127.0.0.1:7890/');
  assert.equal(summary.bypass, true);
  assert.equal(summary.company, true);
  assert.deepEqual(env, original);
});

test('empty device setting falls back to env, then node.json, then macOS', async () => {
  let systemReads = 0;
  const options = { platform: 'darwin' as const, readSystemProxy: async () => { systemReads++; return system; } };
  const fromEnv = await configureNetwork({ model_proxy_url: null, proxy_url: 'http://config.invalid:8123' }, { ...options, env: { HTTPS_PROXY: 'http://shell.invalid:9/' } });
  assert.equal(fromEnv.source, 'environment');
  assert.equal(fromEnv.url, 'http://shell.invalid:9/');
  assert.equal(systemReads, 0);
  const fromConfig = await configureNetwork({ proxy_url: 'http://config.invalid:8123' }, { ...options, env: {} });
  assert.equal(fromConfig.source, 'config');
  assert.equal(systemReads, 0);
  const fromSystem = await configureNetwork({}, { ...options, env: {} });
  assert.equal(fromSystem.source, 'macos-system');
  assert.equal(fromSystem.url, 'http://127.0.0.1:7890/');
  assert.equal(systemReads, 1);
});

test('proxy rejection stays closed and does not echo credentials', async () => {
  await assert.rejects(configureNetwork({ model_proxy_url: 'socks5://test-user:test-password@proxy.invalid:1080' }, { env: {}, platform: 'linux' }), error => {
    assert.match(String(error), /HTTP\(S\)/);
    assert.doesNotMatch(String(error), /test-user|test-password/);
    return true;
  });
  await assert.rejects(configureNetwork({ proxy_url: 'http://test-user:test-password@proxy.invalid:8080' }, { env: {}, platform: 'linux' }), error => {
    assert.doesNotMatch(String(error), /test-user|test-password/);
    return true;
  });
  assert.throws(() => macosProxySettings('ProxyAutoConfigEnable : 1'), /PAC\/SOCKS/);
  assert.equal(acceptCloudModelProxy('http://127.0.0.1:7890/', null).changed, true);
  assert.equal(acceptCloudModelProxy('http://127.0.0.1:7890/', null).value, undefined);
  assert.equal(acceptCloudModelProxy('http://127.0.0.1:7890/', '127.0.0.1:7890').changed, false);
});

test('grok fetch proxy errors do not include the proxy address', async () => {
  const fetcher = grokProxyFetch('http://127.0.0.1:1');
  await assert.rejects(fetcher('https://example.invalid/v1/responses', { method: 'POST', signal: AbortSignal.timeout(1000) }), error => {
    assert.equal((error as Error).message, 'grok_proxy_unreachable');
    assert.doesNotMatch(String(error), /127\.0\.0\.1/);
    return true;
  });
});
