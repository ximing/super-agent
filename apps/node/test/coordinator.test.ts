import test from 'node:test';
import assert from 'node:assert/strict';
import type { TaskEvidence } from '@super-agent/protocol';
import type { RuntimeAdapter, RuntimeContext } from '@super-agent/tool-broker';
import { readReviewArtifact, reviewDelivery } from '../src/coordinator.js';
import { BudgetGuard } from '../src/budget-guard.js';
import { DEFAULT_BUDGET_LIMITS } from '@super-agent/protocol';

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

test('review tool calls stop on the call after the tool limit and do not execute it', async () => {
  const guard = new BudgetGuard({ ...DEFAULT_BUDGET_LIMITS.review, max_tool_steps: 12 });
  await reviewDelivery({ evidence: fixture(), cwd: '/test', signal: new AbortController().signal, assertActive: () => {}, readArtifact: async () => 'VERIFIED',
    budget: { beforeModelCall: () => guard.beforeModelCall(), beforeToolCall: () => guard.beforeToolCall() },
    adapter: adapter(async context => {
      for (let count = 0; count < 12; count += 1) await context.executeTool('delivery_evidence', {});
      await assert.rejects(context.executeTool('delivery_evidence', {}), /tool_step_limit/);
    }) });
  assert.equal(guard.tools, 12);
});

test('a screenshot is needs_input until a vision-capable engine actually receives the bytes', async () => {
  const evidence = fixture();
  const png = Buffer.from('png-bytes');
  evidence.artifacts[0] = { id: 'shot-1', task_id: 'task-1', run_id: 'run-1', name: 'screen.png', mime: 'image/png', size: png.length, status: 'ready', created_at: '', integrity: 'server_snapshot', evidence_kind: 'screenshot', provenance: 'tool_broker', fresh: true, source_url: 'https://a.example/item' };
  evidence.delivery!.artifact_ids = ['shot-1'];
  const review = { verdict: 'accept', summary: '看起来对。', checks: [{ deliverable_index: 0, passed: true, evidence_refs: [{ kind: 'artifact', id: 'shot-1' }] }] };
  await reviewDelivery({ evidence, cwd: '/test', signal: new AbortController().signal, assertActive: () => {}, readArtifact: async () => { throw new Error('must not download'); },
    adapter: adapter(async context => {
      const seen = await context.executeTool('delivery_artifact_read', { id: 'shot-1' });
      assert.equal((seen as { visual: string }).visual, 'unsupported');
      await assert.rejects(context.executeTool('delivery_review', review), /review_requires_visual_read/);
      await context.executeTool('delivery_review', { verdict: 'needs_input', summary: '引擎不能看图。', checks: [] });
    }) });
  let shown = false;
  await reviewDelivery({ evidence, cwd: '/test', signal: new AbortController().signal, assertActive: () => {}, readArtifact: async () => png.toString('base64'),
    adapter: { ...adapter(async context => {
      await context.executeTool('delivery_artifact_read', { id: 'shot-1' });
      assert.equal(context.images?.[0]?.artifact_id, 'shot-1');
      assert.equal(context.images?.[0]?.data_base64, png.toString('base64'));
      shown = true;
      await context.executeTool('delivery_review', review);
    }), supportsVision: () => true, stop: async () => {}, steer: async () => {} } });
  assert.equal(shown, true);
});

test('a memory conclusion needs the body, not only the retrieval id', async () => {
  const evidence = fixture();
  evidence.artifacts[0] = { id: 'mem-1', task_id: 'task-1', run_id: 'run-1', name: 'memory.json', mime: 'application/json', size: 2, status: 'ready', created_at: '', integrity: 'server_snapshot', evidence_kind: 'memory_retrieval', provenance: 'tool_broker', fresh: true };
  evidence.delivery!.artifact_ids = ['mem-1'];
  const review = { verdict: 'accept', summary: '正文已核对。', checks: [{ deliverable_index: 0, passed: true, evidence_refs: [{ kind: 'artifact', id: 'mem-1' }] }] };
  await reviewDelivery({ evidence, cwd: '/test', signal: new AbortController().signal, assertActive: () => {}, readArtifact: async () => '{"id":"mem-1"}', readMemory: async () => '正文：价格是 9',
    adapter: adapter(async context => {
      await context.executeTool('delivery_artifact_read', { id: 'mem-1' });
      await assert.rejects(context.executeTool('delivery_review', review), /review_requires_memory_body/);
      const body = await context.executeTool('memory_body_read', { id: 'mem-1' });
      assert.match((body as { content: string }).content, /价格是 9/);
      await context.executeTool('delivery_review', review);
    }) });
});

test('accept cannot cite an observation artifact the reviewer did not read', async () => {
  const evidence = fixture();
  evidence.steps = [{ id: 'step-1', run_id: 'run-1', title: '读取网页', tool: 'browser_snapshot', status: 'succeeded', started_at: '', completed_at: '', error_code: null, created_at: '', version: 1 }];
  evidence.artifacts.push({ id: 'page-1', task_id: 'task-1', run_id: 'run-1', name: 'page.json', mime: 'application/json', size: 2, status: 'ready', created_at: '', integrity: 'server_snapshot', evidence_kind: 'page_capture', provenance: 'tool_broker', fresh: true });
  evidence.delivery!.artifact_ids = ['artifact-1', 'page-1'];
  await reviewDelivery({ evidence, cwd: '/test', signal: new AbortController().signal, assertActive: () => {}, readArtifact: async () => 'PAGE',
    adapter: adapter(async context => {
      await context.executeTool('delivery_artifact_read', { id: 'artifact-1' });
      await assert.rejects(context.executeTool('delivery_review', { verdict: 'accept', summary: '只读了报告。', checks: [{ deliverable_index: 0, passed: true, evidence_refs: [{ kind: 'artifact', id: 'artifact-1' }, { kind: 'artifact', id: 'page-1' }] }] }), /read_observation/);
      await context.executeTool('delivery_artifact_read', { id: 'page-1' });
      await context.executeTool('delivery_review', { verdict: 'accept', summary: '已读取页面证据。', checks: [{ deliverable_index: 0, passed: true, evidence_refs: [{ kind: 'artifact', id: 'page-1' }] }] });
    }) });
});
