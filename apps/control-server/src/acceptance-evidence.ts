import type { Doc } from './store.js';

const KINDS = new Set(['page_capture', 'screenshot', 'memory_retrieval']);

export function observationTools(steps: Doc[]): boolean {
  return steps.some(step => step.status === 'succeeded' && /^(browser_|memory_)/.test(String(step.tool ?? '')));
}

/** A frozen tool-broker observation. Tool success, a worker report, or a file merely existing is not this. */
export function isIndependentObservation(artifact: Doc | null | undefined): boolean {
  return !!artifact && artifact.provenance === 'tool_broker' && KINDS.has(artifact.evidence_kind) && artifact.status === 'ready' && artifact.integrity === 'server_snapshot' && artifact.fresh !== false && artifact.stale !== true;
}

export function evidenceBelongs(artifact: Doc, task: Doc, run: Doc, delivery: Doc | null): boolean {
  return artifact.task_id === task.id && artifact.run_id === run.id && artifact.status === 'ready' && (!delivery || (delivery.artifact_ids ?? []).includes(artifact.id));
}

export function deviceEvidenceSatisfied(steps: Doc[], referenced: Doc[]): boolean {
  if (observationTools(steps)) return referenced.some(isIndependentObservation);
  return referenced.some(artifact => artifact.status === 'ready');
}
