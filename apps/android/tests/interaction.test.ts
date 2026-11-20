import {test} from 'node:test';
import assert from 'node:assert/strict';
import {APIClient, type SessionStore} from '../src/api';
import {eventCursorKey} from '../src/event-stream';
import {
  actionDraftLabel, commitProjection, controlResultLabel, countLabel, createPendingMessage, decideChat, dispatchSubmission,
  enqueueProjection, explicitCommand, identityForEdit, localRemoval, mergeActionReceipt, mergeByVersion, mergeCollection, processingLabel,
  reconnectVisible, runStageLabel, shareInflight, shouldResetCursor, shouldUseLegacyLoad, submitPersisted,
  type PendingMessage, type SubmissionTransport,
} from '../src/interaction';
import type {Session} from '../src/types';

const session: Session = {access_token: 'test-access', refresh_token: 'test-refresh', expires_in: 600, user: {id: 'u', email: 'test@example.com', name: 'Test', tenant_id: 't'}};
function store(): SessionStore {
  const data = new Map<string, Session>();
  return {async read(key) { return data.get(key) ?? null; }, async write(key, value) { data.set(key, value); }, async remove(key) { data.delete(key); }};
}

function pending(text = '看一下价格'): PendingMessage {
  return createPendingMessage({
    client_message_id: 'client-1', idempotency_key: 'key-1', text, task_id: 'task-1',
    execution_preference: {engine: 'codex', device_id: 'device-1', selection_mode: 'pinned'},
    memory_scope: {project: null, sites: [], global_preference: false, statuses: ['verified'], max_version: null},
    kind: 'message', created_at: '2026-11-20T00:00:00.000Z',
  });
}

test('persisted identity is written before send and reused after a lost response', async () => {
  const record = pending();
  const order: string[] = [];
  const transport: SubmissionTransport = {
    async lookup() { throw new Error('lookup is not used for the first send'); },
    async post(item) {
      order.push(`post:${item.client_message_id}:${item.idempotency_key}`);
      throw Object.assign(new Error('The operation was aborted'), {name: 'AbortError'});
    },
  };
  const first = await submitPersisted(record, async item => { order.push(`persist:${item.idempotency_key}`); }, transport);
  assert.deepEqual(order, ['persist:key-1', 'post:client-1:key-1']);
  assert.equal(first.decision.label, '发送结果待确认');
  assert.equal(first.record.client_message_id, 'client-1');
  assert.equal(first.record.idempotency_key, 'key-1');
  const calls: string[] = [];
  const recovered = await dispatchSubmission(first.record, {
    async lookup(id) { calls.push(`lookup:${id}`); return {status: 404}; },
    async post(item) { calls.push(`post:${item.client_message_id}:${item.idempotency_key}`); return {status: 200, body: {id: 'server-1', client_message_id: item.client_message_id}}; },
  }, 'recover');
  assert.deepEqual(calls, ['lookup:client-1', 'post:client-1:key-1']);
  assert.equal(recovered.record.client_message_id, 'client-1');
  assert.equal(recovered.record.idempotency_key, 'key-1');
  assert.equal(recovered.decision.type, 'merge');
});

test('a 404 lookup does not allocate a new client id', async () => {
  const record = pending();
  const seen: {item: PendingMessage | null} = {item: null};
  const result = await dispatchSubmission(record, {
    async lookup() { return {status: 404}; },
    async post(item) { seen.item = item; return {status: 200, body: {id: 'server-1'}}; },
  }, 'recover');
  assert.equal(seen.item?.client_message_id, record.client_message_id);
  assert.equal(seen.item?.idempotency_key, record.idempotency_key);
  assert.equal(result.record.client_message_id, 'client-1');
});

