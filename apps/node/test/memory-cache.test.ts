import test from 'node:test';
import assert from 'node:assert/strict';
import { MemoryCache } from '../src/memory-cache.js';

test('fresh cache hits stay fresh and offline or invalidated hits cannot pose as current facts', () => {
  const cache = new MemoryCache({ maxEntries: 2, maxBytes: 10_000, ttlMs: 1_000 });
  cache.store('read', 'tenant:scope:memory-1', { id: 'memory-1', content: '当前流程', status: 'verified' }, '2026-11-19T00:00:00.000Z');
  const fresh = cache.lookup('read', 'tenant:scope:memory-1', Date.parse('2026-11-19T00:00:01.000Z'));
  assert.equal(fresh.hit && fresh.stale, false);
  assert.equal((fresh as { value: { content: string } }).value.content, '当前流程');
  cache.markOffline(true);
  const offline = cache.lookup('read', 'tenant:scope:memory-1', Date.parse('2026-11-19T00:00:01.000Z'));
  assert.equal(offline.hit && offline.stale, true);
  assert.equal((offline as { value: { content: null; stale_reason: string } }).value.content, null);
  assert.equal((offline as { value: { stale_reason: string } }).value.stale_reason, 'offline');
  cache.markOffline(false);
  cache.invalidate({ id: 'memory-1' });
  const invalidated = cache.lookup('search', 'tenant:scope:query', Date.parse('2026-11-19T00:00:01.000Z'));
  assert.equal(invalidated.hit, false);
});

test('the cache stays bounded', () => {
  const cache = new MemoryCache({ maxEntries: 1, maxBytes: 10_000, ttlMs: 10_000 });
  cache.store('search', 'one', { items: [{ id: '1', content: 'a' }] });
  cache.store('search', 'two', { items: [{ id: '2', content: 'b' }] });
  assert.equal(cache.lookup('search', 'one').hit, false);
  assert.equal(cache.lookup('search', 'two').hit, true);
});
