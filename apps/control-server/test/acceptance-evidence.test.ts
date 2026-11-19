import test from 'node:test';
import assert from 'node:assert/strict';
import { deviceEvidenceSatisfied, evidenceBelongs, isIndependentObservation } from '../src/acceptance-evidence.js';

const task = { id: 'task' }, run = { id: 'run' };
const delivery = { artifact_ids: ['page'] };
const page = { id: 'page', task_id: 'task', run_id: 'run', status: 'ready', integrity: 'server_snapshot', provenance: 'tool_broker', evidence_kind: 'page_capture' };

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
});
