import type { MessageProcessingPhase, MessageProcessingStatus } from './interaction.js';

export const PROTOCOL_VERSION = '1.0' as const;
export const ENGINES = ['codex', 'grok'] as const;
export type Engine = typeof ENGINES[number];
export type TaskStatus = 'queued' | 'blocked' | 'running' | 'waiting_input' | 'waiting_device' | 'awaiting_approval' | 'pausing' | 'paused' | 'switching' | 'awaiting_review' | 'succeeded' | 'failed' | 'cancelled';
export type RunState = 'created' | 'dispatched' | 'starting' | 'running' | 'waiting_input' | 'stopping' | 'paused' | 'succeeded' | 'failed' | 'cancelled' | 'lost' | 'result_unknown';
export interface ListResponse<T> { items: T[]; next_cursor?: string | null }
export interface User { id: string; email: string; name: string; tenant_id: string }
export interface AuthSession { access_token: string; refresh_token: string; expires_in: number; user: User }
export interface EngineCapability { engine: Engine; ready: boolean; models: string[]; local_profile_id?: string; reason?: string; vision?: 'unsupported' | 'available'; vision_reason?: string }
export interface Capabilities { generation: number; engines: EngineCapability[]; tools: string[]; slots: { browser: number; worker: number } }
export interface Device { id: string; name: string; status: 'online' | 'offline' | 'busy'; last_seen_at: string | null; capabilities: Capabilities; version: number; revoked?: boolean; model_proxy_url?: string | null }
export interface ExecutionSettings { default_engine: Engine; default_device_id: string | null; assistant_device_id: string | null; memory_global_read?: boolean; version: number }
export interface MemoryBinding { provider: 'agent-recall'; configured: boolean; url: string | null; project: string | null; account: { id: string; email: string | null } | null; version: number }
export interface Task { id: string; title: string; goal: string; status: TaskStatus; reason_code: string | null; engine: Engine; model_id: string | null; device_id: string | null; device_name?: string | null; current_run_id: string | null; created_at: string; updated_at: string; version: number;
  parent_task_id?: string | null; root_task_id?: string | null; plan_id?: string | null;
  depends_on_task_ids?: string[]; deliverables?: string[]; delivery_status?: DeliveryStatus | null;
  memory_scope?: MemoryScope | null; budget?: Partial<RuntimeBudgetLimits> | null;
}
export type DeliveryStatus = 'not_submitted' | 'pending' | 'accepted' | 'rejected' | 'needs_input';
export interface PlanItem {
  item_key: string; title: string; goal: string; deliverables: string[];
  engine: Engine; device_id: string; model_id?: string;
  depends_on_keys?: string[]; parent_item_key?: string | null;
  memory_scope?: MemoryScope | null;
}
export type EvidenceReference = { kind: 'artifact' | 'step' | 'checkpoint'; id: string };
export interface DeliveryCheck { deliverable_index: number; passed: boolean; evidence_refs: EvidenceReference[] }
export interface TaskReviewInput { run_id: string; verdict: 'accept' | 'reject' | 'needs_input'; summary: string; checks: DeliveryCheck[] }
export interface CoordinatorEvent {
  id: string; type: 'delivery.submitted' | 'delivery.rejected' | 'task.failed' | 'task.cancelled' | 'task.result_unknown' | 'plan.settled';
  task_id: string | null; run_id: string | null; plan_id: string | null; delivery_id: string | null;
  source_message_id: string | null; status: 'pending' | 'completed'; reason_code: string | null;
  created_at: string; version: number;
}
export interface TaskDelivery {
  id: string; task_id: string; run_id: string; status: Exclude<DeliveryStatus, 'not_submitted'>;
  deliverables: string[]; checkpoint_id: string | null; artifact_ids: string[]; created_at: string; version: number;
}
export interface ArtifactMetadata {
  id: string; task_id: string; run_id: string | null; name: string; mime: string;
  size: number; status: string; created_at: string; version?: number;
  integrity?: 'server_snapshot' | 'legacy_unverified'; finalized_at?: string | null;
  evidence_kind?: 'page_capture' | 'screenshot' | 'memory_retrieval';
  provenance?: 'tool_broker' | null; captured_at?: string | null; source_url?: string | null;
  fresh?: boolean; stale?: boolean;
}
export interface TaskReview extends TaskReviewInput { id: string; task_id: string; created_at: string; version: number }
export interface TaskEvidence {
  task: Task; run: Run | null; delivery: TaskDelivery | null; deliverables: string[];
  result_text: string | null; checkpoint: { id: string; created_at: string } | null;
  evidence_error?: 'artifact_delivery_unavailable' | 'artifact_missing' | null;
  steps: ToolStep[]; artifacts: ArtifactMetadata[]; reviews: TaskReview[];
}
export interface Run { id: string; task_id: string; state: RunState; engine: Engine; device_id: string; model_id: string; lease_epoch: string; summary: string; result_text?: string | null; created_at: string }
export type ToolStepStatus = 'running' | 'succeeded' | 'failed' | 'cancelled' | 'result_unknown';
export type ToolStepError = 'tool_failed' | 'invalid_arguments' | 'not_authorized' | 'cancelled' | 'result_unknown';
/** Safe lifecycle metadata only. Tool arguments, outputs, URLs and arbitrary error text never belong here. */
export interface ToolStepUpdate {
  step_id: string; tool: string; status: ToolStepStatus; started_at: string;
  completed_at: string | null; error_code: ToolStepError | null;
}
export interface ToolStep extends Omit<ToolStepUpdate, 'step_id'> {
  id: string; run_id: string; title: string; created_at: string; version: number;
}
export interface Message { id: string; role: 'user' | 'assistant' | 'system'; content: string; task_id: string | null; created_at: string; memory_scope?: MemoryScope | null; schedule_id?: string | null; client_message_id?: string | null; source_message_id?: string | null; processing_status?: MessageProcessingStatus | null; processing_phase?: MessageProcessingPhase | null; reason_code?: string | null; action_id?: string | null }
export type ObservationSource = 'task_result' | 'page';
export interface ObservationSuggestion { id: string; status: 'pending' | 'confirmed' | 'dismissed'; goal: string; reason: string; fingerprint: string; task_id?: string | null; created_at: string }
export interface ObservationRule {
  id: string; kind: 'observation'; title: string; enabled: boolean; device_id: string; engine: Engine;
  project: string | null; sites: string[]; source: ObservationSource; goal: string; cooldown_minutes: number;
  task_id?: string | null; match?: 'status' | 'delivery' | 'reason' | null; value?: string | null; url?: string | null; condition?: string | null;
  next_eligible_at: string; last_status: string; last_fingerprint: string | null; consecutive_failures: number;
  suggestions: ObservationSuggestion[]; version: number;
}
export interface TakeoverCheck { name: 'authority' | 'reconciliation' | 'engine' | 'browser' | 'site_login' | 'artifacts'; status: 'pass' | 'fail' | 'unknown'; detail: string }
export type MemoryProvenance = 'user_statement' | 'tool_observation' | 'model_inference';
export interface Question { id: string; task_id: string; run_id: string; text: string; options: string[]; status: 'open' | 'answered' | 'cancelled'; version: number; created_at: string }
export type MemoryType = 'preference' | 'website' | 'procedure' | 'project' | 'experience';
export type MemoryStatus = 'candidate' | 'verified' | 'stale' | 'expired' | 'superseded';
export type MemoryRole = 'user' | 'planner' | 'worker';
export interface MemoryAccess {
  role: MemoryRole; project: string | null; sites: string[]; global_preference: boolean;
  statuses: MemoryStatus[]; max_version: number | null;
}
export interface Memory { id: string; title: string; content: string | null; type: MemoryType; site: string | null; status: MemoryStatus; version: number; updated_at: string; fresh?: boolean; stale?: boolean; stale_reason?: string | null }
export type CostSource = 'supplier_reported' | 'estimated' | 'unavailable';
export { canTransitionRun, canStartReplacement, moneyToTicks, ticksToMoney, summarizeCosts, normalizeModelProxyUrl } from './invariants.js';
export interface CostTotal { currency: string; amount: string; source: CostSource }
export interface CostSummary { totals: CostTotal[]; input_tokens: number; output_tokens: number; unknown_count: number; request_count: number; coverage: number; as_of: string; reserved_hold_usd?: string | null; reserved_unknown_count?: number }
export interface CostPoint { date: string; currency: string; amount: string; source: CostSource; input_tokens: number; output_tokens: number }
export interface CostBreakdown { key: string; label: string; currency: string; amount: string; request_count: number; unknown_count: number }
export interface Budget { monthly_limit_usd: string | null; task_limit_usd: string | null; used_usd: string; version: number; unknown_count?: number; category_limits?: Partial<Record<BudgetCategory, Partial<RuntimeBudgetLimits>>>; reserved_hold_usd?: string | null; reserved_unknown_count?: number }
export type BudgetCategory = 'worker' | 'assistant' | 'review' | 'proactive';
export type ActivityKind = 'run' | 'assistant' | 'review' | 'proactive';
/** Prefix of the single activity id shared by reserve, heartbeat, usage, release, and settlement. */
export const ACTIVITY_ID_PREFIXES = ['run', 'assistant', 'review', 'proactive', 'event'] as const;
export type ActivityIdPrefix = typeof ACTIVITY_ID_PREFIXES[number];
/**
 * Canonical activity id. Worker runs use `run:<runId>`. Chat planning uses `assistant:<messageId>`.
 * Scheduled planning uses `proactive:<messageId>`. Delivery review uses `review:<deliveryId>`.
 * Event coordination uses `event:<eventId>` and activity_kind `assistant`.
 * Callers must not link a cost by bare id, run id, or “the first reservation on this run”.
 */