test('changing the body allocates a new identity and an unknown result cannot be withdrawn', () => {
  const record = pending('原文');
  const edited = identityForEdit(record, '修改后的正文', {client_message_id: 'client-2', idempotency_key: 'key-2'});
  assert.equal(edited.client_message_id, 'client-2');
  assert.equal(edited.idempotency_key, 'key-2');
  assert.equal(edited.replacePrevious, true);
  const same = identityForEdit(record, '原文', {client_message_id: 'client-2', idempotency_key: 'key-2'});
  assert.equal(same.client_message_id, 'client-1');
  assert.equal(same.idempotency_key, 'key-1');
  const unknown = identityForEdit({...record, phase: 'result_unknown'}, '另一条正文', {client_message_id: 'client-3', idempotency_key: 'key-3'});
  assert.equal(unknown.replacePrevious, false);
  assert.equal(unknown.client_message_id, 'client-3');
  assert.equal(localRemoval('unsent').allowed, true);
  assert.equal(localRemoval('result_unknown').allowed, false);
  assert.notEqual(localRemoval('result_unknown').title, '撤回');
});

test('explicit idempotency key is not replaced by the API client', async () => {
  let seen = '';
  const transport = (async (_url: unknown, init: RequestInit) => {
    seen = new Headers(init?.headers).get('Idempotency-Key') ?? '';
    return new Response(JSON.stringify({ok: true}), {status: 200});
  }) as typeof fetch;
  const client = new APIClient(store(), () => 'random-key', transport);
  await client.configure('https://agent.example');
  await client.setSession(session);
  await client.request('/messages', {method: 'POST', body: {text: 'hello'}, idempotencyKey: 'persisted-key'});
  assert.equal(seen, 'persisted-key');
});

test('a failed projection does not advance the cursor, including across numeric seq gaps', () => {
  const initial = {persisted: '8', dirty: []};
  const queued = enqueueProjection(initial, [
    {streamSeq: '10', eventId: 'b', type: 'task.changed', taskId: 't'},
    {streamSeq: '9', eventId: 'a', type: 'task.changed', taskId: 't'},
  ]);
  assert.equal(queued.persisted, '8');
  const failed = commitProjection(queued, [{streamSeq: '9', ok: false}, {streamSeq: '10', ok: true}]);
  assert.equal(failed.persisted, '8');
  assert.deepEqual(failed.dirty.map(item => item.streamSeq), ['9', '10']);
  const prefix = commitProjection(queued, [{streamSeq: '9', ok: true}, {streamSeq: '10', ok: false}]);
  assert.equal(prefix.persisted, '9');
  assert.deepEqual(prefix.dirty.map(item => item.streamSeq), ['10']);
});

test('an older version does not replace a newer entity', () => {
  const current: {id: string; version?: number | null; title: string}[] = [{id: 'task-1', version: 5, title: '新'}];
  assert.equal(mergeByVersion(current, {id: 'task-1', version: 4, title: '旧'})[0]?.title, '新');
  assert.equal(mergeByVersion(current, {id: 'task-1', version: 6, title: '更新'})[0]?.title, '更新');
  const replaced = mergeCollection(current, [{id: 'task-1', version: 3, title: '慢'}], 'replace');
  assert.equal(replaced[0]?.title, '新');
  assert.equal(mergeByVersion(current, {id: 'task-1', title: '缺版本'})[0]?.title, '新');
  const newer = mergeActionReceipt({messages: [], actions: [{idempotency_key: 'k', task_id: 't', action: 'pause', task_version: 2, target: null, action_id: 'a', receipt_status: 'completed', receipt_version: 4, phase: 'settled'}], answers: []}, {action_id: 'a', task_id: 't', action: 'pause', status: 'accepted', version: 3});
  assert.equal(newer.actions[0]?.receipt_status, 'completed');
  assert.equal(actionDraftLabel(newer.actions[0]!), '已暂停');
});

test('accepted is not paused, and a missing receipt cannot say the task stopped', () => {
  assert.equal(controlResultLabel('pause', {status: 'accepted'}), '请求已收到');
  assert.notEqual(controlResultLabel('pause', {status: 'accepted'}), '已暂停');
  assert.equal(controlResultLabel('pause', {status: 'accepted', receipt: {status: 'accepted'}}), '请求已收到');
  assert.equal(controlResultLabel('pause', {status: 'accepted', receipt: {status: 'delivered'}}), '正在暂停');
  assert.equal(controlResultLabel('resume', {status: 'accepted', receipt: {status: 'applying'}}), '等待电脑处理');
  assert.equal(controlResultLabel('pause', {status: 'accepted', receipt: {status: 'completed'}}), '已暂停');
  assert.equal(controlResultLabel('cancel', {status: 'accepted', receipt: {status: 'completed'}}), '已取消');
  assert.equal(controlResultLabel('pause', {status: 'accepted', receipt: {status: 'result_unknown'}}), '结果待核对');
  assert.equal(actionDraftLabel({idempotency_key: 'k', task_id: 't', action: 'pause', task_version: 1, target: null, action_id: 'a', receipt_status: null, phase: 'settled'}), '请求已收到');
});

