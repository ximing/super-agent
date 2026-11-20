import type { Device, Message, Question, Task } from './index.js';

/**
 * Interaction receipts, fast-path grammar, and version/cursor rules.
 * These types are the contract for the 2026-11-20 interaction work.
 * Old clients may ignore the optional fields. Missing capabilities means the legacy path.
 */

export type MessageProcessingStatus = 'received' | 'queued' | 'processing' | 'waiting_input' | 'handled' | 'failed' | 'interrupted';
export type MessageProcessingPhase = 'waiting_device' | 'planning' | 'preparing_tasks' | 'replying' | 'executing' | 'reviewing';
export type MessageRetryMode = 'transport_only' | 'explicit_new_attempt' | 'reconcile_first' | 'none';
export type ActionReceiptStatus = 'accepted' | 'delivered' | 'applying' | 'completed' | 'failed' | 'result_unknown' | 'superseded';
export type TaskControlAction = 'pause' | 'resume' | 'cancel' | 'switch' | 'retry';

export const MESSAGE_PROCESSING_STATUSES = ['received', 'queued', 'processing', 'waiting_input', 'handled', 'failed', 'interrupted'] as const;
export const MESSAGE_PROCESSING_PHASES = ['waiting_device', 'planning', 'preparing_tasks', 'replying', 'executing', 'reviewing'] as const;
export const ACTION_RECEIPT_STATUSES = ['accepted', 'delivered', 'applying', 'completed', 'failed', 'result_unknown', 'superseded'] as const;
export const PROCESSING_TERMINAL = new Set<MessageProcessingStatus>(['handled', 'failed', 'interrupted']);
export const ACTION_TERMINAL = new Set<ActionReceiptStatus>(['completed', 'failed', 'superseded']);

/** Safe classification codes. Never store message text, tool arguments, or secrets here. */
export const PROCESSING_REASON_CODES = [
  'waiting_device_offline',
  'waiting_previous_message',
  'assistant_lease_held',
  'model_in_progress',
  'needs_user',
  'ambiguous_target',
  'budget_blocked',
  'engine_unavailable',
  'interrupted_unknown',
  'historical_handled',
  'deterministic_status',
  'control_accepted',
  'execution_failed',
  'reconcile_required',
  'already_terminal',
  'claim_rejected',
] as const;
export type ProcessingReasonCode = typeof PROCESSING_REASON_CODES[number];

export interface MessageProcessing {
  id: string;
  source_message_id: string;
  client_message_id: string | null;
  version: number;
  /** Null only for a historical view that has no stored receipt. */
  status: MessageProcessingStatus | null;
  phase: MessageProcessingPhase | null;
  attempt_id: string | null;
  owner_device_id: string | null;
  owner_epoch: string | null;
  received_at: string | null;
  started_at: string | null;
  updated_at: string;
  completed_at: string | null;
  last_progress_at: string | null;
  reason_code: ProcessingReasonCode | string | null;
  plan_id: string | null;
  task_ids: string[];
  reply_message_id: string | null;
  retry_mode: MessageRetryMode;
  /** Present when no receipt row was stored. Do not invent timestamps for these. */
  historical?: 'handled' | 'unknown';
}

export interface MessageLookup { message: Message; processing: MessageProcessing }

export interface MessageClaimResult { processing: MessageProcessing; attempt_id: string }

export interface MessageProgressInput {
  report_id: string;
  attempt_id: string;
  expected_version: number;
  phase?: MessageProcessingPhase | null;
  status?: MessageProcessingStatus;
  reason_code?: ProcessingReasonCode | null;
  plan_id?: string | null;
  task_ids?: string[];
}

export interface ActionReceipt {
  action_id: string;
  task_id: string;
  action: TaskControlAction;
  status: ActionReceiptStatus;
  run_id: string | null;
  lease_epoch: string | null;
  source_message_id: string | null;
  reason_code: string | null;
  accepted_at: string;
  updated_at: string;
  completed_at: string | null;
  version: number;
  target?: { engine?: string; device_id?: string; model_id?: string | null } | null;
}

/** Legacy clients keep reading status === 'accepted'. New clients follow receipt.status. */
export interface ActionAcceptResponse { action_id: string; status: 'accepted'; receipt?: ActionReceipt }

export interface TaskProgress {
  task_id: string;
  run_id: string | null;
  phase: string;
  summary: string;
  last_progress_at: string | null;
  waiting_reason: string | null;
  source: 'run' | 'step' | 'question' | 'delivery' | 'review' | 'message' | 'action';
  version: number;
  updated_at: string;
  /** Count only when the server has a real structured count. Never a fabricated percent. */
  completed_count?: number | null;
  total_count?: number | null;
}

export interface WorkspaceSnapshot {
  as_of: string;
  cursor: string;
  /** Non-terminal tasks plus tasks still awaiting review. */
  tasks: Task[];
  /** Newest messages, capped by the server (50). Not a full transcript. */
  messages: Message[];
  processing: MessageProcessing[];
  /** Non-terminal receipts plus recently completed ones, capped by the server (50). */
  actions: ActionReceipt[];
  questions: Question[];
  devices: Device[];
}

