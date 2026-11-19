import { createHash } from 'node:crypto';

export type EvidenceKind = 'page_capture' | 'screenshot' | 'memory_retrieval';
const SECRET = /((?:password|passwd|pwd|cookie|set-cookie|authorization|api[_-]?key|access[_-]?token|refresh[_-]?token|secret)\s*["']?\s*[:=]\s*["']?)[^\r\n]*/gi;
const BEARER = /\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi;
const URL_TEXT = /https?:\/\/[^\s"'<>\\]+/gi;
const SENSITIVE_QUERY = /^(?:code|token|access_token|refresh_token|id_token|ticket|password|passwd|secret|auth|session|jwt|bearer|api_key|apikey)$/i;
const DENY_STATUS = new Set([401, 403, 404, 409, 412, 422]);
const DENY_CODE = new Set(['not_found', 'recall_credentials_invalid', 'recall_binding_unavailable', 'memory_not_configured', 'recall_account_change_requires_review']);

/** Authorization and scope failures must not fall back to cached memory text. */
export function memoryFailureClass(error: unknown): 'deny' | 'offline' {
  const status = error && typeof error === 'object' && 'status' in error ? Number((error as { status: unknown }).status) : NaN;
  const code = error && typeof error === 'object' && 'code' in error ? String((error as { code: unknown }).code) : '';
  if (DENY_STATUS.has(status) || DENY_CODE.has(code)) return 'deny';
  if (status === 503 && /credential|binding|not_configured|invalid|not_found/.test(code)) return 'deny';
  return 'offline';
}

export function sanitizeEvidenceUrl(value: string): { url: string; changed: boolean } {
  const trimmed = value.replace(/[),.;]+$/g, '');
  let parsed: URL;
  try { parsed = new URL(trimmed); } catch { return { url: value, changed: false }; }
  if (!['https:', 'http:'].includes(parsed.protocol)) return { url: value, changed: false };
  let changed = false;
  if (parsed.username || parsed.password) { parsed.username = ''; parsed.password = ''; changed = true; }
  if (parsed.hash) { parsed.hash = ''; changed = true; }
  const kept = new URLSearchParams();
  for (const [key, item] of parsed.searchParams) {
    if (SENSITIVE_QUERY.test(key)) changed = true;
    else kept.append(key, item);
  }
  const next = kept.toString();
  if (parsed.search !== (next ? `?${next}` : '')) { parsed.search = next; changed = true; }
  const suffix = value.slice(trimmed.length);
  return { url: `${parsed.toString()}${suffix}`, changed };
}

export function safeEvidenceUrl(value: unknown): string | null {
  if (typeof value !== 'string' || !value) return null;
  try {
    const url = new URL(value);
    if (!['https:', 'http:'].includes(url.protocol)) return null;
    url.username = ''; url.password = ''; url.search = ''; url.hash = '';
    return url.toString();
  } catch { return null; }
}

export function redactEvidenceText(value: string): { text: string; redacted: boolean } {
  let redacted = false;
  const withoutUrls = value.replace(URL_TEXT, match => { const clean = sanitizeEvidenceUrl(match); redacted ||= clean.changed; return clean.url; });
  const text = withoutUrls.replace(SECRET, (_match, prefix: string) => { redacted = true; return `${prefix}[redacted]`; }).replace(BEARER, () => { redacted = true; return 'Bearer [redacted]'; });
  return { text, redacted };
}

function redactStructured(value: unknown): { value: unknown; redacted: boolean } {
  if (typeof value === 'string') { const cleaned = redactEvidenceText(value); return { value: cleaned.text, redacted: cleaned.redacted }; }
  if (Array.isArray(value)) {
    let redacted = false; const items = value.map(item => { const next = redactStructured(item); redacted ||= next.redacted; return next.value; });
    return { value: items, redacted };
  }
  if (value && typeof value === 'object') {
    let redacted = false; const record: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) { const next = redactStructured(item); record[key] = next.value; redacted ||= next.redacted; }
    return { value: record, redacted };
  }
  return { value, redacted: false };
}

function digest(value: string | Buffer): string { return createHash('sha256').update(value).digest('hex'); }
const SOURCE_UNCERTAIN_REASON = '页面在捕获期间发生跳转，不能确定正文对应的网址';
const UNCONFIRMED_SOURCE_REASON = '未能确认当前页面网址';
function sourceBinding(url: unknown, uncertain: boolean, reason?: string): { source_url: string | null; source_uncertain: boolean; source_uncertain_reason?: string; fresh: boolean; stale: boolean } {
  const source_url = uncertain ? null : safeEvidenceUrl(url);
  if (uncertain || !source_url) return { source_url: null, source_uncertain: true, source_uncertain_reason: reason || (uncertain ? SOURCE_UNCERTAIN_REASON : UNCONFIRMED_SOURCE_REASON), fresh: false, stale: true };
  return { source_url, source_uncertain: false, fresh: true, stale: false };
}
function projectOfHit(item: Record<string, unknown>): unknown {
  const governance = item.governance && typeof item.governance === 'object' ? item.governance as Record<string, unknown> : null;
  const applicability = governance?.applicability && typeof governance.applicability === 'object' ? governance.applicability as Record<string, unknown> : null;
  return applicability?.project ?? item.recall_project ?? item.project ?? null;
}

export function pageEvidence(input: { url: unknown; capturedAt: string; runId: string; stepId: string; body: unknown; maxBytes?: number; sourceUncertain?: boolean; sourceUncertainReason?: string }): Record<string, unknown> {
  const structured = redactStructured(input.body);
  const raw = typeof structured.value === 'string' ? structured.value : JSON.stringify(structured.value ?? '');
  const cleaned = redactEvidenceText(raw);
  const max = input.maxBytes ?? 100_000;
  const original = Buffer.byteLength(cleaned.text);
  const truncated = original > max;
  const body = truncated ? Buffer.from(cleaned.text).subarray(0, max).toString('utf8') : cleaned.text;
  const binding = sourceBinding(input.url, input.sourceUncertain === true, input.sourceUncertainReason);
  return {
    evidence_kind: 'page_capture', provenance: 'tool_broker', captured_at: input.capturedAt, source_url: binding.source_url,
    run_id: input.runId, step_id: input.stepId, body, truncated, original_bytes: original, stored_bytes: Buffer.byteLength(body),
    sha256: digest(body), redacted: structured.redacted || cleaned.redacted || truncated, fresh: binding.fresh, stale: binding.stale,
    source_uncertain: binding.source_uncertain, ...(binding.source_uncertain_reason ? { source_uncertain_reason: binding.source_uncertain_reason } : {}), viewer_required: false,
  };
}

export function screenshotEvidence(input: { url: unknown; capturedAt: string; runId: string; stepId: string; bytes: Buffer; width: number; height: number; imageArtifactId?: string | null; sourceUncertain?: boolean; sourceUncertainReason?: string }): Record<string, unknown> {
  const binding = sourceBinding(input.url, input.sourceUncertain === true, input.sourceUncertainReason);
  return {
    evidence_kind: 'screenshot', provenance: 'tool_broker', captured_at: input.capturedAt, source_url: binding.source_url,
    run_id: input.runId, step_id: input.stepId, sha256: digest(input.bytes), bytes: input.bytes.length, width: input.width, height: input.height,
    image_artifact_id: input.imageArtifactId ?? null, viewer_required: false,
    fresh: binding.fresh, stale: binding.stale, source_uncertain: binding.source_uncertain, ...(binding.source_uncertain_reason ? { source_uncertain_reason: binding.source_uncertain_reason } : {}),
    note: '截图在工具执行时保存，不依赖有人正在查看画面。画面像素需要人工打开图片产物；此清单只证明捕获时间、来源和完整性。',
  };
}

type MemoryEnvelope = { hits?: unknown[]; items?: unknown[]; fresh?: boolean; stale?: boolean; stale_reason?: string; observed_at?: string; retrieved_at?: string; cache_read_at?: string; generated_at?: string };
function envelopeStale(source: { stale?: unknown; fresh?: unknown } | null): boolean {
  return !!source && (source.stale === true || source.fresh === false);
}
function textOrNull(value: unknown): string | null { return typeof value === 'string' && value ? value : null; }

export function memoryRetrievalEvidence(input: { generatedAt: string; runId: string; stepId: string; query: string; scope: unknown; hits: unknown[] | MemoryEnvelope; fresh?: boolean; stale?: boolean; stale_reason?: string; observed_at?: string; retrieved_at?: string; generated_at?: string }): Record<string, unknown> {
  let envelope: MemoryEnvelope | null = null;
  let rawHits: unknown[] = [];
  if (Array.isArray(input.hits)) rawHits = input.hits;
  else { envelope = input.hits; rawHits = Array.isArray(envelope.items) ? envelope.items : Array.isArray(envelope.hits) ? envelope.hits : []; }
  const hits = rawHits.slice(0, 20).map(hit => {
    const item = hit && typeof hit === 'object' ? hit as Record<string, unknown> : {};
    const stale = item.stale === true || item.fresh === false;
    return {
      id: item.id ?? null, version: item.version ?? null, project: projectOfHit(item),
      site: item.site ?? null, status: item.status ?? null, title: typeof item.title === 'string' ? item.title.slice(0, 160) : null,
      fresh: !stale, stale, stale_reason: stale ? item.stale_reason ?? 'stale' : null, observed_at: typeof item.observed_at === 'string' ? item.observed_at : null,
    };
  });
  const stale = envelopeStale(envelope) || envelopeStale(input) || hits.some(hit => hit.stale === true);
  const observedAt = textOrNull(envelope?.observed_at) ?? textOrNull(input.observed_at);
  const retrievedAt = textOrNull(envelope?.retrieved_at) ?? textOrNull(envelope?.cache_read_at) ?? textOrNull(input.retrieved_at);
  const generatedAt = textOrNull(envelope?.generated_at) ?? textOrNull(input.generated_at) ?? (input.generatedAt || new Date().toISOString());
  const staleReason = !stale ? null : textOrNull(envelope?.stale_reason) ?? textOrNull(input.stale_reason) ?? hits.find(hit => hit.stale)?.stale_reason ?? 'stale';
  return {
    evidence_kind: 'memory_retrieval', provenance: 'tool_broker', generated_at: generatedAt, captured_at: generatedAt, observed_at: observedAt, retrieved_at: retrievedAt,
    run_id: input.runId, step_id: input.stepId, query: input.query.slice(0, 500), scope: input.scope ?? null, hits,
    fresh: !stale, stale, stale_reason: staleReason, acceptable_as_current: !stale, viewer_required: false,
  };
}
