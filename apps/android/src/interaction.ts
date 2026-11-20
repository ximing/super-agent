/** Client interaction semantics. Labels and fast-path grammar match packages/protocol/src/interaction.ts. */

export type MessageProcessingStatus = 'received' | 'queued' | 'processing' | 'waiting_input' | 'handled' | 'failed' | 'interrupted';
export type ActionReceiptStatus = 'accepted' | 'delivered' | 'applying' | 'completed' | 'failed' | 'result_unknown' | 'superseded';
export type TaskControlAction = 'pause' | 'resume' | 'cancel' | 'switch' | 'retry';

export interface FastTaskRef { id: string; title: string; status: string }
export type FastIntent =
  | { kind: 'none' }
  | { kind: 'status' }
  | { kind: 'pause' | 'resume' | 'cancel' | 'retry'; task_ref: string | null }
  | { kind: 'select'; task_ref: string };
export type FastBinding =
  | { type: 'ignore' }
  | { type: 'status'; tasks: FastTaskRef[] }
  | { type: 'act'; action: 'pause' | 'resume' | 'cancel' | 'retry'; task: FastTaskRef }
  | { type: 'choose'; action: 'pause' | 'resume' | 'cancel' | 'retry' | 'select'; choices: FastTaskRef[] }
  | { type: 'missing'; action: 'pause' | 'resume' | 'cancel' | 'retry' | 'select' };

const FAST_PUNCTUATION = /[。！!？?，,\s]+$/u;
const CONTROL_ELIGIBLE = new Set(['queued', 'blocked', 'running', 'waiting_input', 'waiting_device', 'awaiting_approval', 'pausing', 'paused', 'switching', 'awaiting_review', 'failed']);

export function parseFastIntent(text: string): FastIntent {
  const normalized = text.trim().replace(FAST_PUNCTUATION, '').trim();
  if (!normalized || normalized.length > 80) return { kind: 'none' };
  if (/^(进度|进度呢|现在到哪了|现在怎么样|状态|status)$/i.test(normalized)) return { kind: 'status' };
  const select = /^(?:选择|就这个)\s+([a-f0-9-]{8,36})$/i.exec(normalized);
  if (select?.[1]) return { kind: 'select', task_ref: select[1].toLowerCase() };
  const control = /^(暂停|暂停一下|pause|继续|恢复|resume|取消|停止|cancel|重试|retry)(?:\s+([a-f0-9-]{8,36}))?$/i.exec(normalized);
  if (!control?.[1]) return { kind: 'none' };
  const word = control[1].toLowerCase();
  const task_ref = control[2] ? control[2].toLowerCase() : null;
  if (word === '暂停' || word === '暂停一下' || word === 'pause') return { kind: 'pause', task_ref };
  if (word === '继续' || word === '恢复' || word === 'resume') return { kind: 'resume', task_ref };
  if (word === '取消' || word === '停止' || word === 'cancel') return { kind: 'cancel', task_ref };
  return { kind: 'retry', task_ref };
}

function eligible(task: FastTaskRef, action: 'pause' | 'resume' | 'cancel' | 'retry' | 'status' | 'select'): boolean {
  if (action === 'status' || action === 'select') return !['succeeded', 'cancelled'].includes(task.status);
  if (!CONTROL_ELIGIBLE.has(task.status)) return false;
  if (action === 'pause') return ['queued', 'blocked', 'running', 'waiting_input', 'waiting_device', 'awaiting_approval', 'pausing'].includes(task.status);
  if (action === 'resume') return task.status === 'paused';
  if (action === 'retry') return ['failed', 'paused', 'awaiting_review'].includes(task.status);
  return !['succeeded', 'failed', 'cancelled'].includes(task.status);
}

function matchesRef(task: FastTaskRef, ref: string): boolean {
  const id = task.id.toLowerCase();
  return id === ref || id.startsWith(ref);
}

