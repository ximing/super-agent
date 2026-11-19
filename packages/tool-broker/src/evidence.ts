import { createHash } from 'node:crypto';

export type EvidenceKind = 'page_capture' | 'screenshot' | 'memory_retrieval';
const SECRET = /((?:password|passwd|pwd|cookie|set-cookie|authorization|api[_-]?key|access[_-]?token|refresh[_-]?token|secret)\s*["']?\s*[:=]\s*["']?)[^\r\n]*/gi;
const BEARER = /\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi;

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
  const text = value.replace(SECRET, (_match, prefix: string) => { redacted = true; return `${prefix}[redacted]`; }).replace(BEARER, () => { redacted = true; return 'Bearer [redacted]'; });
  return { text, redacted };
}

function digest(value: string | Buffer): string { return createHash('sha256').update(value).digest('hex'); }

export function pageEvidence(input: { url: unknown; capturedAt: string; runId: string; stepId: string; body: unknown; maxBytes?: number }): Record<string, unknown> {
  const raw = typeof input.body === 'string' ? input.body : JSON.stringify(input.body ?? '');
  const max = input.maxBytes ?? 100_000;
  const original = Buffer.byteLength(raw);
  const truncated = original > max;
  const slice = truncated ? Buffer.from(raw).subarray(0, max).toString('utf8') : raw;
  const cleaned = redactEvidenceText(slice);
  return {
    evidence_kind: 'page_capture', provenance: 'tool_broker', captured_at: input.capturedAt, source_url: safeEvidenceUrl(input.url),
    run_id: input.runId, step_id: input.stepId, body: cleaned.text, truncated, original_bytes: original, stored_bytes: Buffer.byteLength(cleaned.text),
    sha256: digest(cleaned.text), redacted: cleaned.redacted, viewer_required: false,
  };
}

export function screenshotEvidence(input: { url: unknown; capturedAt: string; runId: string; stepId: string; bytes: Buffer; width: number; height: number; imageArtifactId?: string | null }): Record<string, unknown> {
  return {
    evidence_kind: 'screenshot', provenance: 'tool_broker', captured_at: input.capturedAt, source_url: safeEvidenceUrl(input.url),
    run_id: input.runId, step_id: input.stepId, sha256: digest(input.bytes), bytes: input.bytes.length, width: input.width, height: input.height,
    image_artifact_id: input.imageArtifactId ?? null, viewer_required: false,
    note: '截图在工具执行时保存，不依赖有人正在查看画面。画面像素需要人工打开图片产物；此清单只证明捕获时间、来源和完整性。',
  };
}

export function memoryRetrievalEvidence(input: { capturedAt: string; runId: string; stepId: string; query: string; scope: unknown; hits: unknown[] }): Record<string, unknown> {
  const hits = input.hits.slice(0, 20).map(hit => {
    const item = hit && typeof hit === 'object' ? hit as Record<string, unknown> : {};
    return { id: item.id ?? null, version: item.version ?? null, project: item.recall_project ?? item.project ?? null, site: item.site ?? null, status: item.status ?? null, title: typeof item.title === 'string' ? item.title.slice(0, 160) : null };
  });
  return { evidence_kind: 'memory_retrieval', provenance: 'tool_broker', captured_at: input.capturedAt, run_id: input.runId, step_id: input.stepId, query: input.query.slice(0, 500), scope: input.scope ?? null, hits, viewer_required: false };
}
