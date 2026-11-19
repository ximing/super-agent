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
  assert.equal((offline as { value: { observed_at: string; cache_read_at: string } }).value.observed_at, '2026-11-19T00:00:00.000Z');
  assert.equal((offline as { value: { cache_read_at: string } }).value.cache_read_at, '2026-11-19T00:00:01.000Z');
  cache.markOffline(false);
  cache.invalidate();
  assert.equal(cache.lookup('read', 'tenant:scope:memory-1', Date.parse('2026-11-19T00:00:01.000Z')).hit, false);
});

test('stale search hits keep the original observation time, including an empty list', () => {
  const cache = new MemoryCache({ maxEntries: 4, maxBytes: 10_000, ttlMs: 1_000 });
  const observed = '2026-11-19T00:00:00.000Z';
  cache.store('search', 'q', { items: [{ id: '1', content: 'secret-text', title: '入口' }, { id: '2', content: 'more' }] }, observed);
  cache.store('search', 'empty', { items: [] }, observed);
  const readAt = Date.parse('2026-11-19T00:10:00.000Z');
  const stale = cache.lookup('search', 'q', readAt);
  assert.equal(stale.hit && stale.stale, true);
  if (!stale.hit) return;
  const value = stale.value as { observed_at: string; cache_read_at: string; fresh: boolean; stale: boolean; stale_reason: string; items: { observed_at: string; content: null; stale: boolean; fresh: boolean }[] };
  assert.equal(value.observed_at, observed);
  assert.equal(value.cache_read_at, '2026-11-19T00:10:00.000Z');
  assert.notEqual(value.cache_read_at, value.observed_at);
  assert.equal(value.fresh, false);
  assert.equal(value.stale, true);
  assert.equal(value.stale_reason, 'expired_cache');
  assert.equal(value.items[0].observed_at, observed);
  assert.equal(value.items[1].observed_at, observed);
  assert.equal(value.items[0].content, null);
  assert.equal(value.items[0].stale, true);
  assert.equal(value.items[0].fresh, false);
  assert.equal(JSON.stringify(value).includes('secret-text'), false);
  const empty = cache.lookup('search', 'empty', readAt);
  assert.equal(empty.hit && empty.stale, true);
  if (!empty.hit) return;
  const wrapper = empty.value as { items: unknown[]; fresh: boolean; stale: boolean; stale_reason: string; observed_at: string; cache_read_at: string };
  assert.deepEqual(wrapper.items, []);
  assert.equal(wrapper.fresh, false);
  assert.equal(wrapper.stale, true);
  assert.equal(wrapper.stale_reason, 'expired_cache');
  assert.equal(wrapper.observed_at, observed);
  assert.equal(wrapper.cache_read_at, '2026-11-19T00:10:00.000Z');
});

test('the cache stays bounded', () => {
  const cache = new MemoryCache({ maxEntries: 1, maxBytes: 10_000, ttlMs: 10_000 });
  cache.store('search', 'one', { items: [{ id: '1', content: 'a' }] });
  cache.store('search', 'two', { items: [{ id: '2', content: 'b' }] });
  assert.equal(cache.lookup('search', 'one').hit, false);
  assert.equal(cache.lookup('search', 'two').hit, true);
});
