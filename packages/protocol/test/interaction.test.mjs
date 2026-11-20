import test from 'node:test';
import assert from 'node:assert/strict';
import { acceptEntityVersion, actionLabel, bindFastIntent, canAdvanceAction, canAdvanceProcessing, compareStreamSeq, parseFastIntent, processingLabel } from '../dist/index.js';

test('fast path accepts only a whole explicit command', () => {
  assert.deepEqual(parseFastIntent('进度呢'), { kind: 'status' });
  assert.deepEqual(parseFastIntent('暂停'), { kind: 'pause', task_ref: null });
  assert.deepEqual(parseFastIntent('取消 1234abcd'), { kind: 'cancel', task_ref: '1234abcd' });
  assert.deepEqual(parseFastIntent('选择 abcdef12-3456-7890-abcd-ef1234567890'), { kind: 'select', task_ref: 'abcdef12-3456-7890-abcd-ef1234567890' });
  assert.deepEqual(parseFastIntent('暂停那个，然后改一下价格'), { kind: 'none' });
  assert.deepEqual(parseFastIntent('请帮我取消所有任务'), { kind: 'none' });
});

test('control binding never guesses among several tasks', () => {
  const tasks = [
    { id: '11111111-1111-4111-8111-111111111111', title: '甲', status: 'running' },
    { id: '22222222-2222-4222-8222-222222222222', title: '乙', status: 'running' },
  ];
  assert.equal(bindFastIntent({ kind: 'pause', task_ref: null }, tasks).type, 'choose');
  const one = bindFastIntent({ kind: 'pause', task_ref: '11111111' }, tasks);
  assert.equal(one.type, 'act');
  if (one.type === 'act') assert.equal(one.task.title, '甲');
  assert.equal(bindFastIntent({ kind: 'status' }, tasks).type, 'status');
  assert.equal(bindFastIntent({ kind: 'pause', task_ref: null }, [{ id: 'abc', title: '仅此', status: 'running' }]).type, 'act');
  const selected = bindFastIntent({ kind: 'select', task_ref: '11111111' }, tasks);
  assert.equal(selected.type, 'status');
  if (selected.type === 'status') assert.equal(selected.tasks[0].title, '甲');
  const shared = [
    { id: 'abcdef12-1111-4111-8111-111111111111', title: '甲', status: 'running' },
    { id: 'abcdef12-2222-4222-8222-222222222222', title: '乙', status: 'running' },
  ];
  assert.equal(bindFastIntent({ kind: 'select', task_ref: 'abcdef12' }, shared).type, 'choose');
});

test('processing and action receipts do not move backward', () => {
  assert.equal(canAdvanceProcessing('handled', 'processing'), false);
  assert.equal(canAdvanceProcessing('processing', 'handled'), true);
  assert.equal(canAdvanceProcessing(null, 'received'), true);
  assert.equal(canAdvanceAction('completed', 'applying'), false);
  assert.equal(canAdvanceAction('accepted', 'completed'), true);
  assert.equal(canAdvanceAction('applying', 'result_unknown'), true);
  assert.equal(canAdvanceAction('result_unknown', 'accepted'), false);
  assert.equal(canAdvanceAction('result_unknown', 'completed'), true);
});

test('stream cursors are numeric and stale versions do not replace newer entities', () => {
  assert.equal(compareStreamSeq('10', '9'), 1);
  assert.equal(compareStreamSeq('9', '10'), -1);
  assert.equal(compareStreamSeq('0002', '2'), 0);
  assert.equal(acceptEntityVersion(3, 4), false);
  assert.equal(acceptEntityVersion(4, 4), true);
  assert.equal(acceptEntityVersion(undefined, 2), false);
  assert.equal(acceptEntityVersion(1, undefined), true);
});

test('labels do not claim a pause completed when only the request was accepted', () => {
  assert.equal(actionLabel('pause', 'accepted'), '请求已收到');
  assert.equal(actionLabel('pause', 'completed'), '已暂停');
  assert.equal(actionLabel('pause', 'result_unknown'), '结果待核对');
  assert.equal(processingLabel(null, null, 'unknown'), '历史处理状态未知');
  assert.equal(processingLabel('received', 'waiting_device_offline'), '主助理电脑离线，消息已保存');
  assert.match(processingLabel('processing', 'model_in_progress'), /模型处理中/);
});