test('pause with several tasks asks for a choice and a conditional sentence is not intercepted', () => {
  const tasks = [
    {id: '11111111-1111-4111-8111-111111111111', title: '甲', status: 'running'},
    {id: '22222222-2222-4222-8222-222222222222', title: '乙', status: 'running'},
  ];
  const choice = decideChat('暂停', tasks);
  assert.equal(choice.type, 'choose');
  if (choice.type === 'choose') assert.equal(choice.choices.length, 2);
  assert.equal(decideChat('暂停，等我确认后再继续', tasks).type, 'send');
  assert.equal(decideChat('如果价格降了就暂停', tasks).type, 'send');
  const exact = decideChat('暂停 11111111', tasks);
  assert.equal(exact.type, 'act');
  if (exact.type === 'act') assert.equal(exact.task.title, '甲');
  const status = decideChat('进度呢', tasks);
  assert.equal(status.type, 'choose');
  assert.notEqual(status.type, 'send');
  const selected = decideChat('选择 11111111', tasks);
  assert.equal(selected.type, 'status');
  if (selected.type === 'status') assert.equal(selected.tasks[0]?.title, '甲');
  assert.equal(explicitCommand('pause', tasks[0]!.id), '暂停 11111111');
  assert.equal(explicitCommand('status', tasks[0]!.id), '选择 11111111');
});

test('processing copy keeps offline distinct from the previous message, and dispatch is not execution', () => {
  const offline = processingLabel('queued', 'waiting_device_offline');
  const previous = processingLabel('queued', 'waiting_previous_message');
  assert.equal(offline, '主助理电脑离线，消息已保存');
  assert.equal(previous, '主助理正在处理上一条消息');
  assert.notEqual(offline, previous);
  assert.equal(processingLabel(null, null, 'unknown'), '历史处理状态未知');
  assert.equal(runStageLabel('run.started', 'dispatched'), '已派发，等待电脑接受');
  assert.notEqual(runStageLabel('run.started', 'dispatched'), '已执行');
  assert.equal(countLabel(1, 4), '1/4');
  assert.equal(countLabel(undefined, 4), null);
});

test('cursor keys include the server and user, and 410 does not reset the cursor', () => {
  assert.notEqual(eventCursorKey('https://a.example', 'user-1'), eventCursorKey('https://b.example', 'user-1'));
  assert.notEqual(eventCursorKey('https://a.example', 'user-1'), eventCursorKey('https://a.example', 'user-2'));
  assert.match(eventCursorKey('https://agent.example/ignored', 'user/1'), /^[A-Za-z0-9._-]+$/);
  assert.equal(shouldResetCursor(410), false);
  assert.equal(shouldResetCursor(422), true);
  assert.equal(shouldUseLegacyLoad(404), true);
  assert.equal(shouldUseLegacyLoad(410), false);
  assert.equal(reconnectVisible(null, 10_000), false);
  assert.equal(reconnectVisible(10_000, 14_000), false);
  assert.equal(reconnectVisible(10_000, 15_000), true);
});

test('repeated control clicks share one in-flight request', async () => {
  const flights = new Map<string, Promise<unknown>>();
  let calls = 0;
  const run = () => shareInflight(flights, 'control:task-1', async () => {
    calls += 1;
    await new Promise(resolve => setTimeout(resolve, 20));
    return 'ok';
  });
  const [first, second] = await Promise.all([run(), run()]);
  assert.equal(first, 'ok');
  assert.equal(second, 'ok');
  assert.equal(calls, 1);
});
