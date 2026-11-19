export const PROTOCOL_VERSION = '1.0' as const;
export const ENGINES = ['codex', 'grok'] as const;
export type Engine = typeof ENGINES[number];
export type TaskStatus = 'queued' | 'blocked' | 'running' | 'waiting_input' | 'waiting_device' | 'awaiting_approval' | 'pausing' | 'paused' | 'switching' | 'awaiting_review' | 'succeeded' | 'failed' | 'cancelled';
export type RunState = 'created' | 'dispatched' | 'starting' | 'running' | 'waiting_input' | 'stopping' | 'paused' | 'succeeded' | 'failed' | 'cancelled' | 'lost' | 'result_unknown';
export interface ListResponse<T> { items: T[]; next_cursor?: string | null }
export interface User { id: string; email: string; name: string; tenant_id: string }
export interface AuthSession { access_token: string; refresh_token: string; expires_in: number; user: User }
export interface EngineCapability { engine: Engine; ready: boolean; models: string[]; local_profile_id?: string; reason?: string }
export interface Capabilities { generation: number; engines: EngineCapability[]; tools: string[]; slots: { browser: number; worker: number } }
export interface Device { id: string; name: string; status: 'online' | 'offline' | 'busy'; last_seen_at: string | null; capabilities: Capabilities; version: number; revoked?: boolean }
export interface ExecutionSettings { default_engine: Engine; default_device_id: string | null; assistant_device_id: string | null; version: number }
export interface Task { id: string; title: string; goal: string; status: TaskStatus; reason_code: string | null; engine: Engine; model_id: string | null; device_id: string | null; device_name?: string | null; current_run_id: string | null; created_at: string; updated_at: string; version: number;
  parent_task_id?: string | null; root_task_id?: string | null; plan_id?: string | null;
  depends_on_task_ids?: string[]; deliverables?: string[]; delivery_status?: DeliveryStatus | null;
}
export type DeliveryStatus = 'not_submitted' | 'pending' | 'accepted' | 'rejected' | 'needs_input';
export interface PlanItem {
  item_key: string; title: string; goal: string; deliverables: string[];
  engine: Engine; device_id: string; model_id?: string;
  depends_on_keys?: string[]; parent_item_key?: string | null;
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
export interface Message { id: string; role: 'user' | 'assistant' | 'system'; content: string; task_id: string | null; created_at: string }
export interface Question { id: string; task_id: string; run_id: string; text: string; options: string[]; status: 'open' | 'answered' | 'cancelled'; version: number; created_at: string }
export type MemoryType = 'preference' | 'website' | 'procedure' | 'project' | 'experience';
export interface Memory { id: string; title: string; content: string; type: MemoryType; site: string | null; status: 'candidate' | 'verified' | 'stale'; version: number; updated_at: string }
export type CostSource = 'supplier_reported' | 'estimated' | 'unavailable';
export { canTransitionRun, canStartReplacement, moneyToTicks, ticksToMoney, summarizeCosts } from './invariants.js';
export interface CostTotal { currency: string; amount: string; source: CostSource }
export interface CostSummary { totals: CostTotal[]; input_tokens: number; output_tokens: number; unknown_count: number; request_count: number; coverage: number; as_of: string }
export interface CostPoint { date: string; currency: string; amount: string; source: CostSource; input_tokens: number; output_tokens: number }
export interface CostBreakdown { key: string; label: string; currency: string; amount: string; request_count: number; unknown_count: number }
export interface Budget { monthly_limit_usd: string | null; task_limit_usd: string | null; used_usd: string; version: number }
export interface Frame { frame_id: string; image_base64: string; width: number; height: number; captured_at: string; viewport_version: string; tab_id: string | null }
export interface ApiError { error: { code: string; message: string; retryable: boolean; request_id?: string } }
export interface ServerEvent { event_id: string; stream_seq: string; type: string; occurred_at: string; task_id?: string | null; run_id?: string | null; entity_version?: number; payload: Record<string, unknown> }
export interface RuntimeSelection { engine: Engine; model_id: string; local_profile_id: string }
export interface RunStartPayload { command_id: string; tenant_id: string; task_id: string; run_id: string; device_id: string; lease_epoch: string; scope_version_id: string; capability_generation: number; runtime: RuntimeSelection; expires_at: string; lease_valid_for_ms: number; checkpoint_id: string | null; budget_grant_id: string }
export interface WireMessage<T = Record<string, unknown>> { protocol_version: '1.0'; message_id: string; kind: string; sent_at: string; payload: T }
export interface RunContext { run: Run; task: Task; scope: Record<string, unknown>; checkpoint: Record<string, unknown> | null; run_ticket: string; lease_valid_for_ms: number }
export interface PairingStart { pairing_id: string; code: string; polling_secret: string; expires_at: string }
export interface PairingResult { status: 'pending' | 'claimed'; device_id?: string; tenant_id?: string }
export const TERMINAL_RUN_STATES = new Set<RunState>(['succeeded', 'failed', 'cancelled', 'paused']);
