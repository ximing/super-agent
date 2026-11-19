import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ToolBroker, BrowserActor, startToolBridge } from '../src/index.js';
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