export function canonicalActivityId(prefix: ActivityIdPrefix, rawId: string): string {
  return `${prefix}:${rawId}`;
}
/** Attempt ids are `${root}#N`. The root stays stable; N is the execution attempt. */
export function activityRootId(activityId: string): string {
  const mark = activityId.lastIndexOf('#');
  if (mark > 0 && /^\d+$/.test(activityId.slice(mark + 1))) return activityId.slice(0, mark);
  return activityId;
}
/** One page-observation command has one budget activity. The fingerprint is not the activity id. */
export function observationActivityId(commandId: string): string {
  return canonicalActivityId('proactive', `observation:${commandId}`);
}
/** A heartbeat older than this does not keep an already-expired hold in force. */
export const BUDGET_HEARTBEAT_MS = 45_000;
export type BudgetWriteMode = 'merge' | 'replace';
export const BUDGET_LIMIT_KEYS = ['max_total_tokens', 'max_model_calls', 'max_tool_steps', 'max_runtime_ms'] as const;
export type BudgetLimitKey = typeof BUDGET_LIMIT_KEYS[number];
export type BudgetStopReason = 'token_limit' | 'time_limit' | 'model_call_limit' | 'tool_step_limit' | 'budget_exhausted' | 'budget_unknown';
/** Observable run limits. These are not a provider-enforced dollar ceiling. */
export interface RuntimeBudgetLimits { max_total_tokens: number; max_model_calls: number; max_tool_steps: number; max_runtime_ms: number }
export const DEFAULT_BUDGET_LIMITS: Record<BudgetCategory, RuntimeBudgetLimits> = {
  worker: { max_total_tokens: 200_000, max_model_calls: 40, max_tool_steps: 80, max_runtime_ms: 1_200_000 },
  assistant: { max_total_tokens: 80_000, max_model_calls: 12, max_tool_steps: 40, max_runtime_ms: 600_000 },
  review: { max_total_tokens: 40_000, max_model_calls: 6, max_tool_steps: 12, max_runtime_ms: 180_000 },
  proactive: { max_total_tokens: 40_000, max_model_calls: 4, max_tool_steps: 20, max_runtime_ms: 600_000 },
};
/** Explicit configuration may raise a category above its default, but not without a bound. */
export const BUDGET_LIMIT_CEILING: RuntimeBudgetLimits = { max_total_tokens: 5_000_000, max_model_calls: 2_000, max_tool_steps: 5_000, max_runtime_ms: 8 * 60 * 60 * 1000 };
export const BUDGET_IN_FLIGHT_BOUNDARY = '停止只阻断下一次受管模型调用和工具步骤。已经发出的 Grok 请求，以及 Codex 当前内部回合，仍可能完成并记入用量。未知金额不按 0 美元计算，也不构成供应商账户硬额度。';
export const BUDGET_RECOVERY: Record<BudgetStopReason, string> = {
  token_limit: '这个任务的 Token 已用到当前上限。提高对应活动的 Token 上限后可以继续。',
  model_call_limit: '这个任务的模型调用次数已用到当前上限。提高上限后可以继续。',
  tool_step_limit: '这个任务的工具步骤已用到当前上限。提高上限后可以继续。',
  time_limit: '这一次活动的运行时间已到上限。提高单次时长后可以再开始一次。',
  budget_exhausted: '金额预算已用完。提高本月或本任务金额上限后，才能开始新的模型调用。',
  budget_unknown: '还有费用没核算清楚，不能按 0 计算。确认费用或调整金额上限前，不会开始新的模型调用。',
};
export interface MemoryScope {
  project: string | null;
  sites: string[];
  global_preference: boolean;
  statuses: string[];
  max_version: number | null;
}
/**
 * `requested` is inside `ceiling` when it cannot read anything the ceiling forbids.
 * A null project ceiling allows a narrower project. A null max_version ceiling allows a lower cap.
 * Empty sites and global_preference false are closed, not wildcards.
 */