export function bindFastIntent(intent: FastIntent, tasks: FastTaskRef[]): FastBinding {
  if (intent.kind === 'none') return { type: 'ignore' };
  if (intent.kind === 'status') return { type: 'status', tasks: tasks.filter(task => eligible(task, 'status')) };
  if (intent.kind === 'select') {
    const choices = tasks.filter(task => eligible(task, 'select') && matchesRef(task, intent.task_ref));
    if (choices.length === 1 && choices[0]) return { type: 'status', tasks: [choices[0]] };
    if (choices.length === 0) return { type: 'missing', action: 'select' };
    return { type: 'choose', action: 'select', choices };
  }
  const pool = tasks.filter(task => eligible(task, intent.kind));
  const taskRef = intent.task_ref;
  const choices = taskRef ? pool.filter(task => matchesRef(task, taskRef)) : pool;
  if (choices.length === 1 && choices[0]) return { type: 'act', action: intent.kind, task: choices[0] };
  if (choices.length === 0) return { type: 'missing', action: intent.kind };
  return { type: 'choose', action: intent.kind, choices };
}

export type ChatDecision =
  | { type: 'send' }
  | { type: 'choose'; action: 'pause' | 'resume' | 'cancel' | 'retry' | 'status' | 'select'; choices: FastTaskRef[] }
  | { type: 'act'; action: 'pause' | 'resume' | 'cancel' | 'retry'; task: FastTaskRef }
  | { type: 'status'; tasks: FastTaskRef[] }
  | { type: 'missing'; action: string };

/** Whole-command fast path only. Conditional or mixed sentences stay on the normal send path. */
export function decideChat(text: string, tasks: FastTaskRef[]): ChatDecision {
  const binding = bindFastIntent(parseFastIntent(text), tasks);
  if (binding.type === 'ignore') return { type: 'send' };
  if (binding.type === 'status') {
    if (binding.tasks.length > 1) return { type: 'choose', action: 'status', choices: binding.tasks };
    return { type: 'status', tasks: binding.tasks };
  }
  if (binding.type === 'choose') return { type: 'choose', action: binding.action, choices: binding.choices };
  if (binding.type === 'act') return { type: 'act', action: binding.action, task: binding.task };
  return { type: 'missing', action: binding.action };
}

export function explicitCommand(action: string, taskId: string): string {
  const prefix = taskId.toLowerCase().slice(0, 8);
  if (action === 'pause') return `暂停 ${prefix}`;
  if (action === 'resume') return `继续 ${prefix}`;
  if (action === 'cancel') return `取消 ${prefix}`;
  if (action === 'retry') return `重试 ${prefix}`;
  return `选择 ${prefix}`;
}

export function processingLabel(status: MessageProcessingStatus | null, reason: string | null, historical?: 'handled' | 'unknown'): string {
  if (historical === 'unknown' || status == null) return '历史处理状态未知';
  if (reason === 'waiting_device_offline') return '主助理电脑离线，消息已保存';
  if (reason === 'waiting_previous_message' || reason === 'assistant_lease_held') return '主助理正在处理上一条消息';
  if (reason === 'model_in_progress') return '模型处理中';
  if (reason === 'ambiguous_target') return '有多个任务符合，请先选择';
  if (reason === 'interrupted_unknown' || status === 'interrupted') return '处理结果待核对';
  if (status === 'received' || status === 'queued') return '已收到';
  if (status === 'processing') return '正在处理';
  if (status === 'waiting_input') return '需要你处理';
  if (status === 'handled') return '已回复';
  if (status === 'failed') return '处理失败';
  return '尚未确认处理状态';
}

export function actionLabel(action: TaskControlAction, status: ActionReceiptStatus): string {
  if (status === 'accepted') return '请求已收到';
  if (status === 'delivered' || status === 'applying') {
    if (action === 'pause' || action === 'cancel') return '正在暂停';
    return '等待电脑处理';
  }
  if (status === 'result_unknown') return '结果待核对';
  if (status === 'failed') return '操作失败';
  if (status === 'superseded') return '操作已被新的执行替代';
  if (action === 'pause') return '已暂停';
  if (action === 'cancel') return '已取消';
  if (action === 'resume' || action === 'retry') return '已开始新的执行';
  if (action === 'switch') return '已切换';
  return '已完成';
}

