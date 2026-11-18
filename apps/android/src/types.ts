export type Engine = 'codex' | 'grok';
export interface User { id: string; email: string; name: string; tenant_id: string }
export interface Session { access_token: string; refresh_token: string; expires_in: number; user: User }
export interface AuthConfig { mode: 'development' | 'oidc'; issuer?: string; client_id?: string; authorization_endpoint?: string; token_endpoint?: string; redirect_uri?: string }
export interface EngineCapability { engine: Engine; ready: boolean; models: string[]; reason?: string }
export interface Device { id: string; name: string; status: string; last_seen_at: string | null; version: number; capabilities: { generation: number; engines: EngineCapability[]; tools: string[]; slots: { browser: number; worker: number } } }
export interface ExecutionSettings { default_engine: Engine; default_device_id: string | null; assistant_device_id: string | null; version: number }
export interface AgentTask { id: string; title: string; goal: string; status: string; reason_code: string | null; engine: Engine; model_id: string | null; device_id: string | null; device_name?: string | null; current_run_id: string | null; created_at: string; updated_at: string; version: number }
export interface Run { id: string; task_id: string; state: string; engine: Engine; device_id: string; model_id: string; lease_epoch: string; summary: string; result_text?: string | null; created_at: string }
export interface Message { id: string; role: string; content: string; task_id: string | null; created_at: string }
export interface Question { id: string; task_id: string; run_id: string; text: string; options: string[]; status: string; version: number; created_at: string }
export interface Memory { id: string; title: string; content: string; type: string; site: string | null; status: string; version: number; updated_at: string }
export interface MemorySettings { configured: boolean; url?: string; version?: number }
export interface Schedule { id:string; title:string; goal:string; engine:Engine; device_id:string; interval_minutes:number; enabled:boolean; next_due_at:string|null; version:number }
export interface Artifact { id:string; name:string; mime:string; size:number; task_id:string|null; run_id:string|null; status:string; created_at:string }
export interface UploadDescriptor {artifact_id:string;upload_url:string;upload_headers:Record<string,string>;expires_at:string;max_size:number}
export interface DownloadDescriptor {url:string;expires_at:string;name:string;mime:string}
export interface CostSummary { totals: {currency: string; amount: string; source: string}[]; input_tokens: number; output_tokens: number; unknown_count: number; request_count: number; coverage: number; as_of: string }
export interface CostPoint { date: string; currency: string; amount: string; source: string; input_tokens: number; output_tokens: number }
export interface CostBreakdown { key: string; label: string; currency: string; amount: string; request_count: number; unknown_count: number }
export interface Budget { monthly_limit_usd: string | null; task_limit_usd: string | null; used_usd: string; version: number }
export interface Frame { frame_id: string; image_base64: string; width: number; height: number; captured_at: string; viewport_version: string; tab_id: string | null }
export interface List<T> { items: T[]; next_cursor?: string | null }
export interface EventBatch { items: {event_id: string; stream_seq: string; type: string}[]; cursor: string }
