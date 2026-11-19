import test from 'node:test';
import assert from 'node:assert/strict';
import type { TaskEvidence } from '@super-agent/protocol';
import type { RuntimeAdapter, RuntimeContext } from '@super-agent/tool-broker';
import { readReviewArtifact, reviewDelivery } from '../src/coordinator.js';

function fixture(): TaskEvidence {
  return {
    task: { id: 'task-1', title: 'Report', goal: 'Produce a report containing the verified marker.', status: 'awaiting_review', reason_code: null, engine: 'grok', model_id: 'test-model', device_id: 'device-1', current_run_id: 'run-1', created_at: '', updated_at: '', version: 8 },
    run: { id: 'run-1', task_id: 'task-1', state: 'succeeded', engine: 'grok', device_id: 'device-1', model_id: 'test-model', lease_epoch: '1', summary: 'Worker claims success', created_at: '' },
    delivery: { id: 'delivery-1', task_id: 'task-1', run_id: 'run-1', status: 'pending', deliverables: ['Report contains the verified marker'], checkpoint_id: 'checkpoint-1', artifact_ids: ['artifact-1'], created_at: '', version: 1 },
    deliverables: ['Report contains the verified marker'], result_text: 'Worker claims success', checkpoint: { id: 'checkpoint-1', created_at: '' }, steps: [], reviews: [],
    artifacts: [{ id: 'artifact-1', task_id: 'task-1', run_id: 'run-1', name: 'report.md', mime: 'text/markdown', size: 8, status: 'ready', created_at: '', integrity: 'server_snapshot' }],
  };
}
function adapter(execute: (context: RuntimeContext) => Promise<void>, stopped: () => void = () => {}): RuntimeAdapter {
  return { execute: async context => { await execute(context); return { text: 'finished' }; }, stop: async () => stopped(), steer: async () => {} };
}

test('a verifier cannot approve metadata or invoke worker tools; it must read actual delivery evidence', async () => {
  let reads = 0, stops = 0;
  const result = await reviewDelivery({ evidence: fixture(), cwd: '/test', signal: new AbortController().signal, assertActive: () => {}, readArtifact: async () => { reads++; return 'VERIFIED'; },
    adapter: adapter(async context => {
      assert.deepEqual(context.tools.map(tool => tool.name), ['delivery_evidence', 'delivery_artifact_read', 'delivery_review']);
      await assert.rejects(context.executeTool('files_write', { path: 'other', content: 'not allowed' }), /not_allowed/);
      const review = { verdict: 'accept', summary: 'Checked the report contents.', checks: [{ deliverable_index: 0, passed: true, evidence_refs: [{ kind: 'artifact', id: 'artifact-1' }] }] };
      await assert.rejects(context.executeTool('delivery_review', review), /independently_read/);
      await assert.rejects(context.executeTool('delivery_artifact_read', { id: 'other-tenant-artifact' }), /not_found/);
      await context.executeTool('delivery_artifact_read', { id: 'artifact-1' });
      await context.executeTool('delivery_review', review);
      await assert.rejects(context.executeTool('delivery_review', review), /already_submitted/);
    }, () => stops++),
  });
  assert.equal(result.review.verdict, 'accept'); assert.equal(reads, 1); assert.equal(stops, 1);
});

test('a completed model turn is not approval and a stale delivery never starts a verifier', async () => {
  let calls = 0;
  const options = { evidence: fixture(), cwd: '/test', signal: new AbortController().signal, assertActive: () => {}, readArtifact: async () => 'VERIFIED', adapter: adapter(async () => { calls++; }) };
  assert.equal((await reviewDelivery(options)).review.verdict, 'needs_input');
  options.evidence.task.current_run_id = 'new-run';
  await assert.rejects(reviewDelivery(options), /stale/); assert.equal(calls, 1);
});

test('signed evidence reads carry no product authorization, reject binary and enforce exact bounded length', async () => {
  const artifact = fixture().artifacts[0]!;
  const signal = new AbortController().signal;
  const fetcher: typeof fetch = async (_url, init) => {
    assert.equal(new Headers(init?.headers).get('authorization'), null);
    assert.equal(init?.redirect, 'error'); assert.equal(init?.credentials, 'omit');
    return new Response('VERIFIED');
  };
  assert.equal(await readReviewArtifact(artifact, 'https://objects.example/signed', signal, fetcher), 'VERIFIED');
  await assert.rejects(readReviewArtifact({ ...artifact, size: 9 }, 'https://objects.example/signed', signal, fetcher), /size_mismatch/);
  await assert.rejects(readReviewArtifact({ ...artifact, mime: 'application/pdf' }, 'https://objects.example/signed', signal, fetcher), /requires_human/);
  await assert.rejects(readReviewArtifact({ ...artifact, integrity: 'legacy_unverified' }, 'https://objects.example/signed', signal, fetcher), /requires_human/);
  await assert.rejects(readReviewArtifact(artifact, 'http://objects.example/signed', signal, fetcher), /url_invalid/);
});
