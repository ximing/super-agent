import test from 'node:test';
import assert from 'node:assert/strict';
import { activityRootId, canTransitionRun, canStartReplacement, moneyToTicks, normalizeModelProxyUrl, observationActivityId, ticksToMoney, summarizeCosts } from '../dist/index.js';

test('late progress cannot revive a completed or paused attempt', () => {
  assert.equal(canTransitionRun('succeeded', 'running'), false);
  assert.equal(canTransitionRun('paused', 'running'), false);
  assert.equal(canTransitionRun('succeeded', 'succeeded'), true);
  assert.equal(canTransitionRun('lost', 'result_unknown'), true);
});

test('device loss or an unknown submit result prevents immediate replacement', () => {
  assert.equal(canStartReplacement('lost', false, false), false);
  assert.equal(canStartReplacement('result_unknown', true, false), false);
  assert.equal(canStartReplacement('paused', false, true), false);
  assert.equal(canStartReplacement('paused', true, true), true);
});

test('supplier ticks and decimal sums do not suffer floating-point rounding', () => {
  assert.equal(ticksToMoney(moneyToTicks('0.1') + moneyToTicks('0.2')), '0.3');
  assert.equal(moneyToTicks('0.0000000001'), 1n);
  assert.equal(ticksToMoney(38_000_000n), '0.0038');
  assert.equal(ticksToMoney(0n), '0');
  for (const value of ['-1', '1e3', 'NaN', '0.00000000001', '01.2']) assert.throws(() => moneyToTicks(value));
});

test('attempt ids keep a stable root and observation commands do not use the page fingerprint', () => {
  assert.equal(activityRootId('assistant:msg'), 'assistant:msg');
  assert.equal(activityRootId('assistant:msg#2'), 'assistant:msg');
  assert.equal(activityRootId('proactive:observation:cmd#10'), 'proactive:observation:cmd');
  assert.equal(activityRootId('event:abc#nope'), 'event:abc#nope');
  assert.equal(observationActivityId('cmd-1'), 'proactive:observation:cmd-1');
});

test('model proxy keeps an explicit port and drops credentials, paths, and SOCKS', () => {
  assert.equal(normalizeModelProxyUrl('127.0.0.1:7890'), 'http://127.0.0.1:7890/');
  assert.equal(normalizeModelProxyUrl('http://127.0.0.1:7890'), 'http://127.0.0.1:7890/');
  assert.equal(normalizeModelProxyUrl('https://proxy.example:443'), 'https://proxy.example:443/');
  assert.equal(normalizeModelProxyUrl('[::1]:7890'), 'http://[::1]:7890/');
  for (const value of ['127.0.0.1', 'socks5://127.0.0.1:1080', 'http://127.0.0.1:7890/path', 'http://127.0.0.1:7890?x=1', 'http://test-user:test-password@127.0.0.1:7890']) {
    assert.throws(() => normalizeModelProxyUrl(value), error => {
      assert.match(String(error), /HTTP\(S\)/);
      assert.doesNotMatch(String(error), /test-user|test-password|socks5:\/\/|7890\/path/);
      return true;
    });
  }
});

test('unknown subscription cost stays unknown, known zero stays known', () => {
  const summary = summarizeCosts([
    { source: 'unavailable', currency: null, amount: null },
    { source: 'supplier_reported', currency: 'USD', amount: '0' },
    { source: 'estimated', currency: 'USD', amount: '0.2' },
    { source: 'supplier_reported', currency: 'CNY', amount: '1' },
  ]);
  assert.equal(summary.unknown_count, 1);
  assert.equal(summary.coverage, 0.75);
  assert.equal(summary.totals.length, 3);
  assert.deepEqual(summary.totals.find(v => v.source === 'supplier_reported' && v.currency === 'USD'), { currency: 'USD', source: 'supplier_reported', amount: '0' });
});
