import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ToolBroker, BrowserActor, startToolBridge } from '../src/index.js';
import { memoryFailureClass, pageEvidence } from '../src/evidence.js';
import { imageSize } from '../src/browser.js';

test('workspace file tools refuse parent traversal and symlink escape', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'super-agent-broker-')), outside = await mkdtemp(join(tmpdir(), 'super-agent-outside-'));
  const broker = new ToolBroker({ runId: 'run1', cwd: dir, browser: new BrowserActor(), request: async <T>() => ({} as T), assertActive: () => {}, ask: async () => '', signal: new AbortController().signal });
  try {
    await broker.execute('files_write', { path: 'reports/a.txt', content: 'real output' });
    assert.deepEqual(await broker.execute('files_read', { path: 'reports/a.txt' }), { content: 'real output' });
    await assert.rejects(broker.execute('files_write', { path: '../escape.txt', content: 'bad' }), /outside_workspace/);
    await writeFile(join(outside, 'secret.txt'), 'outside'); await symlink(outside, join(dir, 'link'));
    await assert.rejects(broker.execute('files_read', { path: 'link/secret.txt' }), /outside_workspace/);
    await assert.rejects(broker.execute('shell_run', { command: 'echo bad' }), /unknown_tool/);
    await assert.rejects(broker.execute('files_read', { path: 'reports/a.txt', injected: true }), /unknown_argument/);
    const bridge = await startToolBridge(broker);
    try { assert.equal((await fetch(`${bridge.url}/tools`)).status, 401); assert.equal((await fetch(`${bridge.url}/tools`, { headers: { authorization: `Bearer ${bridge.token}` } })).status, 200); }
    finally { await bridge.close(); }
  } finally { await rm(dir, { recursive: true, force: true }); await rm(outside, { recursive: true, force: true }); }
});

