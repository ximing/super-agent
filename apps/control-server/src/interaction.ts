import { randomUUID } from 'node:crypto';
import { ACTION_TERMINAL, PROCESSING_REASON_CODES, PROCESSING_TERMINAL, bindFastIntent, canAdvanceAction, canAdvanceProcessing, parseFastIntent, type ActionReceiptStatus, type FastTaskRef, type InteractionCapabilities, type MessageProcessingStatus, type TaskControlAction } from '@super-agent/protocol';
import { now, uuid } from './auth.js';
import { ApiError, type Doc, type Tx } from './store.js';

const RUN_ACTIVE = ['dispatched', 'starting', 'running', 'waiting_input', 'stopping'];
const REASON_CODES = new Set<string>(PROCESSING_REASON_CODES);

export function interactionFlags(): InteractionCapabilities {
  const enabled = (name: string) => process.env[name] !== '0' && process.env[name] !== 'false';
  return {
    protocol: '2026-11-20',
    message_processing: enabled('INTERACTION_MESSAGE_PROCESSING'),
    action_receipts: enabled('INTERACTION_ACTION_RECEIPTS'),
    workspace_snapshot: enabled('INTERACTION_SNAPSHOT'),
    chat_fast_path: enabled('INTERACTION_FAST_PATH'),
    task_progress: enabled('INTERACTION_TASK_PROGRESS'),
  };
}

function reasonCode(value: unknown): string | null {
  if (value == null || value === '') return null;
  if (typeof value !== 'string' || !REASON_CODES.has(value)) throw new ApiError(422, 'invalid_reason', '处理原因无效');
  return value;
}

async function processingFor(tx: Tx, sourceMessageId: string): Promise<Doc | null> {
  return (await tx.all('message_processing')).find(row => row.source_message_id === sourceMessageId) ?? null;
}

function processingView(row: Doc | null, sourceMessageId: string, historical?: 'handled' | 'unknown'): Doc {
  if (!row) {
    return {
      id: null, source_message_id: sourceMessageId, client_message_id: null, version: 0, status: historical === 'handled' ? 'handled' : null,
      phase: null, attempt_id: null, owner_device_id: null, owner_epoch: null, received_at: null, started_at: null, updated_at: null,
      completed_at: null, last_progress_at: null, reason_code: historical === 'handled' ? 'historical_handled' : null, plan_id: null,
      task_ids: [], reply_message_id: null, retry_mode: 'none', historical: historical ?? 'unknown',
    };
  }
  return {
    id: row.id, source_message_id: row.source_message_id, client_message_id: row.client_message_id ?? null, version: row.version,
    status: row.status ?? null, phase: row.phase ?? null, attempt_id: row.attempt_id ?? null, owner_device_id: row.owner_device_id ?? null,
    owner_epoch: row.owner_epoch ?? null, received_at: row.received_at ?? null, started_at: row.started_at ?? null, updated_at: row.updated_at,
    completed_at: row.completed_at ?? null, last_progress_at: row.last_progress_at ?? null, reason_code: row.reason_code ?? null,
    plan_id: row.plan_id ?? null, task_ids: row.task_ids ?? [], reply_message_id: row.reply_message_id ?? null, retry_mode: row.retry_mode ?? 'none',
    ...(row.historical ? { historical: row.historical } : {}),
  };
}

async function stampMessage(tx: Tx, message: Doc, processing: Doc): Promise<Doc> {
  return tx.put('messages', {
    ...message, processing_status: processing.status ?? null, processing_phase: processing.phase ?? null,
    reason_code: processing.reason_code ?? null, action_id: processing.action_id ?? message.action_id ?? null,
  }, message.id);
}

async function emitProcessing(tx: Tx, processing: Doc, taskId: string | null): Promise<void> {
  await tx.emit('message.processing.changed', {
    id: processing.id, source_message_id: processing.source_message_id, status: processing.status, phase: processing.phase ?? null,
    reason_code: processing.reason_code ?? null, version: processing.version, attempt_id: processing.attempt_id ?? null, action_id: processing.action_id ?? null,
  }, taskId);
}

