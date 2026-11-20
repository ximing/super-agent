export type Engine = 'codex' | 'grok';
export interface User { id: string; email: string; name: string; tenant_id: string }
export interface Session { access_token: string; refresh_token: string; expires_in: number; user: User }
export interface AuthConfig { mode: 'development' | 'oidc'; issuer?: string; client_id?: string; authorization_endpoint?: string; token_endpoint?: string; redirect_uri?: string }
export interface EngineCapability { engine: Engine; ready: boolean; models: string[]; reason?: string; vision?: 'unsupported' | 'available'; vision_reason?: string }
export interface Device { revoked?: boolean; id: string; name: string; status: string; last_seen_at: string | null; version: number; capabilities: { generation: number; engines: EngineCapability[]; tools: string[]; slots: { browser: number; worker: number } } }
export interface ExecutionSettings { default_engine: Engine; default_device_id: string | null; assistant_device_id: string | null; memory_global_read?: boolean; version: number }
export interface MemoryScope { project?: string | null; sites?: string[]; global_preference?: boolean; statuses?: string[]; max_version?: number | null }
export interface TaskBudget { max_total_tokens?: number; max_model_calls?: number; max_tool_steps?: number; max_runtime_ms?: number }
export interface AgentTask {parent_task_id?:string|null;root_task_id?:string|null;plan_id?:string|null;depends_on_task_ids?:string[];deliverables?:string[];delivery_status?:'not_submitted'|'pending'|'accepted'|'rejected'|'needs_input'|null; id: string; title: string; goal: string; status: string; reason_code: string | null; engine: Engine; model_id: string | null; device_id: string | null; device_name?: string | null; current_run_id: string | null; created_at: string; updated_at: string; version: number; memory_scope?: MemoryScope | null; budget?: TaskBudget | null }
export interface Run { id: string; task_id: string; state: string; engine: Engine; device_id: string; model_id: string; lease_epoch: string; summary: string; result_text?: string | null; created_at: string }
export interface Message { id: string; role: string; content: string; task_id: string | null; created_at: string; version?: number | null; client_message_id?: string | null; processing_status?: string | null; processing_phase?: string | null; reason_code?: string | null; historical?: 'handled' | 'unknown' | null }
export interface Question { id: string; task_id: string; run_id: string; text: string; options: string[]; status: string; version: number; created_at: string }
export interface Memory { id: string; title: string; content: string; type: string; site: string | null; status: string; version: number; updated_at: string; origin?: string | null; source?: string | null; expires_at?: string | null; governance?: { verification?: string; valid_until?: string | null; conflicts_with?: string[]; supersedes?: string | null; superseded_by?: string | null; version?: number; claim?: string; evidence_refs?: {kind?: string; id?: string}[] } }
export interface MemorySettings { configured: boolean; url?: string | null; project?: string | null; version?: number }
export interface Schedule { id:string; title:string; goal:string; engine:Engine; device_id:string; interval_minutes:number; enabled:boolean; next_due_at:string|null; version:number }
export interface Artifact { id:string; name:string; mime:string; size:number; task_id:string|null; run_id:string|null; status:string; created_at:string }
export interface UploadDescriptor {artifact_id:string;upload_url:string;upload_headers:Record<string,string>;expires_at:string;max_size:number}
export interface DownloadDescriptor {url:string;expires_at:string;name:string;mime:string}
export interface CostSummary { totals: {currency: string; amount: string; source: string}[]; input_tokens: number; output_tokens: number; unknown_count: number; request_count: number; coverage: number; as_of: string; reserved_hold_usd?: string | null; reserved_unknown_count?: number }
export interface CostPoint { date: string; currency: string; amount: string; source: string; input_tokens: number; output_tokens: number }
export interface CostBreakdown { key: string; label: string; currency: string; amount: string; request_count: number; unknown_count: number }
export interface Budget { monthly_limit_usd: string | null; task_limit_usd: string | null; used_usd: string; version: number; unknown_count?: number; category_limits?: Record<string, {max_total_tokens?: number; max_model_calls?: number; max_tool_steps?: number; max_runtime_ms?: number}>; reserved_hold_usd?: string | null; reserved_unknown_count?: number; explanation?: string }
export interface Frame { frame_id: string; image_base64: string; width: number; height: number; captured_at: string; viewport_version: string; tab_id: string | null }
export interface List<T> { items: T[]; next_cursor?: string | null }
export interface EventBatch { items: {event_id: string; stream_seq: string; type: string}[]; cursor: string }

export interface ToolStep {id:string;run_id:string;tool:string;title:string;status:'running'|'succeeded'|'failed'|'cancelled'|'result_unknown';started_at:string|null;completed_at:string|null;error_code:'tool_failed'|'invalid_arguments'|'not_authorized'|'cancelled'|'result_unknown'|null;created_at:string;version:number}

export interface EvidenceReference {kind:'artifact'|'step'|'checkpoint';id:string}
export interface DeliveryRecord {id:string;run_id:string;status:'pending'|'accepted'|'rejected'|'needs_input';deliverables:string[];artifact_ids:string[];version:number}
export interface TaskEvidence {task:AgentTask;run:Run|null;delivery:DeliveryRecord|null;deliverables:string[];checkpoint:{id:string;created_at:string}|null;steps:ToolStep[];artifacts:Artifact[]}
export interface ReviewInput {run_id:string;verdict:'accept'|'reject'|'needs_input';summary:string;checks:{deliverable_index:number;passed:boolean;evidence_refs:EvidenceReference[]}[]}
