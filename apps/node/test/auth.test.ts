import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { verify } from 'node:crypto';
import { initConfig } from '../src/config.js';
import { NodeApi } from '../src/api.js';

test('device authentication signs complete challenge and never sends its private key', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'super-agent-auth-'));
  const configPath = join(dir, 'node.json');
  const config = await initConfig('https://control.example', 'Test Mac', configPath, true);
  config.device_id = 'test-device';
  const challenge = 'https://control.example|test-device|nonce-1|device-token|1.0';
  const bodies: unknown[] = [];
  const api = new NodeApi(config, (async (url: string | URL | Request, init: RequestInit) => {
    const body = init.body ? JSON.parse(String(init.body)) as Record<string, string> : {};
    bodies.push(body);
    if (String(url).endsWith('/devices/auth/challenge')) return Response.json({ nonce: 'nonce-1', challenge, expires_at: new Date(Date.now() + 60_000).toISOString() });
    if (String(url).endsWith('/devices/auth/token')) {
      assert.equal(body.device_id, 'test-device'); assert.equal(body.nonce, 'nonce-1');
      assert.ok(verify(null, Buffer.from(challenge), config.public_key, Buffer.from(body.signature!, 'base64')));
      return Response.json({ access_token: 'test-device-token', expires_in: 300 });
    }
    assert.equal((init.headers as Record<string, string>).authorization, 'Bearer test-device-token');
    return Response.json({ ok: true });
  }) as typeof fetch);
  try {
    assert.deepEqual(await api.request('/node/heartbeat', {}), { ok: true });
    assert.doesNotMatch(JSON.stringify(bodies), /PRIVATE KEY|private_key_path/);
    assert.equal((await stat(configPath)).mode & 0o777, 0o600);
    assert.equal((await stat(config.private_key_path)).mode & 0o777, 0o600);
    await assert.rejects(initConfig('https://other.example', 'Other', configPath), /already exists/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