export async function messageAlreadyHandled(tx: Tx, messageId: string): Promise<boolean> {
  if (await tx.get('inbox_receipts', messageId)) return true;
  return (await tx.all('messages')).some(row => row.role === 'assistant' && row.source_message_id === messageId);
}

export async function beginMessageProcessing(tx: Tx, message: Doc, assistantOffline: boolean): Promise<Doc> {
  if (!interactionFlags().message_processing) return message;
  const existing = await processingFor(tx, message.id);
  if (existing) return stampMessage(tx, message, existing);
  const previousBusy = (await tx.all('message_processing')).some(row => row.source_message_id !== message.id && row.status && !PROCESSING_TERMINAL.has(row.status) && row.status !== 'waiting_input');
  const status: MessageProcessingStatus = previousBusy ? 'queued' : 'received';
  const saved = await tx.put('message_processing', {
    source_message_id: message.id, client_message_id: message.client_message_id ?? null, status,
    phase: assistantOffline ? 'waiting_device' : null, attempt_id: null, owner_device_id: null, owner_epoch: null,
    received_at: now(), started_at: null, completed_at: null, last_progress_at: null,
    reason_code: assistantOffline ? 'waiting_device_offline' : previousBusy ? 'waiting_previous_message' : null,
    plan_id: null, task_ids: [], reply_message_id: null, retry_mode: 'transport_only', action_id: null,
  });
  await emitProcessing(tx, saved, message.task_id ?? null);
  return stampMessage(tx, message, saved);
}

export async function readMessageProcessing(tx: Tx, messageId: string): Promise<Doc> {
  const message = await tx.need('messages', uuid(messageId));
  const row = await processingFor(tx, message.id);
  if (row) return processingView(row, message.id);
  return processingView(null, message.id, await messageAlreadyHandled(tx, message.id) ? 'handled' : 'unknown');
}

export async function lookupClientMessage(tx: Tx, clientMessageId: string): Promise<Doc> {
  const id = uuid(clientMessageId, 'client_message_id');
  const message = (await tx.all('messages')).find(row => row.client_message_id === id);
  if (!message) throw new ApiError(404, 'not_found', '消息不存在');
  return { message, processing: await readMessageProcessing(tx, message.id) };
}

export async function claimMessage(tx: Tx, messageId: string, lease: Doc): Promise<Doc> {
  const message = await tx.need('messages', uuid(messageId), true);
  const existing = await processingFor(tx, message.id);
  if (existing && PROCESSING_TERMINAL.has(existing.status)) return { processing: processingView(existing, message.id), attempt_id: existing.attempt_id };
  if (!existing && await messageAlreadyHandled(tx, message.id)) {
    const historical = processingView(null, message.id, 'handled');
    return { processing: historical, attempt_id: null };
  }
  if (existing?.status === 'processing' && existing.owner_device_id === lease.device_id && String(existing.owner_epoch) === String(lease.epoch) && existing.attempt_id) {
    return { processing: processingView(existing, message.id), attempt_id: existing.attempt_id };
  }
  if (existing?.status === 'processing' && existing.owner_device_id && String(existing.owner_epoch) !== String(lease.epoch)) {
    const owner = await tx.get('assistant_leases', tx.tenant);
    if (owner && owner.device_id === existing.owner_device_id && String(owner.epoch) === String(existing.owner_epoch) && Date.parse(owner.expires_at) > Date.now()) {
      throw new ApiError(409, 'assistant_lease_held', '主助理正在处理上一条消息');
    }
  }
  const attemptId = randomUUID();
  const nextStatus: MessageProcessingStatus = 'processing';
  if (existing && !canAdvanceProcessing(existing.status, nextStatus)) throw new ApiError(409, 'processing_terminal', '处理状态不能回退');
  const saved = await tx.put('message_processing', {
    ...(existing ?? { source_message_id: message.id, client_message_id: message.client_message_id ?? null, received_at: now(), plan_id: null, task_ids: [], reply_message_id: null, action_id: null }),
    status: nextStatus, phase: 'planning', attempt_id: attemptId, owner_device_id: lease.device_id, owner_epoch: String(lease.epoch),
    started_at: existing?.started_at ?? now(), last_progress_at: now(), reason_code: 'model_in_progress', retry_mode: 'reconcile_first', completed_at: null,
  }, existing?.id);
  await emitProcessing(tx, saved, message.task_id ?? null);
  await stampMessage(tx, message, saved);
  return { processing: processingView(saved, message.id), attempt_id: attemptId };
}

