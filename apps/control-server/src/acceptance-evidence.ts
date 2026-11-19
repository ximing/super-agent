import type { Doc } from './store.js';

const KINDS = new Set(['page_capture', 'screenshot', 'memory_retrieval']);

export function observationTools(steps: Doc[]): boolean {
  return steps.some(step => step.status === 'succeeded' && /^(browser_|memory_)/.test(String(step.tool ?? '')));
}

/** A frozen tool-broker observation. Tool success, a worker report, or a file merely existing is not this. */
export function isIndependentObservation(artifact: Doc | null | undefined): boolean {
  if (!artifact || artifact.provenance !== 'tool_broker' || !KINDS.has(artifact.evidence_kind) || artifact.status !== 'ready' || artifact.integrity !== 'server_snapshot') return false;
  if (artifact.source_uncertain === true || artifact.fresh === false || artifact.stale === true) return false;
  if ((artifact.evidence_kind === 'page_capture' || artifact.evidence_kind === 'screenshot') && (typeof artifact.source_url !== 'string' || artifact.source_url.length === 0)) return false;
  return true;
}

/** Page and screenshot evidence without a real source URL cannot be presented as fresh. */
export function evidenceRecord(kind: string, body: Doc): Doc {
  const capturedAt = typeof body.captured_at === 'string' ? body.captured_at.slice(0, 40) : null;
  const stepId = typeof body.step_id === 'string' ? body.step_id.slice(0, 80) : null;
  const page = kind === 'page_capture' || kind === 'screenshot';
  const hasUrl = typeof body.source_url === 'string' && body.source_url.length > 0;
  if (page && (body.source_uncertain === true || !hasUrl)) return { evidence_kind: kind, provenance: 'tool_broker', captured_at: capturedAt, source_url: null, source_uncertain: true, step_id: stepId, fresh: false, stale: true };
  return { evidence_kind: kind, provenance: 'tool_broker', captured_at: capturedAt, source_url: hasUrl ? String(body.source_url).slice(0, 2000) : null, step_id: stepId, fresh: body.fresh !== false, stale: body.fresh === false || body.stale === true };
}

export function evidenceBelongs(artifact: Doc, task: Doc, run: Doc, delivery: Doc | null): boolean {
  return artifact.task_id === task.id && artifact.run_id === run.id && artifact.status === 'ready' && (!delivery || (delivery.artifact_ids ?? []).includes(artifact.id));
}

export function deviceEvidenceSatisfied(steps: Doc[], referenced: Doc[]): boolean {
  if (observationTools(steps)) return referenced.some(isIndependentObservation);
  return referenced.some(artifact => artifact.status === 'ready');
}