test('memory denial drops cached text and navigation still reaches the browser', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'super-agent-memory-')), calls: string[] = [], cache = new Map<string, unknown>();
  let reads = 0;
  const browser = new BrowserActor('http://csi.invalid', (async (_url: unknown, init: RequestInit) => {
    const command = JSON.parse(String(init.body)) as { action: string };
    calls.push(command.action);
    return Response.json({ success: true, data: command.action === 'evaluate' ? { value: JSON.stringify({ width: 10, height: 10, scale: 1, url: 'https://fixture.invalid/', scroll_x: 0, scroll_y: 0 }) } : {} });
  }) as typeof fetch);
  const deny = () => Object.assign(new Error('not_found'), { status: 404, code: 'not_found' });
  const broker = new ToolBroker({ runId: 'run', cwd: dir, browser, signal: new AbortController().signal, assertActive: () => {}, ask: async () => '',
    memoryCache: {
      lookup: (kind, fingerprint) => cache.has(`${kind}:${fingerprint}`) ? { hit: true, stale: false, observed_at: '2026-11-19T00:00:00.000Z', value: cache.get(`${kind}:${fingerprint}`) } : { hit: false },
      store: (kind, fingerprint, value) => { cache.set(`${kind}:${fingerprint}`, value); },
      markOffline: () => {},
      drop: (kind, fingerprint) => { cache.delete(`${kind}:${fingerprint}`); },
    },
    request: async (path) => {
      if (path === '/node/memory/read') { reads += 1; if (reads === 1) return { id: 'm1', content: 'secret-body', status: 'verified', version: 1, fresh: true }; throw deny(); }
      if (path === '/node/memory/search') throw deny();
      throw new Error('evidence-upload-unavailable');
    } });
  try {
    assert.equal(memoryFailureClass(deny()), 'deny');
    assert.equal(memoryFailureClass(Object.assign(new Error('down'), { status: 503, code: 'recall_credentials_invalid' })), 'deny');
    assert.equal(memoryFailureClass(Object.assign(new Error('down'), { status: 503, code: 'recall_unreachable' })), 'offline');
    const first = await broker.execute('memory_read', { id: 'm1' }) as { content?: string };
    assert.equal(first.content, 'secret-body');
    await assert.rejects(broker.execute('memory_read', { id: 'm1' }), /not_found/);
    assert.equal(cache.size, 0);
    await broker.execute('browser_navigate', { url: 'https://fixture.invalid/path' });
    assert.ok(calls.includes('navigate'));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('browser actor prevents concurrent owners, serializes operations and enforces human mode', async () => {
  const order: string[] = [];
  const browser = new BrowserActor('http://127.0.0.1:10088', (async (_url: unknown, options: RequestInit) => {
    const body = JSON.parse(String(options.body)) as { action: string }; order.push(body.action);
    return Response.json({ success: true, data: { action: body.action } });
  }) as typeof fetch);
  await browser.call('run1', 'navigate', { url: 'https://example.com' });
  await assert.rejects(browser.call('run2', 'click', { selector: '@e1' }), /browser_busy/);
  browser.setHuman('run1', true);
  await assert.rejects(browser.call('run1', 'click', { selector: '@e1' }), /human_control_active/);
  await assert.rejects(browser.input('run1', { frame_id: 'old', viewport_version: '0', type: 'click', x: 0, y: 0 }), /stale_frame/);
  await browser.release('run1'); await browser.call('run2', 'snapshot');
  assert.deepEqual(order, ['navigate', 'snapshot']);
});

test('lost receipt on a mutating browser call fences the worker as uncertain', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'super-agent-uncertain-'));
  let uncertain = false;
  const browser = new BrowserActor('http://127.0.0.1:10088', (async () => { throw new Error('connection closed after click'); }) as typeof fetch);
  const broker = new ToolBroker({ runId: 'run1', cwd: dir, browser, request: async <T>() => ({ items: [] } as T), signal: new AbortController().signal,
    assertActive: () => { if (uncertain) throw new Error('execution_fenced'); }, ask: async () => '', onUncertain: () => { uncertain = true; } });
  try {
    await assert.rejects(broker.execute('browser_click', { selector: '@e1' }), /connection closed/);
    assert.equal(uncertain, true);
    await assert.rejects(broker.execute('browser_click', { selector: '@e1' }), /execution_fenced/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('Retina frame coordinates map natural image pixels to CSS viewport and reject resize/stale input', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'super-agent-frame-'));
  const image = join(dir, 'frame.jpg');
  // Minimal valid SOF header for dimension parsing: 2400x1600 natural pixels.
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x0b, 0x08, 0x06, 0x40, 0x09, 0x60, 0x01, 0x01, 0x11, 0x00, 0xff, 0xd9]);
  await writeFile(image, jpeg);
  assert.deepEqual(imageSize(jpeg), { width: 2400, height: 1600 });
  let cssWidth = 1200;
  const clicks: Record<string, unknown>[] = [];
  const browser = new BrowserActor('http://127.0.0.1:10088', (async (_url: unknown, options: RequestInit) => {
    const body = JSON.parse(String(options.body)) as { action: string; args: Record<string, unknown> };
    if (body.action === 'screenshot') return Response.json({ success: true, data: { path: image } });
    if (body.action === 'evaluate') return Response.json({ success: true, data: { type: 'string', value: JSON.stringify({ width: cssWidth, height: 800, scale: 2, url: 'https://example.com', scroll_x: 0, scroll_y: 0 }) } });
    if (body.action === 'cdp') clicks.push(body.args.params as Record<string, unknown>);
    return Response.json({ success: true, data: {} });
  }) as typeof fetch);
  try {
    const frame = await browser.frame('run1');
    assert.equal(frame.width, 2400); assert.equal(frame.height, 1600);
    browser.setHuman('run1', true);
    await browser.input('run1', { frame_id: frame.frame_id, viewport_version: frame.viewport_version, type: 'click', x: 600, y: 400 });
    assert.equal(clicks[0]!.x, 300); assert.equal(clicks[0]!.y, 200);
    await assert.rejects(browser.input('run1', { frame_id: frame.frame_id, viewport_version: frame.viewport_version, type: 'click', x: 600, y: 400 }), /stale_frame/);
    const latest = await browser.frame('run1');
    await assert.rejects(browser.input('run1', { frame_id: latest.frame_id, viewport_version: latest.viewport_version, type: 'click', x: 2400, y: 0 }), /invalid_coordinates/);
    cssWidth = 900;
    await assert.rejects(browser.input('run1', { frame_id: latest.frame_id, viewport_version: latest.viewport_version, type: 'click', x: 100, y: 100 }), /stale_viewport/);
  } finally { await browser.release('run1'); await rm(dir, { recursive: true, force: true }); }
});