export async function progressMessage(tx: Tx, messageId: string, body: Doc, lease: Doc): Promise<Doc> {
  const message = await tx.need('messages', uuid(messageId), true);
  const existing = await processingFor(tx, message.id);
  if (!existing) throw new ApiError(404, 'not_found', '处理回执不存在');
  const reportId = typeof body.report_id === 'string' ? body.report_id : '';
  if (!reportId || reportId.length > 200) throw new ApiError(422, 'invalid_report', '进度报告无效');
  if ((existing.report_ids ?? []).includes(reportId)) return processingView(existing, message.id);
  if (existing.attempt_id !== body.attempt_id) throw new ApiError(409, 'attempt_mismatch', '处理尝试不匹配');
  if (existing.owner_device_id !== lease.device_id || String(existing.owner_epoch) !== String(lease.epoch)) throw new ApiError(409, 'attempt_mismatch', '处理尝试不匹配');
  if (Number(body.expected_version) !== Number(existing.version)) throw new ApiError(409, 'processing_conflict', '处理回执版本不匹配');
  const status = (body.status ?? existing.status) as MessageProcessingStatus;
  if (!canAdvanceProcessing(existing.status, status)) throw new ApiError(409, 'processing_terminal', '处理状态不能回退');
  const phase = body.phase === undefined ? existing.phase ?? null : body.phase;
  const changed = status !== existing.status || phase !== (existing.phase ?? null);
  const saved = await tx.put('message_processing', {
    ...existing, status, phase, reason_code: body.reason_code === undefined ? existing.reason_code ?? null : reasonCode(body.reason_code),
    plan_id: body.plan_id === undefined ? existing.plan_id ?? null : body.plan_id, task_ids: Array.isArray(body.task_ids) ? body.task_ids.slice(0, 50) : existing.task_ids ?? [],
    last_progress_at: changed ? now() : existing.last_progress_at ?? null, report_ids: [...(existing.report_ids ?? []), reportId].slice(-30),
  }, existing.id);
  await emitProcessing(tx, saved, message.task_id ?? null);
  await stampMessage(tx, message, saved);
  return processingView(saved, message.id);
}

export async function completeProcessing(tx: Tx, source: Doc, reply: Doc, outcome: 'handled' | 'interrupted'): Promise<void> {
  if (!interactionFlags().message_processing) return;
  const existing = await processingFor(tx, source.id);
  if (!existing || PROCESSING_TERMINAL.has(existing.status)) return;
  const plan = (await tx.all('plans')).find(item => item.source_message_id === source.id) ?? null;
  const taskIds = plan ? (await tx.all('tasks')).filter(task => task.plan_id === plan.id).map(task => task.id) : [];
  const status: MessageProcessingStatus = outcome === 'interrupted' ? 'interrupted' : 'handled';
  if (!canAdvanceProcessing(existing.status, status)) return;
  const saved = await tx.put('message_processing', {
    ...existing, status, phase: 'replying', reply_message_id: reply.id, plan_id: plan?.id ?? existing.plan_id ?? null, task_ids: taskIds,
    completed_at: now(), last_progress_at: now(), reason_code: outcome === 'interrupted' ? 'interrupted_unknown' : existing.reason_code ?? null,
    retry_mode: outcome === 'interrupted' ? 'explicit_new_attempt' : 'none',
  }, existing.id);
  await emitProcessing(tx, saved, source.task_id ?? null);
  await stampMessage(tx, source, saved);
}

function actionView(row: Doc): Doc {
  return {
    action_id: row.id, task_id: row.task_id, action: row.action, status: row.status, run_id: row.run_id ?? null, lease_epoch: row.lease_epoch ?? null,
    source_message_id: row.source_message_id ?? null, reason_code: row.reason_code ?? null, accepted_at: row.accepted_at, updated_at: row.updated_at,
    completed_at: row.completed_at ?? null, version: row.version, target: row.target ?? null,
  };
}