export interface InteractionCapabilities {
  protocol: '2026-11-20';
  message_processing: boolean;
  action_receipts: boolean;
  workspace_snapshot: boolean;
  chat_fast_path: boolean;
  task_progress: boolean;
}

export const INTERACTION_EVENTS = {
  processing: 'message.processing.changed',
  progress: 'task.progress.changed',
  action: 'action.changed',
} as const;

export interface ActionProgressPayload {
  action_id: string;
  device_id: string;
  run_id: string;
  lease_epoch: string;
  status: 'delivered' | 'applying';
}

export type FastIntent =
  | { kind: 'none' }
  | { kind: 'status' }
  | { kind: 'pause' | 'resume' | 'cancel' | 'retry'; task_ref: string | null }
  | { kind: 'select'; task_ref: string };

const FAST_PUNCTUATION = /[。！!？?，,\s]+$/u;

/** Full-string match only. Mixed instructions stay on the normal understanding path. */
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

export interface FastTaskRef { id: string; title: string; status: string }

export type FastBinding =
  | { type: 'ignore' }
  | { type: 'status'; tasks: FastTaskRef[] }
  | { type: 'act'; action: 'pause' | 'resume' | 'cancel' | 'retry'; task: FastTaskRef }
  | { type: 'choose'; action: 'pause' | 'resume' | 'cancel' | 'retry' | 'select'; choices: FastTaskRef[] }
  | { type: 'missing'; action: 'pause' | 'resume' | 'cancel' | 'retry' | 'select' };

const CONTROL_ELIGIBLE = new Set(['queued', 'blocked', 'running', 'waiting_input', 'waiting_device', 'awaiting_approval', 'pausing', 'paused', 'switching', 'awaiting_review', 'failed']);

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

/** Never pick "the latest task" when more than one candidate matches. */
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
  const choices = intent.task_ref ? pool.filter(task => matchesRef(task, intent.task_ref!)) : pool;
  if (choices.length === 1 && choices[0]) return { type: 'act', action: intent.kind, task: choices[0] };
  if (choices.length === 0) return { type: 'missing', action: intent.kind };
  return { type: 'choose', action: intent.kind, choices };
}

const PROCESSING_EDGES: Record<MessageProcessingStatus, MessageProcessingStatus[]> = {
  received: ['received', 'queued', 'processing', 'waiting_input', 'handled', 'failed', 'interrupted'],
  queued: ['queued', 'processing', 'waiting_input', 'handled', 'failed', 'interrupted'],
  processing: ['processing', 'waiting_input', 'handled', 'failed', 'interrupted'],
  waiting_input: ['waiting_input', 'handled', 'failed', 'interrupted'],
  handled: ['handled'],
  failed: ['failed'],
  interrupted: ['interrupted'],
};

export function canAdvanceProcessing(from: MessageProcessingStatus | null, to: MessageProcessingStatus): boolean {
  if (from == null) return to === 'received' || to === 'processing';
  return PROCESSING_EDGES[from].includes(to);
}

/** Unobserved intermediate states may be skipped. Terminal receipts do not move backward. */
export function canAdvanceAction(from: ActionReceiptStatus, to: ActionReceiptStatus): boolean {
  if (from === to) return true;
  if (ACTION_TERMINAL.has(from)) return false;
  if (to === 'result_unknown' || to === 'failed' || to === 'superseded' || to === 'completed') return true;
  const rank: Record<ActionReceiptStatus, number> = { accepted: 0, delivered: 1, applying: 2, completed: 3, failed: 3, result_unknown: 3, superseded: 3 };
  return rank[to] >= rank[from];
}

/** A slow read must not replace a newer entity. Missing incoming version loses to a known version. */
export function acceptEntityVersion(incoming: number | null | undefined, current: number | null | undefined): boolean {
  if (current == null) return true;
  if (incoming == null || !Number.isFinite(incoming)) return false;
  return incoming >= current;
}

/** Numeric stream cursors. Lexicographic order treats "10" as less than "9". */
export function compareStreamSeq(left: string, right: string): number {
  if (!/^\d{1,20}$/.test(left) || !/^\d{1,20}$/.test(right)) return Number.NaN;
  const normalize = (value: string) => value.replace(/^0+/, '') || '0';
  const a = normalize(left);
  const b = normalize(right);
  if (a.length !== b.length) return a.length < b.length ? -1 : 1;
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

export const INTERACTION_METRICS = [
  'client_compose_ms',
  'server_persist_ms',
  'claim_delay_ms',
  'model_turn_ms',
  'dispatch_delay_ms',
  'control_accept_ms',
  'control_deliver_ms',
  'control_settle_ms',
  'projection_ms',
  'snapshot_align_ms',
] as const;

export const RECONNECT_BANNER_GRACE_MS = 5_000;
export const SSE_ROTATION_HINT_MS = 25_000;
export const PROGRESS_CHECK_AFTER_MS = 15_000;
export const PROGRESS_STALE_AFTER_MS = 60_000;

/** Local display copy. Callers pass only facts they actually have. */
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