const PROCESSING_STATUSES = new Set<string>(['received', 'queued', 'processing', 'waiting_input', 'handled', 'failed', 'interrupted']);
const ACTION_STATUSES = new Set<string>(['accepted', 'delivered', 'applying', 'completed', 'failed', 'result_unknown', 'superseded']);

export function asProcessingStatus(value: unknown): MessageProcessingStatus | null {
  return typeof value === 'string' && PROCESSING_STATUSES.has(value) ? value as MessageProcessingStatus : null;
}

export function asActionStatus(value: unknown): ActionReceiptStatus | null {
  return typeof value === 'string' && ACTION_STATUSES.has(value) ? value as ActionReceiptStatus : null;
}

export function acceptEntityVersion(incoming: number | null | undefined, current: number | null | undefined): boolean {
  if (current == null) return true;
  if (incoming == null || !Number.isFinite(incoming)) return false;
  return incoming >= current;
}

export function compareStreamSeq(left: string, right: string): number {
  if (!/^\d{1,20}$/.test(left) || !/^\d{1,20}$/.test(right)) return Number.NaN;
  const normalize = (value: string) => value.replace(/^0+/, '') || '0';
  const a = normalize(left);
  const b = normalize(right);
  if (a.length !== b.length) return a.length < b.length ? -1 : 1;
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

export function mergeByVersion<T extends { id: string; version?: number | null }>(current: T[], incoming: T): T[] {
  const index = current.findIndex(item => item.id === incoming.id);
  if (index < 0) return [incoming, ...current];
  const existing = current[index];
  if (!existing || !acceptEntityVersion(incoming.version, existing.version)) return current;
  const next = current.slice();
  next[index] = incoming;
  return next;
}

export function mergeCollection<T extends { id: string; version?: number | null }>(current: T[], incoming: T[], mode: 'replace' | 'upsert'): T[] {
  const currentById = new Map(current.map(item => [item.id, item]));
  const merged = incoming.map(item => {
    const previous = currentById.get(item.id);
    if (previous && !acceptEntityVersion(item.version, previous.version)) return previous;
    return item;
  });
  if (mode === 'replace') return merged;
  const seen = new Set(incoming.map(item => item.id));
  return [...merged, ...current.filter(item => !seen.has(item.id))];
}

export interface TrackedEvent { streamSeq: string; eventId: string | null; type: string; taskId: string | null }
export interface ProjectionCursor { persisted: string; dirty: TrackedEvent[] }

export function enqueueProjection(state: ProjectionCursor, events: TrackedEvent[]): ProjectionCursor {
  const dirty = state.dirty.slice();
  for (const event of events) {
    if (!/^\d{1,20}$/.test(event.streamSeq) || compareStreamSeq(event.streamSeq, state.persisted) <= 0) continue;
    if (dirty.some(item => item.streamSeq === event.streamSeq || (event.eventId !== null && item.eventId === event.eventId))) continue;
    dirty.push(event);
  }
  return { persisted: state.persisted, dirty };
}

/** Advance only across the contiguous successful prefix. A later success cannot skip a failed seq. */
export function commitProjection(state: ProjectionCursor, results: { streamSeq: string; ok: boolean }[]): ProjectionCursor {
  const status = new Map(results.map(item => [item.streamSeq, item.ok]));
  const ordered = state.dirty.filter(event => compareStreamSeq(event.streamSeq, state.persisted) > 0).sort((a, b) => compareStreamSeq(a.streamSeq, b.streamSeq));
  let persisted = state.persisted;
  const dirty: TrackedEvent[] = [];
  let blocked = false;
  for (const event of ordered) {
    if (!blocked && status.get(event.streamSeq) === true) {
      persisted = event.streamSeq;
      continue;
    }
    blocked = true;
    dirty.push(event);
  }
  return { persisted, dirty };
}

export function cursorAfterSnapshot(state: ProjectionCursor, snapshotCursor: string): ProjectionCursor {
  if (state.dirty.length || !/^\d{1,20}$/.test(snapshotCursor)) return state;
  if (compareStreamSeq(snapshotCursor, state.persisted) < 0) return state;
  return { persisted: snapshotCursor, dirty: [] };
}

export function shouldResetCursor(status: number): boolean {
  return status === 422;
}

export function shouldUseLegacyLoad(status: number): boolean {
  return status === 404;
}

export const RECONNECT_BANNER_GRACE_MS = 5_000;
export const PROGRESS_CHECK_AFTER_MS = 15_000;
export const PROGRESS_STALE_AFTER_MS = 60_000;

export function reconnectVisible(since: number | null, now: number): boolean {
  return since != null && now - since >= RECONNECT_BANNER_GRACE_MS;
}

export function projectionNeeds(event: { type: string; taskId: string | null }): { task: boolean; devices: boolean; questions: boolean; messages: boolean } {
  if (event.type === 'cursor') return { task: false, devices: false, questions: false, messages: false };
  return {
    task: Boolean(event.taskId),
    devices: event.type === 'device.changed',
    questions: event.type === 'notification.created' || event.type.startsWith('question.'),
    messages: event.type.startsWith('message.') || event.type === 'notification.created',
  };
}

export interface ClientCapabilities {
  message_processing: boolean;
  action_receipts: boolean;
  workspace_snapshot: boolean;
  chat_fast_path: boolean;
  task_progress: boolean;
}

export function capabilitiesFrom(status: number, body: unknown): ClientCapabilities | null {
  if (status === 404 || !body || typeof body !== 'object' || Array.isArray(body)) return null;
  const record = body as Record<string, unknown>;
  return {
    message_processing: record.message_processing === true,
    action_receipts: record.action_receipts === true,
    workspace_snapshot: record.workspace_snapshot === true,
    chat_fast_path: record.chat_fast_path === true,
    task_progress: record.task_progress === true,
  };
}

export function computerReceivedLine(caps: { message_processing?: boolean } | null, phase: string | null, runState: string | null): string | null {
  if (!caps || caps.message_processing !== true) return null;
  if (runState === 'dispatched') return null;
  if (phase === 'planning' || phase === 'preparing_tasks' || phase === 'executing' || phase === 'reviewing' || phase === 'replying') return '电脑已接收';
  if (runState === 'starting' || runState === 'running' || runState === 'waiting_input' || runState === 'stopping') return '电脑已接收';
  return null;
}

export function runStageLabel(type: string, state: string | null): string | null {
  if (state === 'dispatched' || (type === 'run.started' && (state == null || state === 'dispatched'))) return '已派发，等待电脑接受';
  if (state === 'starting') return '正在启动';
  if (state === 'running') return '正在执行';
  if (state === 'waiting_input') return '需要你处理';
  if (state === 'stopping') return '正在暂停';
  if (state === 'paused') return '已暂停';
  if (state === 'cancelled') return '已取消';
  if (state === 'result_unknown') return '结果待核对';
  if (state === 'succeeded') return '等待验收';
  return null;
}

export function phaseLabel(phase: string | null): string | null {
  const labels: Record<string, string> = {
    waiting_device: '等待执行电脑',
    planning: '正在理解目标',
    preparing_tasks: '准备任务',
    replying: '正在回复',
    executing: '执行中',
    reviewing: '交付核对',
    dispatched: '已派发，等待电脑接受',
    accepted: '正在启动',
    pausing: '正在暂停',
    paused: '已暂停',
    result_unknown: '结果待核对',
  };
  return phase && labels[phase] ? labels[phase] : null;
}

export function countLabel(completed: number | null | undefined, total: number | null | undefined): string | null {
  if (typeof completed !== 'number' || typeof total !== 'number') return null;
  if (!Number.isFinite(completed) || !Number.isFinite(total) || total <= 0 || completed < 0) return null;
  return `${completed}/${total}`;
}

export function progressCue(lastProgressAt: number | null, now: number): { check: boolean; stale: boolean } {
  if (lastProgressAt == null || !Number.isFinite(lastProgressAt)) return { check: false, stale: false };
  const age = now - lastProgressAt;
  return { check: age >= PROGRESS_CHECK_AFTER_MS, stale: age >= PROGRESS_STALE_AFTER_MS };
}

export function staleProgressText(phase: string | null, connected: boolean, deviceOnline: boolean | null): string {
  const stage = phaseLabel(phase) ?? '最近阶段尚未更新';
  const link = connected ? '服务连接正常' : '服务正在重连';
  const device = deviceOnline === true ? '执行电脑在线' : deviceOnline === false ? '执行电脑离线' : '执行电脑状态未知';
  return `${stage} · ${link} · ${device}`;
}

export function devicePresence(devices: { status: string; revoked?: boolean }[]): boolean | null {
  if (!devices.length) return null;
  return devices.some(device => !device.revoked && device.status !== 'offline');
}

export interface ExecutionPreferenceDraft {
  engine: string;
  device_id: string;
  selection_mode: 'pinned';
  model_id?: string | null;
}

export interface MemoryScopeDraft {
  project: string | null;
  sites: string[];
  global_preference: boolean;
  statuses: string[];
  max_version: number | null;
}

export type SubmissionPhase = 'unsent' | 'inflight' | 'result_unknown' | 'conflict' | 'rejected' | 'accepted';
export type SubmissionKind = 'message' | 'task' | 'input';

export interface PendingMessage {
  client_message_id: string;
  idempotency_key: string;
  text: string;
  task_id: string | null;
  execution_preference: ExecutionPreferenceDraft | null;
  memory_scope: MemoryScopeDraft | null;
  kind: SubmissionKind;
  phase: SubmissionPhase;
  created_at: string;
}

export interface ActionDraft {
  idempotency_key: string;
  task_id: string;
  action: TaskControlAction;
  task_version: number;
  target: { engine?: string; device_id?: string; model_id?: string | null } | null;
  action_id: string | null;
  receipt_status: ActionReceiptStatus | null;
  receipt_version?: number | null;
  phase: 'unsent' | 'inflight' | 'result_unknown' | 'conflict' | 'settled';
}

export interface AnswerDraft {
  question_id: string;
  idempotency_key: string;
  answer: string;
  version: number;
  phase: 'inflight' | 'result_unknown' | 'conflict' | 'settled';
}

export interface OutboxFile { messages: PendingMessage[]; actions: ActionDraft[]; answers: AnswerDraft[] }

export function emptyOutbox(): OutboxFile {
  return { messages: [], actions: [], answers: [] };
}

export function createPendingMessage(input: Omit<PendingMessage, 'phase'> & { phase?: SubmissionPhase }): PendingMessage {
  return { ...input, phase: input.phase ?? 'unsent' };
}

export function identityForEdit(message: PendingMessage, text: string, ids: { client_message_id: string; idempotency_key: string }): { client_message_id: string; idempotency_key: string; replacePrevious: boolean } {
  if (text === message.text) return { client_message_id: message.client_message_id, idempotency_key: message.idempotency_key, replacePrevious: true };
  return { ...ids, replacePrevious: message.phase === 'unsent' };
}

export function localRemoval(phase: SubmissionPhase): { allowed: boolean; title: string } {
  if (phase === 'unsent') return { allowed: true, title: '删除未发送' };
  return { allowed: false, title: '结果尚未确认，不能撤回' };
}

export function submissionLabel(phase: SubmissionPhase): string {
  if (phase === 'result_unknown') return '发送结果待确认';
  if (phase === 'conflict') return '请求冲突';
  if (phase === 'rejected') return '发送未接受';
  if (phase === 'accepted') return '已收到';
  return '发送中';
}

export function serverProcessingText(input: { caps: ClientCapabilities | null; status?: string | null; reason?: string | null; historical?: 'handled' | 'unknown' | null; hasProcessingRecord: boolean }): string {
  const status = asProcessingStatus(input.status);
  if (input.historical === 'unknown' || (input.hasProcessingRecord && input.status == null)) return processingLabel(null, input.reason ?? null, 'unknown');
  if (!input.caps?.message_processing && !status && !input.reason) return '';
  if (!status && !input.reason) return '';
  return processingLabel(status, input.reason ?? null, input.historical ?? undefined);
}

export interface ActionAcceptBody { action_id?: string; status?: string; receipt?: { status?: string; action?: string } | null }

/** A legacy accept body has no receipt and must not be shown as paused or cancelled. */
export function controlResultLabel(action: TaskControlAction, response: ActionAcceptBody | null | undefined): string {
  const status = asActionStatus(response?.receipt?.status);
  if (!status) return '请求已收到';
  return actionLabel(action, status);
}

export function actionDraftLabel(draft: ActionDraft): string {
  if (draft.phase === 'result_unknown') return '结果待核对';
  if (draft.phase === 'conflict') return '请求冲突';
  if (draft.phase === 'inflight' || draft.phase === 'unsent') return '发送中';
  if (!draft.receipt_status) return '请求已收到';
  return actionLabel(draft.action, draft.receipt_status);
}

const CONTROL_ACTIONS = new Set<string>(['pause', 'resume', 'cancel', 'switch', 'retry']);

function receiptAdvances(from: ActionReceiptStatus, to: ActionReceiptStatus): boolean {
  if (from === to) return true;
  if (from === 'completed' || from === 'failed' || from === 'superseded') return false;
  if (to === 'result_unknown' || to === 'failed' || to === 'superseded' || to === 'completed') return true;
  const rank: Record<ActionReceiptStatus, number> = { accepted: 0, delivered: 1, applying: 2, completed: 3, failed: 3, result_unknown: 3, superseded: 3 };
  return rank[to] >= rank[from];
}

/** Keep the newest receipt. A legacy accept without a receipt stays “请求已收到”. */
export function mergeActionReceipt(file: OutboxFile, incoming: { action_id: string; task_id: string; action: string; status: string; version?: number | null; target?: ActionDraft['target'] }): OutboxFile {
  if (!CONTROL_ACTIONS.has(incoming.action) || !incoming.action_id || !incoming.task_id) return file;
  const status = asActionStatus(incoming.status);
  if (!status) return file;
  const action = incoming.action as TaskControlAction;
  const match = file.actions.find(item => item.action_id === incoming.action_id)
    ?? file.actions.find(item => item.task_id === incoming.task_id && item.action === action && !item.action_id && (item.phase === 'unsent' || item.phase === 'inflight' || item.phase === 'result_unknown'));
  const incomingVersion = typeof incoming.version === 'number' && Number.isFinite(incoming.version) ? incoming.version : null;
  if (match?.receipt_version != null && !acceptEntityVersion(incomingVersion, match.receipt_version)) return file;
  if (match?.receipt_status && (incomingVersion == null || incomingVersion === match.receipt_version) && !receiptAdvances(match.receipt_status, status)) return file;
  return upsertAction(file, {
    idempotency_key: match?.idempotency_key ?? `server:${incoming.action_id}`,
    task_id: incoming.task_id,
    action,
    task_version: match?.task_version ?? 0,
    target: incoming.target ?? match?.target ?? null,
    action_id: incoming.action_id,
    receipt_status: status,
    receipt_version: incomingVersion ?? match?.receipt_version ?? null,
    phase: 'settled',
  });
}

export function mergeActionReceipts(file: OutboxFile, actions: unknown): OutboxFile {
  if (!Array.isArray(actions)) return file;
  return actions.reduce<OutboxFile>((current, item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return current;
    const row = item as Record<string, unknown>;
    if (typeof row.action_id !== 'string' || typeof row.task_id !== 'string' || typeof row.action !== 'string' || typeof row.status !== 'string') return current;
    const targetRecord = row.target;
    const target = targetRecord && typeof targetRecord === 'object' && !Array.isArray(targetRecord) ? targetRecord as ActionDraft['target'] : null;
    return mergeActionReceipt(current, { action_id: row.action_id, task_id: row.task_id, action: row.action, status: row.status, version: typeof row.version === 'number' ? row.version : null, target });
  }, file);
}

export function sameTarget(left: ActionDraft['target'], right: ActionDraft['target']): boolean {
  return (left?.engine ?? null) === (right?.engine ?? null) && (left?.device_id ?? null) === (right?.device_id ?? null) && (left?.model_id ?? null) === (right?.model_id ?? null);
}

export function reusableAction(existing: ActionDraft | undefined, next: { action: string; task_version: number; target: ActionDraft['target'] }): boolean {
  if (!existing) return false;
  if (existing.phase !== 'inflight' && existing.phase !== 'result_unknown' && existing.phase !== 'unsent') return false;
  return existing.action === next.action && existing.task_version === next.task_version && sameTarget(existing.target, next.target);
}

export function reusableAnswer(existing: AnswerDraft | undefined, version: number): boolean {
  if (!existing) return false;
  return existing.version === version && (existing.phase === 'inflight' || existing.phase === 'result_unknown');
}

export function messageRequestBody(record: PendingMessage): Record<string, unknown> {
  const body: Record<string, unknown> = { client_message_id: record.client_message_id, text: record.text, memory_scope: record.memory_scope };
  if (record.task_id) body.task_id = record.task_id;
  if (record.execution_preference) body.execution_preference = record.execution_preference;
  return body;
}

export function taskRequestBody(record: PendingMessage): Record<string, unknown> {
  const preference = record.execution_preference;
  if (!preference?.device_id) throw new Error('先选择执行电脑');
  return { goal: record.text, engine: preference.engine, device_id: preference.device_id, ...(preference.model_id ? { model_id: preference.model_id } : {}), memory_scope: record.memory_scope };
}

export function actionRequestBody(draft: ActionDraft): Record<string, unknown> {
  return { action: draft.action, ...(draft.target ? { target: draft.target } : {}) };
}

export interface SubmissionTransport {
  lookup(clientMessageId: string): Promise<{ status: number; body?: unknown }>;
  post(record: PendingMessage): Promise<{ status: number; body?: unknown }>;
}

export interface DispatchResult {
  record: PendingMessage;
  decision: { type: 'merge' | 'unknown' | 'conflict' | 'rejected'; label: string };
  body?: unknown;
}

function unknownResult(record: PendingMessage): DispatchResult {
  return { record: { ...record, client_message_id: record.client_message_id, idempotency_key: record.idempotency_key, phase: 'result_unknown' }, decision: { type: 'unknown', label: '发送结果待确认' } };
}

export async function dispatchSubmission(record: PendingMessage, transport: SubmissionTransport, mode: 'send' | 'recover'): Promise<DispatchResult> {
  if (mode === 'recover' && record.kind === 'message') {
    try {
      const found = await transport.lookup(record.client_message_id);
      if (found.status === 200) return { record: { ...record, phase: 'accepted' }, decision: { type: 'merge', label: '已收到' }, body: found.body };
      if (found.status === 409) return { record: { ...record, phase: 'conflict' }, decision: { type: 'conflict', label: '请求冲突' } };
      if (found.status !== 404) return unknownResult(record);
    } catch {
      return unknownResult(record);
    }
  }
  try {
    const posted = await transport.post(record);
    if (posted.status >= 200 && posted.status < 300) return { record: { ...record, phase: 'accepted' }, decision: { type: 'merge', label: '已收到' }, body: posted.body };
    if (posted.status === 409) return { record: { ...record, phase: 'conflict' }, decision: { type: 'conflict', label: '请求冲突' } };
    if (posted.status === 404 || posted.status === 408 || posted.status === 0 || posted.status >= 500) return unknownResult(record);
    return { record: { ...record, phase: 'rejected' }, decision: { type: 'rejected', label: '发送未接受' } };
  } catch {
    return unknownResult(record);
  }
}

export async function submitPersisted(record: PendingMessage, persist: (record: PendingMessage) => Promise<void>, transport: SubmissionTransport): Promise<DispatchResult> {
  const inflight = { ...record, phase: 'inflight' as const };
  await persist(inflight);
  return dispatchSubmission(inflight, transport, 'send');
}

export function upsertMessage(file: OutboxFile, record: PendingMessage): OutboxFile {
  const index = file.messages.findIndex(item => item.client_message_id === record.client_message_id);
  const messages = file.messages.slice();
  if (index < 0) messages.push(record);
  else messages[index] = record;
  return { ...file, messages };
}

export function removeMessage(file: OutboxFile, clientMessageId: string): OutboxFile {
  return { ...file, messages: file.messages.filter(item => item.client_message_id !== clientMessageId) };
}

export function pruneMatched(file: OutboxFile, messages: { client_message_id?: string | null }[]): OutboxFile {
  const ids = new Set(messages.flatMap(message => message.client_message_id ? [message.client_message_id] : []));
  return { ...file, messages: file.messages.filter(item => !ids.has(item.client_message_id)) };
}

export function visiblePending(records: PendingMessage[], messages: { client_message_id?: string | null }[]): PendingMessage[] {
  const ids = new Set(messages.flatMap(message => message.client_message_id ? [message.client_message_id] : []));
  return records.filter(record => record.phase !== 'accepted' && !ids.has(record.client_message_id));
}

export function upsertAction(file: OutboxFile, draft: ActionDraft): OutboxFile {
  const index = file.actions.findIndex(item => item.task_id === draft.task_id && item.idempotency_key === draft.idempotency_key);
  const actions = file.actions.slice();
  if (index < 0) actions.push(draft);
  else actions[index] = draft;
  return { ...file, actions };
}

export function upsertAnswer(file: OutboxFile, draft: AnswerDraft): OutboxFile {
  const index = file.answers.findIndex(item => item.question_id === draft.question_id && item.idempotency_key === draft.idempotency_key);
  const answers = file.answers.slice();
  if (index < 0) answers.push(draft);
  else answers[index] = draft;
  return { ...file, answers };
}

export function parseOutbox(raw: string): OutboxFile | null {
  try {
    const parsed = JSON.parse(raw) as Partial<OutboxFile>;
    if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.messages) || !Array.isArray(parsed.actions)) return null;
    return { messages: parsed.messages, actions: parsed.actions, answers: Array.isArray(parsed.answers) ? parsed.answers : [] };
  } catch {
    return null;
  }
}