function initialAction(action: string, task: Doc, run: Doc | null): { status: ActionReceiptStatus; reason: string | null; expect: 'stop' | 'start' | 'switch' | 'done'; bound_run_id: string | null } {
  const stopping = run?.state === 'stopping' || task.status === 'pausing' || task.status === 'switching';
  if (stopping && run && RUN_ACTIVE.includes(run.state)) return { status: 'accepted', reason: null, expect: action === 'switch' ? 'switch' : 'stop', bound_run_id: run.id };
  if (action === 'pause' && task.status === 'paused') return { status: 'completed', reason: 'already_terminal', expect: 'done', bound_run_id: run?.id ?? null };
  if (action === 'cancel' && ['cancelled', 'succeeded', 'failed'].includes(task.status)) return { status: 'completed', reason: 'already_terminal', expect: 'done', bound_run_id: run?.id ?? null };
  if (action === 'resume' || action === 'retry') return { status: 'accepted', reason: null, expect: 'start', bound_run_id: null };
  if (action === 'switch') return { status: 'accepted', reason: null, expect: 'switch', bound_run_id: run && RUN_ACTIVE.includes(run.state) ? run.id : null };
  return { status: 'accepted', reason: null, expect: 'stop', bound_run_id: run?.id ?? null };
}

export async function acceptControl(tx: Tx, input: { task: Doc; action: string; body: Doc; run: Doc | null; sourceMessageId?: string | null }): Promise<Doc> {
  if (!interactionFlags().action_receipts) return { action_id: randomUUID(), status: 'accepted' };
  const actionId = randomUUID();
  let run = input.run;
  if (run?.state === 'stopping' || run?.control?.action) {
    run = await tx.put('runs', { ...run, control: { ...(run.control ?? {}), action: input.action, action_id: actionId } }, run.id);
  }
  const initial = initialAction(input.action, input.task, run);
  const saved = await tx.put('task_actions', {
    task_id: input.task.id, action: input.action, status: initial.status, run_id: run?.id ?? null, lease_epoch: run?.lease_epoch ?? null,
    source_message_id: input.sourceMessageId ?? input.body.source_message_id ?? null, reason_code: initial.reason, accepted_at: now(),
    completed_at: initial.status === 'completed' ? now() : null, target: input.body.target ?? null, expect: initial.expect, bound_run_id: initial.bound_run_id,
  }, actionId);
  await tx.emit('action.changed', actionView(saved), input.task.id, run?.id ?? null);
  return { action_id: actionId, status: 'accepted', receipt: actionView(saved) };
}

export async function advanceActionReceipts(tx: Tx, task: Doc, run: Doc | null): Promise<void> {
  if (!interactionFlags().action_receipts || !run) return;
  const open = (await tx.all('task_actions')).filter(row => row.task_id === task.id && !ACTION_TERMINAL.has(row.status));
  for (const row of open) {
    let status = row.status as ActionReceiptStatus;
    let reason = row.reason_code ?? null;
    if (row.expect === 'stop' && row.bound_run_id === run.id) {
      if (run.state === 'result_unknown' || run.state === 'lost') { status = 'result_unknown'; reason = 'reconcile_required'; }
      else if (row.action === 'pause' && run.state === 'paused') status = 'completed';
      else if (row.action === 'cancel' && (run.state === 'cancelled' || task.status === 'cancelled')) status = 'completed';
    }
    if (row.expect === 'switch' && row.bound_run_id === run.id && ['paused', 'cancelled'].includes(run.state)) status = row.status === 'accepted' ? 'applying' : status;
    if ((row.expect === 'start' || row.expect === 'switch') && ['dispatched', 'starting', 'running'].includes(run.state) && run.id !== row.bound_run_id) status = 'completed';
    if (row.expect === 'start' && task.status === 'cancelled' && !['dispatched', 'starting', 'running'].includes(run.state)) status = 'superseded';
    if (status === row.status || !canAdvanceAction(row.status, status)) continue;
    const saved = await tx.put('task_actions', { ...row, status, reason_code: reason, run_id: run.id, lease_epoch: run.lease_epoch ?? row.lease_epoch ?? null, completed_at: ACTION_TERMINAL.has(status) || status === 'result_unknown' ? now() : row.completed_at ?? null }, row.id);
    await tx.emit('action.changed', actionView(saved), task.id, run.id);
  }
}

