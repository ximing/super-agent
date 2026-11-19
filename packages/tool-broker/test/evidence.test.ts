import test from 'node:test';
import assert from 'node:assert/strict';
import { memoryRetrievalEvidence, pageEvidence, redactEvidenceText, screenshotEvidence } from '../src/evidence.js';

test('page evidence comes from the tool capture and drops secrets, queries and excess text', () => {
  const captured = pageEvidence({ url: 'https://user:secret@internal.example.com/path?token=abc#session', capturedAt: '2026-11-19T01:02:03.000Z', runId: 'run', stepId: 'step', body: `欢迎\npassword: hunter2\nAuthorization: Bearer very-secret\n${'正文'.repeat(100_000)}`, maxBytes: 200 });
  assert.equal(captured.evidence_kind, 'page_capture');
  assert.equal(captured.provenance, 'tool_broker');
  assert.equal(captured.captured_at, '2026-11-19T01:02:03.000Z');
  assert.equal(captured.source_url, 'https://internal.example.com/path');
  assert.equal(captured.viewer_required, false);
  assert.equal(captured.truncated, true);
  assert.equal(JSON.stringify(captured).includes('hunter2'), false);
  assert.equal(JSON.stringify(captured).includes('very-secret'), false);
  const nested = pageEvidence({ url: 'https://example.com/start', capturedAt: '2026-11-19T01:02:03.000Z', runId: 'run', stepId: 'step', body: { url: 'https://login.example/callback?code=synthetic-auth-code&next=/home#token=synthetic-fragment', title: '业务标题' } });
  assert.equal(JSON.stringify(nested).includes('synthetic-auth-code'), false);
  assert.equal(JSON.stringify(nested).includes('synthetic-fragment'), false);
  assert.equal(JSON.stringify(nested).includes('业务标题'), true);
  assert.equal(nested.redacted, true);
  assert.equal(redactEvidenceText('cookie: session=abc').redacted, true);
});

test('screenshot evidence does not require a live viewer and memory evidence keeps references only', () => {
  const shot = screenshotEvidence({ url: 'https://example.com/a?x=1', capturedAt: '2026-11-19T01:02:03.000Z', runId: 'run', stepId: 'step', bytes: Buffer.from('jpeg'), width: 10, height: 12 });
  assert.equal(shot.viewer_required, false);
  assert.equal(shot.captured_at, '2026-11-19T01:02:03.000Z');
  assert.equal(JSON.stringify(shot).includes('jpeg'), false);
  const memory = memoryRetrievalEvidence({ generatedAt: '2026-11-19T01:02:03.000Z', runId: 'run', stepId: 'step', query: '入口', scope: { project: 'alpha', sites: ['example.com'] }, hits: [{ id: 'm1', version: 3, title: '入口', site: 'example.com', status: 'verified', content: '不应进入证据的公司全文' }] });
  assert.equal(JSON.stringify(memory).includes('不应进入证据'), false);
  assert.equal((memory.hits as { id: string; version: number }[])[0].version, 3);
  const stale = memoryRetrievalEvidence({ generatedAt: '2026-11-19T02:00:00.000Z', runId: 'run', stepId: 'step', query: '入口', scope: null, hits: [{ id: 'm1', version: 3, status: 'verified', fresh: false, stale: true, stale_reason: 'offline', observed_at: '2026-11-19T00:00:00.000Z', content: '旧正文' }] });
  assert.equal(stale.fresh, false);
  assert.equal(stale.acceptable_as_current, false);
  assert.equal((stale.hits as { observed_at: string; status: string }[])[0].observed_at, '2026-11-19T00:00:00.000Z');
  assert.equal(JSON.stringify(stale).includes('旧正文'), false);
});
