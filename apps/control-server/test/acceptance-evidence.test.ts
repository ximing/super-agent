import test from 'node:test';
import assert from 'node:assert/strict';
import { deviceEvidenceSatisfied, evidenceBelongs, evidenceRecord, isIndependentObservation } from '../src/acceptance-evidence.js';
import { publicArtifact } from '../src/team.js';

const task = { id: 'task' }, run = { id: 'run' };
const delivery = { artifact_ids: ['page'] };
const page = { id: 'page', task_id: 'task', run_id: 'run', status: 'ready', integrity: 'server_snapshot', provenance: 'tool_broker', evidence_kind: 'page_capture', source_url: 'https://example.com/report' };

test('independent evidence must belong to this delivery and tool success is not enough', () => {
  assert.equal(isIndependentObservation(page), true);
  assert.equal(isIndependentObservation({ ...page, provenance: null }), false);
  assert.equal(isIndependentObservation({ ...page, integrity: 'legacy_unverified' }), false);
  assert.equal(evidenceBelongs(page, task, run, delivery), true);
  assert.equal(evidenceBelongs({ ...page, run_id: 'old-run' }, task, run, delivery), false);
  assert.equal(evidenceBelongs({ ...page, task_id: 'other' }, task, run, delivery), false);
  assert.equal(deviceEvidenceSatisfied([{ tool: 'browser_snapshot', status: 'succeeded' }], [{ ...page, evidence_kind: null }]), false);
  assert.equal(deviceEvidenceSatisfied([{ tool: 'browser_snapshot', status: 'succeeded' }], [page]), true);
  assert.equal(deviceEvidenceSatisfied([{ tool: 'files_read', status: 'succeeded' }], [{ id: 'report', status: 'ready' }]), true);
  assert.equal(deviceEvidenceSatisfied([], []), false);
  const sourceless = evidenceRecord('page_capture', { fresh: true, source_url: '', source_uncertain: false });
  assert.equal(sourceless.fresh, false);
  assert.equal(sourceless.stale, true);
  assert.equal(sourceless.source_uncertain, true);
  assert.equal(sourceless.source_url, null);
  const uncertain = { ...page, ...evidenceRecord('screenshot', { fresh: true, source_url: 'https://example.com/shot', source_uncertain: true }), status: 'ready', integrity: 'server_snapshot', provenance: 'tool_broker' };
  assert.equal(isIndependentObservation(uncertain), false);
  assert.equal(isIndependentObservation({ ...page, fresh: false }), false);
  assert.equal(isIndependentObservation({ ...page, stale: true }), false);
  assert.equal(isIndependentObservation({ ...page, source_url: null }), false);
  assert.equal(isIndependentObservation({ ...page, evidence_kind: 'memory_retrieval', source_url: null }), true);
  assert.equal(deviceEvidenceSatisfied([{ tool: 'browser_snapshot', status: 'succeeded' }], [uncertain]), false);
  assert.equal(deviceEvidenceSatisfied([{ tool: 'browser_snapshot', status: 'succeeded' }], [{ ...page, source_url: '' }]), false);
  const shown = publicArtifact({ ...page, ...sourceless, evidence_kind: 'page_capture' });
  assert.equal(shown.source_uncertain, true);
  assert.equal(shown.fresh, false);
  assert.equal(shown.stale, true);
  assert.equal(shown.source_url, null);
});