export async function readActionReceipt(tx: Tx, id: string): Promise<Doc> {
  return actionView(await tx.need('task_actions', uuid(id)));
}

export async function noteActionProgress(tx: Tx, deviceId: string, payload: Doc): Promise<void> {
  const action = await tx.need('task_actions', uuid(payload.action_id, 'action_id'), true);
  const run = await tx.need('runs', uuid(payload.run_id), true);
  if (payload.device_id !== deviceId || run.device_id !== deviceId || String(payload.lease_epoch) !== String(run.lease_epoch)) throw new ApiError(409, 'stale_action', '控制信号与当前执行不一致');
  if (action.bound_run_id && action.bound_run_id !== run.id && action.run_id && action.run_id !== run.id) throw new ApiError(409, 'stale_action', '旧的控制信号不能作用于新的执行');
  if (action.run_id && action.run_id !== run.id && action.expect === 'stop') throw new ApiError(409, 'stale_action', '旧的控制信号不能作用于新的执行');
  const status = payload.status === 'delivered' || payload.status === 'applying' ? payload.status : null;
  if (!status || !canAdvanceAction(action.status, status)) return;
  const saved = await tx.put('task_actions', { ...action, status, run_id: run.id, lease_epoch: String(run.lease_epoch) }, action.id);
  await tx.emit('action.changed', actionView(saved), action.task_id, run.id);
}

export function runProgressPhase(state: string): string {
  if (state === 'dispatched') return 'dispatched';
  if (state === 'starting') return 'accepted';
  if (state === 'running') return 'executing';
  if (state === 'waiting_input') return 'waiting_input';
  if (state === 'stopping') return 'pausing';
  if (state === 'paused') return 'paused';
  if (state === 'succeeded') return 'reviewing';
  if (state === 'result_unknown') return 'result_unknown';
  return state;
}

export async function emitTaskProgress(tx: Tx, task: Doc, run: Doc | null, source: string, phase: string, summary: string, waiting: string | null): Promise<void> {
  if (!interactionFlags().task_progress) return;
  await tx.emit('task.progress.changed', {
    task_id: task.id, run_id: run?.id ?? null, phase, summary: summary.slice(0, 300), last_progress_at: now(), waiting_reason: waiting,
    source, version: Number(task.version ?? run?.version ?? 1), updated_at: now(),
  }, task.id, run?.id ?? null);
}

export async function workspaceSnapshot(tx: Tx, deviceView: (device: Doc) => Promise<Doc>): Promise<Doc> {
  const stream = await tx.client.query('SELECT seq FROM sa_streams WHERE tenant_id=$1', [tx.tenant]);
  const cursor = stream.rows[0] ? String(stream.rows[0].seq) : '0';
  const terminal = new Set(['succeeded', 'failed', 'cancelled']);
  const tasks = (await tx.all('tasks')).filter(task => !terminal.has(task.status) || task.status === 'awaiting_review' || task.delivery_status === 'pending');
  const messages = (await tx.all('messages')).slice(-50);
  const processing = (await tx.all('message_processing')).filter(row => !PROCESSING_TERMINAL.has(row.status)).map(row => processingView(row, row.source_message_id));
  const actions = (await tx.all('task_actions')).filter(row => !ACTION_TERMINAL.has(row.status) || Date.parse(row.updated_at) > Date.now() - 86_400_000).slice(-50).map(actionView);
  const questions = (await tx.all('questions')).filter(question => question.status === 'open');
  const devices = await Promise.all((await tx.all('devices')).map(device => deviceView(device)));
  return { as_of: now(), cursor, tasks, messages, processing, actions, questions, devices };
}

const STATUS_LABEL: Record<string, string> = {
  queued: '排队中', running: '正在执行', waiting_input: '待你回答', waiting_device: '等待电脑', pausing: '正在暂停', paused: '已暂停',
  switching: '正在切换', awaiting_review: '待验收', failed: '失败', blocked: '等待前置任务', awaiting_approval: '待你确认',
};

