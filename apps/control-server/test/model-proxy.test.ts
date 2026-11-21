import test from 'node:test';
import assert from 'node:assert/strict';
import { ApiError } from '../src/store.js';
import { assignModelProxy, heartbeatPayload, nodeDeviceView } from '../src/service.js';

const device = { id: 'device-1', name: 'Office Mac', model_proxy_url: 'http://old.invalid:1/' };

test('a loopback model proxy is stored canonically and a blank value clears it', () => {
  assert.equal(assignModelProxy(device, '127.0.0.1:7890').model_proxy_url, 'http://127.0.0.1:7890/');
  assert.equal(assignModelProxy(device, 'http://127.0.0.1:7890').model_proxy_url, 'http://127.0.0.1:7890/');
  assert.equal(assignModelProxy(device, null).model_proxy_url, null);
  assert.equal(assignModelProxy(device, '  ').model_proxy_url, null);
  assert.equal(assignModelProxy(device, undefined).model_proxy_url, 'http://old.invalid:1/');
});

test('credentials, SOCKS, and a bare address are rejected without echoing secrets', () => {
  for (const value of ['127.0.0.1', 'socks5://127.0.0.1:1080', 'http://test-user:test-password@127.0.0.1:7890', 'http://127.0.0.1:7890/path']) {
    assert.throws(() => assignModelProxy(device, value), error => {
      assert.ok(error instanceof ApiError);
      assert.equal(error.status, 422);
      assert.equal(error.code, 'invalid_model_proxy');
      assert.doesNotMatch(error.message, /test-user|test-password/);
      return true;
    });
  }
});

test('heartbeat returns this device proxy and the node device list omits it', () => {
  assert.deepEqual(heartbeatPayload(device, '2026-11-21T00:00:00.000Z'), { server_time: '2026-11-21T00:00:00.000Z', heartbeat_interval_ms: 10000, model_proxy_url: 'http://old.invalid:1/' });
  assert.equal(heartbeatPayload({ id: 'device-1' }, '2026-11-21T00:00:00.000Z').model_proxy_url, null);
  const listed = nodeDeviceView({ ...device, status: 'online' });
  assert.equal(listed.status, 'online');
  assert.equal('model_proxy_url' in listed, false);
});