export function serializeOutbox(file: OutboxFile): string {
  return JSON.stringify(file);
}

export function failureKind(error: { name?: string; status?: number } | null | undefined): 'timeout' | 'conflict' | 'other' {
  if (!error) return 'timeout';
  if (error.status === 409) return 'conflict';
  if (error.name === 'AbortError' || error.status === 408 || error.status === 0 || (typeof error.status === 'number' && error.status >= 500)) return 'timeout';
  if (typeof error.status !== 'number') return 'timeout';
  return 'other';
}

export function shareInflight<T>(flights: Map<string, Promise<unknown>>, key: string, run: () => Promise<T>): Promise<T> {
  const existing = flights.get(key) as Promise<T> | undefined;
  if (existing) return existing;
  const job = run().finally(() => {
    if (flights.get(key) === job) flights.delete(key);
  });
  flights.set(key, job);
  return job;
}

export function pendingKey(kind: 'refresh' | 'send' | 'control' | 'answer' | 'input' | 'message', id = ''): string {
  if (kind === 'refresh') return 'refresh:workspace';
  if (kind === 'send') return 'composer:send';
  return `${kind}:${id}`;
}

export function readRecord(body: unknown): Record<string, unknown> | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const record = body as Record<string, unknown>;
  const nested = record.message;
  if (nested && typeof nested === 'object' && !Array.isArray(nested)) return nested as Record<string, unknown>;
  return record;
}