const PLAN_DECISION = /^(确认|开始执行|确认执行|取消|拒绝|不要执行|取消执行)(?:\s+[a-f0-9-]{8,36})?$/i;

export async function applyFastPath(tx: Tx, message: Doc, perform: (task: Doc, action: TaskControlAction) => Promise<Doc>): Promise<Doc | null> {
  if (!interactionFlags().chat_fast_path || message.task_id || message.role !== 'user') return null;
  const intent = parseFastIntent(String(message.content ?? ''));
  if (intent.kind === 'none') return null;
  const normalized = String(message.content ?? '').trim().replace(/[。！!？?，,\s]+$/u, '').trim();
  if (PLAN_DECISION.test(normalized) && (await tx.all('plans')).some(plan => plan.state === 'awaiting_confirmation')) return null;
  const tasks = await tx.all('tasks');
  const runs = await tx.all('runs');
  const refs: FastTaskRef[] = tasks.map(task => ({ id: task.id, title: String(task.title ?? task.goal ?? '未命名任务').slice(0, 80), status: String(task.status) }));
  const binding = bindFastIntent(intent, refs);
  const reply = async (content: string, status: MessageProcessingStatus, reason: string, actionId: string | null) => {
    const assistant = await tx.put('messages', { role: 'assistant', content, task_id: null, source_message_id: message.id });
    await tx.put('inbox_receipts', { source_message_id: message.id }, message.id);
    await tx.emit('assistant.replied', assistant, null);
    if (interactionFlags().message_processing) {
      const existing = await processingFor(tx, message.id);
      const saved = await tx.put('message_processing', {
        ...(existing ?? { source_message_id: message.id, client_message_id: message.client_message_id ?? null, received_at: now(), retry_mode: 'none' }),
        status, phase: null, reason_code: reason, reply_message_id: assistant.id, action_id: actionId, completed_at: status === 'waiting_input' ? null : now(), last_progress_at: now(),
      }, existing?.id);
      await emitProcessing(tx, saved, null);
      return stampMessage(tx, { ...message, action_id: actionId }, saved);
    }
    return message;
  };
  const describe = (task: Doc) => {
    const run = runs.find(item => item.id === task.current_run_id);
    const summary = typeof run?.summary === 'string' && run.summary.trim() ? run.summary.slice(0, 180) : '尚无新的执行进展';
    return `「${String(task.title).slice(0, 80)}」${STATUS_LABEL[task.status] ?? task.status}。最近进展：${summary}。更新时间：${task.updated_at}。`;
  };
  if (binding.type === 'status') {
    const lines = binding.tasks.length ? binding.tasks.map(item => describe(tasks.find(task => task.id === item.id)!)) : ['当前没有进行中的任务。'];
    return reply(`${lines.join('\n')}数据时间：${now()}。`, 'handled', 'deterministic_status', null);
  }
  if (binding.type === 'choose') {
    const lines = binding.choices.map(item => `- ${item.title}（${item.id.slice(0, 8)}）`);
    const verb = binding.action === 'select' ? '已看到多个匹配。' : '有多个任务符合，还没有执行操作。';
    return reply(`${verb}\n请回复“选择 ”加任务编号前 8 位：\n${lines.join('\n')}`, 'waiting_input', 'ambiguous_target', null);
  }
  if (binding.type === 'missing') return reply('没有找到可执行该操作的任务。', 'handled', 'ambiguous_target', null);
  if (binding.type === 'act') {
    const task = tasks.find(item => item.id === binding.task.id);
    if (!task) return reply('没有找到可执行该操作的任务。', 'handled', 'ambiguous_target', null);
    try {
      const result = await perform(task, binding.action);
      const verb = binding.action === 'pause' ? '暂停' : binding.action === 'cancel' ? '取消' : binding.action === 'resume' ? '继续' : '重试';
      return reply(`已收到${verb}「${binding.task.title}」的请求。这只表示请求已保存，还不表示执行电脑已经完成该操作。`, 'handled', 'control_accepted', result.action_id ?? null);
    } catch (error) {
      if (error instanceof ApiError) return reply(`没能保存这次操作：${error.message}`, 'failed', 'claim_rejected', null);
      throw error;
    }
  }
  return null;
}