export function memoryScopeWithin(requested: MemoryScope, ceiling: MemoryScope): boolean {
  if (ceiling.project && requested.project !== ceiling.project) return false;
  if (requested.sites.some(site => !ceiling.sites.includes(site))) return false;
  if (requested.global_preference && !ceiling.global_preference) return false;
  if (requested.statuses.some(status => !ceiling.statuses.includes(status))) return false;
  if (ceiling.max_version != null && (requested.max_version == null || requested.max_version > ceiling.max_version)) return false;
  return true;
}
export interface BudgetGrant {
  grant_id: string; category: BudgetCategory; limits: RuntimeBudgetLimits | null; ceiling?: RuntimeBudgetLimits;
  money_treatment: 'known' | 'unknown_not_zero' | 'unconfigured'; in_flight_boundary: string; dollar_cap: 'not_enforced';
  status?: string; expires_at?: string; activity_kind?: ActivityKind; activity_id?: string; task_id?: string | null; run_id?: string | null;
  device_id?: string | null; executable?: boolean; prior_activity_id?: string | null; attempt?: number;
  stop_reason?: BudgetStopReason | null; recovery?: string;
}
/** A stored grant may be reread after it ends. Only a reserved, unexpired grant for this activity and device may start work. */
export function grantExecutable(grant: Pick<BudgetGrant, 'status' | 'expires_at' | 'limits' | 'activity_id' | 'device_id'>, expected: { activityId: string; deviceId?: string | null; now?: number }): boolean {
  if (!grant.limits) return false;
  if (grant.status !== 'reserved') return false;
  const now = expected.now ?? Date.now();
  if (!grant.expires_at || !Number.isFinite(Date.parse(grant.expires_at)) || Date.parse(grant.expires_at) <= now) return false;
  if (grant.activity_id !== expected.activityId) return false;
  if (expected.deviceId && grant.device_id && grant.device_id !== expected.deviceId) return false;
  return true;
}
export interface Frame { frame_id: string; image_base64: string; width: number; height: number; captured_at: string; viewport_version: string; tab_id: string | null }
export interface ApiError { error: { code: string; message: string; retryable: boolean; request_id?: string } }
export interface ServerEvent { event_id: string; stream_seq: string; type: string; occurred_at: string; task_id?: string | null; run_id?: string | null; entity_version?: number; payload: Record<string, unknown> }
export interface RuntimeSelection { engine: Engine; model_id: string; local_profile_id: string }
export interface RunStartPayload { command_id: string; tenant_id: string; task_id: string; run_id: string; device_id: string; lease_epoch: string; scope_version_id: string; capability_generation: number; runtime: RuntimeSelection; expires_at: string; lease_valid_for_ms: number; checkpoint_id: string | null; budget_grant_id: string }
export interface WireMessage<T = Record<string, unknown>> { protocol_version: '1.0'; message_id: string; kind: string; sent_at: string; payload: T }
export interface RunContext { run: Run; task: Task; scope: Record<string, unknown>; checkpoint: Record<string, unknown> | null; run_ticket: string; lease_valid_for_ms: number; budget?: BudgetGrant | null }
export interface PairingStart { pairing_id: string; code: string; polling_secret: string; expires_at: string }
export interface PairingResult { status: 'pending' | 'claimed'; device_id?: string; tenant_id?: string }
export const TERMINAL_RUN_STATES = new Set<RunState>(['succeeded', 'failed', 'cancelled', 'paused']);

export * from './interaction.js';