test('step lifecycle is stable and redacted for success, invalid input, cancellation and unknown side effects', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'super-agent-steps-'));
  const steps: import('@super-agent/protocol').ToolStepUpdate[] = [];
  const options = { runId: 'r1', cwd: dir, browser: new BrowserActor('http://127.0.0.1:10088', (async () => { throw Error('SECRET_URL_AND_BODY'); }) as typeof fetch), request: async <T>() => ({} as T), assertActive: () => {}, ask: async () => '', signal: new AbortController().signal, onStep: (step: import('@super-agent/protocol').ToolStepUpdate) => { steps.push(step); } };
  const broker = new ToolBroker(options);
  try {
    await broker.execute('files_write', { path: 'fixture', content: 'SECRET_CONTENT' });
    assert.deepEqual(steps.map(s => s.status), ['running', 'succeeded']);
    assert.equal(steps[0]!.step_id, steps[1]!.step_id);
    assert.match(steps[0]!.step_id, /^[0-9a-f-]{36}$/);
    await assert.rejects(broker.execute('browser_click', { selector: 123 }));
    assert.equal(steps.at(-1)!.error_code, 'invalid_arguments');
    await assert.rejects(broker.execute('browser_click', { selector: '@e1' }));
    assert.equal(steps.at(-1)!.status, 'result_unknown');
    assert.equal(steps.at(-1)!.error_code, 'result_unknown');
    const controller = new AbortController(); controller.abort();
    await assert.rejects(new ToolBroker({ ...options, signal: controller.signal }).execute('files_read', { path: 'fixture' }), { name: 'AbortError' });
    assert.equal(steps.at(-1)!.status, 'cancelled');
    assert.equal(JSON.stringify(steps).includes('SECRET'), false);
    assert.deepEqual(Object.keys(steps[0]!).sort(), ['completed_at', 'error_code', 'started_at', 'status', 'step_id', 'tool']);
    const bridge = await startToolBridge(broker);
    try {
      const res = await fetch(`${bridge.url}/call`, { method: 'POST', headers: { authorization: `Bearer ${bridge.token}`, 'content-type': 'application/json' }, body: JSON.stringify({ name: 'files_read', arguments: { path: 'fixture' } }) });
      assert.equal(res.status, 200);
      assert.deepEqual(steps.slice(-2).map(s => [s.tool, s.status]), [['files_read', 'running'], ['files_read', 'succeeded']]);
    } finally { await bridge.close(); }
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('runtime bridge restricts tool discovery and execution to the context allowlist', async () => {
  const { startRuntimeToolBridge } = await import('../src/index.js');
  const calls: string[] = [];
  const bridge = await startRuntimeToolBridge({ tools: [{ name: 'files_read', description: 'read', parameters: {} }], signal: new AbortController().signal, executeTool: async name => { calls.push(name); return { ok: true }; } });
  const headers = { authorization: `Bearer ${bridge.token}`, 'content-type': 'application/json' };
  try {
    assert.deepEqual((await (await fetch(`${bridge.url}/tools`, { headers })).json() as { name: string }[]).map(t => t.name), ['files_read']);
    assert.equal((await fetch(`${bridge.url}/call`, { method: 'POST', headers, body: JSON.stringify({ name: 'shell_run', arguments: {} }) })).status, 400);
    assert.deepEqual(calls, []);
    assert.equal((await fetch(`${bridge.url}/call`, { method: 'POST', headers, body: JSON.stringify({ name: 'files_read', arguments: {} }) })).status, 200);
    assert.deepEqual(calls, ['files_read']);
  } finally { await bridge.close(); }
});

test('memory cache envelopes stay stale and capture binds url to the same body', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'super-agent-evidence-'));
  const observed = '2026-11-19T00:00:00.000Z';
  const offline = Object.assign(new Error('down'), { status: 503, code: 'recall_unreachable' });
  const memoryBroker = new ToolBroker({ runId: 'run', cwd: dir, browser: new BrowserActor(), signal: new AbortController().signal, assertActive: () => {}, ask: async () => '',
    memoryCache: {
      lookup: (kind) => kind === 'search'
        ? { hit: true, stale: true, observed_at: observed, value: { items: [], scope: { project: 'alpha' }, fresh: false, stale: true, stale_reason: 'ttl', observed_at: observed, cache_read_at: '2026-11-19T01:00:00.000Z' } }
        : { hit: true, stale: true, observed_at: observed, value: { id: 'm1', content: null, fresh: false, stale: true, stale_reason: 'offline', observed_at: observed, cache_read_at: '2026-11-19T01:00:00.000Z' } },
      store: () => {}, markOffline: () => {}, drop: () => {},
    },
    request: async (path) => { if (path === '/node/memory/search' || path === '/node/memory/read') throw offline; throw new Error('evidence-upload-unavailable'); } });
  const scripted = (evaluate: string[], snapshot: string[], screenshot?: string) => {
    let urls = 0, bodies = 0; const actions: string[] = [];
    const browser = new BrowserActor('http://csi.invalid', (async (_url: unknown, init: RequestInit) => {
      const command = JSON.parse(String(init.body)) as { action: string }; actions.push(command.action);
      if (command.action === 'evaluate') { const url = evaluate[Math.min(urls, evaluate.length - 1)] ?? ''; urls += 1; return Response.json({ success: true, data: { value: JSON.stringify({ width: 8, height: 8, scale: 1, url, scroll_x: 0, scroll_y: 0 }) } }); }
      if (command.action === 'snapshot') { const text = snapshot[Math.min(bodies, snapshot.length - 1)] ?? ''; bodies += 1; return Response.json({ success: true, data: { text } }); }
      if (command.action === 'screenshot') return Response.json({ success: true, data: { path: screenshot } });
      return Response.json({ success: true, data: {} });
    }) as typeof fetch);
    return { browser, actions };
  };
  try {
    const search = await memoryBroker.execute('memory_search', { query: '入口' }) as { evidence: { fresh: boolean; stale: boolean; stale_reason: string; observed_at: string; retrieved_at: string; generated_at: string } };
    assert.equal(search.evidence.fresh, false);
    assert.equal(search.evidence.stale, true);
    assert.equal(search.evidence.stale_reason, 'ttl');
    assert.equal(search.evidence.observed_at, observed);
    assert.equal(search.evidence.retrieved_at, '2026-11-19T01:00:00.000Z');
    assert.notEqual(search.evidence.generated_at, observed);
    const read = await memoryBroker.execute('memory_read', { id: 'm1' }) as { content: string | null; evidence: { fresh: boolean; stale: boolean; observed_at: string; stale_reason: string } };
    assert.equal(read.content, null);
    assert.equal(read.evidence.fresh, false);
    assert.equal(read.evidence.stale, true);
    assert.equal(read.evidence.stale_reason, 'offline');
    assert.equal(read.evidence.observed_at, observed);
    const stable = scripted(['https://stable.example/page'], ['stable-body']);
    const stableBroker = new ToolBroker({ runId: 'run', cwd: dir, browser: stable.browser, signal: new AbortController().signal, assertActive: () => {}, ask: async () => '', request: async <T>() => { throw new Error('evidence-upload-unavailable'); } });
    const stableShot = await stableBroker.execute('browser_snapshot', {}) as { snapshot: { text: string }; evidence: { source_uncertain?: boolean; source_url?: string | null; fresh?: boolean } };
    assert.deepEqual(stable.actions, ['evaluate', 'snapshot', 'evaluate']);
    assert.equal(stableShot.snapshot.text, 'stable-body');
    assert.equal(stableShot.evidence.source_uncertain, false);
    assert.equal(stableShot.evidence.source_url, 'https://stable.example/page');
    assert.equal(stableShot.evidence.fresh, true);
    assert.equal(stableShot.evidence.stale, false);
    const settledUrls = ['https://old.example/a', 'https://new.example/b', 'https://new.example/b', 'https://new.example/b'];
    const settled = scripted(settledUrls, ['first-body', 'second-body']);
    const settledCapture = await settled.browser.capture('run');
    assert.equal(settled.actions.filter(action => action === 'evaluate').length, 4);
    assert.equal(settled.actions.filter(action => action === 'snapshot').length, 2);
    assert.equal(settledCapture.source_uncertain, false);
    assert.equal(settledCapture.url, 'https://new.example/b');
    assert.equal((settledCapture.snapshot as { text: string }).text, 'second-body');
    const settledPage = pageEvidence({ url: settledCapture.url, capturedAt: settledCapture.captured_at, runId: 'run', stepId: 'step', body: settledCapture.snapshot, sourceUncertain: settledCapture.source_uncertain, sourceUncertainReason: settledCapture.source_uncertain_reason ?? undefined });
    assert.equal(settledPage.source_url, 'https://new.example/b');
    assert.equal(settledPage.fresh, true);
    assert.equal(JSON.stringify(settledPage).includes('first-body'), false);
    const shifting = scripted(['https://first.example/a', 'https://second.example/b', 'https://third.example/c', 'https://fourth.example/d'], ['first-body', 'second-body']);
    const shiftingBroker = new ToolBroker({ runId: 'run', cwd: dir, browser: shifting.browser, signal: new AbortController().signal, assertActive: () => {}, ask: async () => '', request: async <T>() => { throw new Error('evidence-upload-unavailable'); } });
    const shifted = await shiftingBroker.execute('browser_snapshot', {}) as { snapshot: { text: string }; evidence: { source_uncertain?: boolean; source_url?: string | null; fresh?: boolean } };
    assert.equal(shifted.snapshot.text, 'second-body');
    assert.equal(shifting.actions.filter(action => action === 'evaluate').length, 4);
    assert.equal(shifting.actions.filter(action => action === 'snapshot').length, 2);
    assert.equal(shifted.evidence.source_uncertain, true);
    assert.equal(shifted.evidence.source_url ?? null, null);
    assert.equal(shifted.evidence.fresh, false);
    assert.equal(shifted.evidence.stale, true);
    assert.equal(JSON.stringify(shifted).includes('first-body'), false);
    assert.equal(JSON.stringify(shifted).includes('fourth.example'), false);
    assert.equal(JSON.stringify(shifted).includes('second.example'), false);
    const image = join(dir, 'frame.jpg');
    await writeFile(image, Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x0b, 0x08, 0x00, 0x10, 0x00, 0x10, 0x01, 0x01, 0x11, 0x00, 0xff, 0xd9]));
    const shot = scripted(['https://first.example/a', 'https://second.example/b', 'https://third.example/c', 'https://fourth.example/d'], ['first-body', 'second-body'], image);
    const shotBroker = new ToolBroker({ runId: 'shot', cwd: dir, browser: shot.browser, signal: new AbortController().signal, assertActive: () => {}, ask: async () => '', request: async <T>() => { throw new Error('evidence-upload-unavailable'); } });
    const shotResult = await shotBroker.execute('browser_screenshot', {}) as { evidence: { source_uncertain?: boolean; source_url?: string | null; fresh?: boolean } };
    assert.ok(shot.actions.includes('snapshot'));
    assert.ok(shot.actions.includes('screenshot'));
    assert.equal(shotResult.evidence.source_uncertain, true);
    assert.equal(shotResult.evidence.fresh, false);
    assert.equal(shotResult.evidence.stale, true);
    assert.equal(shotResult.evidence.source_url ?? null, null);
    assert.equal(JSON.stringify(shotResult).includes('fourth.example'), false);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('unreadable CSI evaluate cannot make a page fresh or bind the requested url', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'super-agent-unreadable-'));
  const image = join(dir, 'frame.jpg');
  await writeFile(image, Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x0b, 0x08, 0x00, 0x10, 0x00, 0x10, 0x01, 0x01, 0x11, 0x00, 0xff, 0xd9]));
  const uploads: Record<string, unknown>[] = [];
  const requested = 'https://user:secret@requested.example/start?token=abc#frag';
  const redacted = 'https://user:secret@stable.example/path?code=abc&ticket=1#frag';
  const actor = (evaluate: () => unknown) => {
    const actions: string[] = [];
    const browser = new BrowserActor('http://csi.invalid', (async (_url: unknown, init: RequestInit) => {
      const command = JSON.parse(String(init.body)) as { action: string };
      actions.push(command.action);
      if (command.action === 'evaluate') return Response.json(evaluate());
      if (command.action === 'snapshot') return Response.json({ success: true, data: { text: 'snapshot-body' } });
      if (command.action === 'screenshot') return Response.json({ success: true, data: { path: image } });
      return Response.json({ success: true, data: { ok: true } });
    }) as typeof fetch);
    return { browser, actions };
  };
  const request = async (path: string, body?: unknown) => {
    if (path === '/node/memory/search') return { items: [] };
    if (path === '/artifacts/uploads') {
      uploads.push(body as Record<string, unknown>);
      return { artifact_id: `art-${uploads.length}`, upload_url: 'https://objects.example/put', max_size: 50_000_000 };
    }
    if (path.endsWith('/finalize')) return { status: 'ready' };
    throw new Error(`unexpected ${path}`);
  };
  const brokerFor = (browser: BrowserActor) => new ToolBroker({ runId: 'run', cwd: dir, browser, signal: new AbortController().signal, assertActive: () => {}, ask: async () => '', fetcher: async () => new Response(null, { status: 200 }), request });
  const reviewer = (evidence: { fresh?: boolean; stale?: boolean; source_uncertain?: boolean; source_url?: string | null; source_uncertain_reason?: string }) => {
    assert.equal(evidence.source_uncertain, true);
    assert.equal(evidence.fresh, false);
    assert.equal(evidence.stale, true);
    assert.equal(evidence.source_url ?? null, null);
    assert.equal(typeof evidence.source_uncertain_reason, 'string');
    assert.ok(evidence.source_uncertain_reason);
  };
  try {
    const blank = actor(() => ({ success: true, value: '{}' }));
    const blankBroker = brokerFor(blank.browser);
    const navigated = await blankBroker.execute('browser_navigate', { url: requested }) as { evidence: { fresh: boolean; stale: boolean; source_uncertain: boolean; source_url: string | null; source_uncertain_reason?: string; evidence_status?: string } };
    reviewer(navigated.evidence);
    assert.equal(navigated.evidence.evidence_status, 'ready');
    assert.equal(blank.actions.filter(action => action === 'navigate').length, 1);
    assert.equal(JSON.stringify(navigated.evidence).includes('requested.example'), false);
    assert.equal(JSON.stringify(navigated.evidence).includes('token=abc'), false);
    const snap = await blankBroker.execute('browser_snapshot', {}) as { evidence: { fresh: boolean; stale: boolean; source_uncertain: boolean; source_url: string | null; source_uncertain_reason?: string } };
    reviewer(snap.evidence);
    const shot = await blankBroker.execute('browser_screenshot', {}) as { evidence: { fresh: boolean; stale: boolean; source_uncertain: boolean; source_url: string | null; source_uncertain_reason?: string } };
    reviewer(shot.evidence);
    assert.equal(blank.actions.filter(action => action === 'snapshot').length, 6);
    assert.ok(uploads.length >= 4);
    for (const upload of uploads) {
      assert.equal(upload.source_uncertain, true);
      assert.equal(upload.fresh, false);
      assert.equal(upload.stale, true);
      assert.equal(upload.source_url, null);
      assert.equal(typeof upload.source_uncertain_reason, 'string');
      assert.equal(JSON.stringify(upload).includes('requested.example'), false);
      assert.equal(JSON.stringify(upload).includes('token=abc'), false);
      assert.equal(JSON.stringify(upload).includes('secret'), false);
    }
    uploads.length = 0;
    const stable = actor(() => ({ success: true, data: { value: JSON.stringify({ width: 8, height: 8, scale: 1, url: redacted, scroll_x: 0, scroll_y: 0 }) } }));
    const stableBroker = brokerFor(stable.browser);
    const stableSnap = await stableBroker.execute('browser_snapshot', {}) as { evidence: { fresh: boolean; stale: boolean; source_uncertain: boolean; source_url: string | null } };
    assert.equal(stable.actions.filter(action => action === 'snapshot').length, 1);
    assert.equal(stableSnap.evidence.fresh, true);
    assert.equal(stableSnap.evidence.stale, false);
    assert.equal(stableSnap.evidence.source_uncertain, false);
    assert.equal(stableSnap.evidence.source_url, 'https://stable.example/path');
    const stableShot = await stableBroker.execute('browser_screenshot', {}) as { evidence: { fresh: boolean; stale: boolean; source_uncertain: boolean; source_url: string | null } };
    assert.equal(stableShot.evidence.fresh, true);
    assert.equal(stableShot.evidence.stale, false);
    assert.equal(stableShot.evidence.source_uncertain, false);
    assert.equal(stableShot.evidence.source_url, 'https://stable.example/path');
    assert.ok(uploads.length >= 3);
    for (const upload of uploads) {
      assert.equal(upload.fresh, true);
      assert.equal(upload.stale, false);
      assert.equal(upload.source_uncertain, false);
      assert.equal(upload.source_url, 'https://stable.example/path');
      assert.equal(JSON.stringify(upload).includes('secret'), false);
      assert.equal(JSON.stringify(upload).includes('code=abc'), false);
      assert.equal(JSON.stringify(upload).includes('ticket=1'), false);
    }
    const about = actor(() => ({ success: true, data: { value: JSON.stringify({ width: 8, height: 8, scale: 1, url: 'about:blank', scroll_x: 0, scroll_y: 0 }) } }));
    const aboutCapture = await about.browser.capture('run');
    assert.equal(about.actions.filter(action => action === 'snapshot').length, 2);
    assert.equal(aboutCapture.source_uncertain, true);
    assert.equal(aboutCapture.url, '');
    const aboutPage = pageEvidence({ url: aboutCapture.url, capturedAt: aboutCapture.captured_at, runId: 'run', stepId: 'step', body: aboutCapture.snapshot, sourceUncertain: aboutCapture.source_uncertain, sourceUncertainReason: aboutCapture.source_uncertain_reason ?? undefined });
    assert.equal(aboutPage.fresh, false);
    assert.equal(aboutPage.stale, true);
    assert.equal(aboutPage.source_uncertain, true);
    assert.equal(aboutPage.source_url, null);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('disabled browser is absent from discovery and rejects even forged direct calls while files remain usable', async () => {
 const dir = await mkdtemp(join(tmpdir(), 'super-agent-no-browser-'));
 const broker = new ToolBroker({ runId: 'r', cwd: dir, browser: new BrowserActor(), allowBrowser: false, request: async <T>() => ({} as T), assertActive: () => {}, ask: async () => '', signal: new AbortController().signal });
 try {
  assert.equal(broker.definitions().some(t => t.name.startsWith('browser_')), false);
  await assert.rejects(broker.execute('browser_click', { selector: '@e1' }), /browser_capability_unavailable/);
  await broker.execute('files_write', { path: 'works', content: 'yes' });
  assert.deepEqual(await broker.execute('files_read', { path: 'works' }), { content: 'yes' });
 } finally { await rm(dir, { recursive: true, force: true }); }
});
