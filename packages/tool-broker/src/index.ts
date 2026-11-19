import { createServer, type Server } from 'node:http';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { readFile, writeFile, readdir, mkdir, realpath } from 'node:fs/promises';
import { dirname, resolve, relative, isAbsolute } from 'node:path';
import { spawn } from 'node:child_process';
import type { ToolDefinition, RuntimeContext } from './runtime.js';
export * from './runtime.js';
export { BrowserActor } from './browser.js';
import { BrowserActor } from './browser.js';
import { ArtifactTools } from './artifacts.js';
import type { ToolStepUpdate } from '@super-agent/protocol';

type Args = Record<string, unknown>;
const string = (a: Args, key: string, limit = 100_000): string => {
  if (typeof a[key] !== 'string' || a[key].length > limit || !a[key].length) throw new Error(`invalid_argument: ${key}`);
  return a[key];
};
const schema = (properties: Args, required: string[] = []) => ({ type: 'object', properties, required, additionalProperties: false });
const str = { type: 'string' };
export interface BrokerOptions {
  runId: string;
  cwd: string;
  browser: BrowserActor;
  request: <T = unknown>(path: string, body?: unknown) => Promise<T>;
  assertActive: () => void;
  ask: (text: string, options?: string[]) => Promise<string>;
  allowShell?: boolean;
  allowBrowser?: boolean;
  assistant?: boolean;
  fetcher?: typeof fetch;
  signal: AbortSignal;
  onOperation?: (name: string, result: unknown) => void | Promise<void>;
  onUncertain?: (name: string) => void;
  onStep?: (step: ToolStepUpdate) => void | Promise<void>;
}
export class ToolBroker {
  constructor(private readonly options: BrokerOptions) {}
  definitions(): ToolDefinition[] {
    const definitions: ToolDefinition[] = [
      { name: 'browser_navigate', description: 'Open a website in this task browser session. Read known website instructions with memory_search first.', parameters: schema({ url: str }, ['url']) },
      { name: 'browser_snapshot', description: 'Read the current browser accessibility tree. Use the returned @e references for click/fill.', parameters: schema({}) },
      { name: 'browser_click', description: 'Click a current semantic @e reference or CSS selector.', parameters: schema({ selector: str }, ['selector']) },
      { name: 'browser_fill', description: 'Replace content in an input or contenteditable element.', parameters: schema({ selector: str, value: str }, ['selector', 'value']) },
      { name: 'browser_keys', description: 'Press keys in this task browser, such as Enter or Mod+a.', parameters: schema({ keys: str }, ['keys']) },
      { name: 'browser_screenshot', description: 'Capture the current page as task evidence and for the human viewer.', parameters: schema({}) },
      { name: 'memory_search', description: 'Search the user cloud memory for website knowledge, preferences, procedures, and prior task experience. Search before unfamiliar work.', parameters: schema({ query: str, site: str, limit: { type: 'integer', minimum: 1, maximum: 20 } }, ['query']) },
      { name: 'memory_read', description: 'Read a memory returned by search, including its source/version.', parameters: schema({ id: str }, ['id']) },
      { name: 'memory_propose', description: 'Save a candidate observation or validated procedure with evidence. This cannot change user authorization.', parameters: schema({ title: str, content: str, type: { enum: ['preference', 'website', 'procedure', 'project', 'experience'] }, site: str }, ['title', 'content', 'type']) },
      { name: 'files_list', description: 'List a directory in the task workspace.', parameters: schema({ path: str }) },
      { name: 'files_read', description: 'Read a UTF-8 task workspace file, maximum 256 KB.', parameters: schema({ path: str }, ['path']) },
      { name: 'files_write', description: 'Create or replace a task workspace UTF-8 file, maximum 1 MB.', parameters: schema({ path: str, content: str }, ['path', 'content']) },
      { name: 'artifacts_list', description: 'List attachments and completed artifacts belonging to this task, including user inputs and earlier runs.', parameters: schema({}) },
      { name: 'artifacts_download', description: 'Download a task attachment into the task workspace, maximum 50 MB.', parameters: schema({ id: str, path: str }, ['id', 'path']) },
      { name: 'artifacts_upload', description: 'Upload a task workspace file as a cloud artifact, maximum 50 MB.', parameters: schema({ path: str, name: str, mime: str }, ['path']) },
      { name: 'question_ask', description: 'Ask the user a necessary question and wait for the answer. Already authorized routine steps do not need reapproval.', parameters: schema({ text: str, options: { type: 'array', items: str, maxItems: 6 } }, ['text']) },
    ];
    if (this.options.allowShell) definitions.push({ name: 'shell_run', description: 'Run an authorized shell command in the task workspace. Never read/export credentials or launch detached background agents.', parameters: schema({ command: str }, ['command']) });
    if (this.options.assistant) definitions.push(
      { name: 'tasks_list', description: 'List the user tasks and their progress without waiting for completion.', parameters: schema({}) },
      { name: 'devices_list', description: 'List the user available execution computers and configured engines.', parameters: schema({}) },
      { name: 'task_start', description: 'Propose work on a selected computer. The user must confirm the proposed goal and deliverables before execution.', parameters: schema({ goal: str, title: str, deliverables: { type: 'array', items: str }, engine: { enum: ['codex', 'grok'] }, device_id: str, item_key: str, depends_on_keys: { type: 'array', items: str, maxItems: 40 }, parent_item_key: str }, ['goal', 'deliverables', 'engine', 'device_id', 'item_key']) },
      { name: 'task_status', description: 'Read a background task status.', parameters: schema({ id: str }, ['id']) },
    );
    return this.options.allowBrowser === false ? definitions.filter(tool => !tool.name.startsWith('browser_')) : definitions;
  }
  async execute(name: string, args: Args): Promise<unknown> {
    const step: ToolStepUpdate = { step_id: randomUUID(), tool: this.definitions().some(tool => tool.name === name) ? name : 'other', status: 'running', started_at: new Date().toISOString(), completed_at: null, error_code: null };
    let unsafe = false;
    try {
      await this.options.onStep?.(step);
      const result = await this.perform(name, args, () => { unsafe = true; });
      await this.options.onStep?.({ ...step, status: 'succeeded', completed_at: new Date().toISOString() });
      return result;
    } catch (error) {
      const cancelled = this.options.signal.aborted || error instanceof Error && error.name === 'AbortError';
      const message = error instanceof Error ? error.message : '';
      const errorCode: ToolStepUpdate['error_code'] = unsafe ? 'result_unknown' : cancelled ? 'cancelled' : /outside_workspace|execution_lease|fenced|not_authorized/.test(message) ? 'not_authorized' : /invalid_|unknown_argument|missing_argument|unknown_tool|unsupported_url/.test(message) ? 'invalid_arguments' : 'tool_failed';
      if (unsafe) this.options.onUncertain?.(name);
      await this.options.onStep?.({ ...step, status: unsafe ? 'result_unknown' : cancelled ? 'cancelled' : 'failed', completed_at: new Date().toISOString(), error_code: errorCode });
      throw error;
    }
  }
  private async perform(name: string, args: Args, markUnsafe: () => void): Promise<unknown> {
    this.options.assertActive();
    if (this.options.allowBrowser === false && name.startsWith('browser_')) throw new Error('browser_capability_unavailable');
    if (this.options.signal.aborted) throw new DOMException('Execution stopped', 'AbortError');
    const definition = this.definitions().find(t => t.name === name);
    if (!definition) throw new Error(`unknown_tool: ${name}`);
    // Schemas are trusted definitions, inputs remain untrusted data. Validate simple shape here.
    if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('invalid_tool_arguments');
    const props = definition.parameters.properties as Args;
    for (const key of Object.keys(args)) if (!(key in props)) throw new Error(`unknown_argument: ${key}`);
    for (const required of definition.parameters.required as string[]) if (!(required in args)) throw new Error(`missing_argument: ${required}`);
    let result: unknown;
    const browser = this.options.browser, runId = this.options.runId;
    switch (name) {
      case 'browser_navigate': {
        const url = new URL(string(args, 'url', 4096));
        if (!['https:', 'http:'].includes(url.protocol)) throw new Error('unsupported_url_protocol');
        const knowledge = await this.options.request('/node/memory/search', { query: url.hostname, site: url.hostname, limit: 5 });
        markUnsafe();
        const navigation = await browser.call(runId, 'navigate', { url: url.href, newTab: true, group_title: 'Super-agent 任务' });
        result = { knowledge, navigation }; break;
      }
      case 'browser_snapshot': result = await browser.call(runId, 'snapshot'); break;
      case 'browser_click': { const selector = string(args, 'selector', 1000); markUnsafe(); result = await browser.call(runId, 'click', { selector }); break; }
      case 'browser_fill': { const selector = string(args, 'selector', 1000), value = typeof args.value === 'string' ? args.value : (() => { throw new Error('invalid_argument: value'); })(); markUnsafe(); result = await browser.call(runId, 'fill', { selector, value }); break; }
      case 'browser_keys': { const keys = string(args, 'keys', 1000); markUnsafe(); result = await browser.call(runId, 'send_keys', { keys }); break; }
      case 'browser_screenshot': {
        const frame = await browser.frame(runId);
        await this.options.request(`/node/runs/${runId}/frames`, frame);
        result = { captured: true, frame_id: frame.frame_id, width: frame.width, height: frame.height, captured_at: frame.captured_at }; break;
      }
      case 'memory_search': result = await this.options.request('/node/memory/search', { query: string(args, 'query'), site: args.site, limit: Math.min(20, Math.max(1, Number(args.limit ?? 5))) }); break;
      case 'memory_read': result = await this.options.request('/node/memory/read', { id: string(args, 'id', 100) }); break;
      case 'memory_propose': {
        if (!['preference', 'website', 'procedure', 'project', 'experience'].includes(String(args.type))) throw new Error('invalid_memory_type');
        result = await this.options.request('/node/memory/proposals', { title: string(args, 'title', 500), content: string(args, 'content'), type: args.type, site: args.site }); break;
      }
      case 'files_list': result = await readdir(await this.path(typeof args.path === 'string' ? args.path : '.', false), { withFileTypes: true }).then(entries => entries.map(e => ({ name: e.name, directory: e.isDirectory() }))); break;
      case 'files_read': {
        const data = await readFile(await this.path(string(args, 'path', 4096), false));
        if (data.length > 256 * 1024) throw new Error('file_too_large');
        result = { content: data.toString('utf8') }; break;
      }
      case 'files_write': {
        const content = typeof args.content === 'string' ? args.content : (() => { throw new Error('invalid_content'); })();
        if (Buffer.byteLength(content) > 1024 * 1024) throw new Error('file_too_large');
        const path = await this.path(string(args, 'path', 4096), true);
        await writeFile(path, content, { mode: 0o600 }); result = { written: true, bytes: Buffer.byteLength(content) }; break;
      }
      case 'artifacts_list': result = await this.artifacts().list(); break;
      case 'artifacts_download': result = await this.artifacts().download(args.id, string(args, 'path', 4096)); break;
      case 'artifacts_upload': result = await this.artifacts().upload(string(args, 'path', 4096), args.name, args.mime); break;
      case 'question_ask': result = { answer: await this.options.ask(string(args, 'text', 4000), Array.isArray(args.options) ? args.options.map(String).slice(0, 6) : undefined) }; break;
      case 'shell_run': { const command = string(args, 'command', 16_000); markUnsafe(); result = await this.shell(command); break; }
      case 'tasks_list': result = await this.options.request('/tasks'); break;
      case 'devices_list': result = await this.options.request('/devices'); break;
      case 'task_start': {
        if (args.depends_on_keys !== undefined && (!Array.isArray(args.depends_on_keys) || args.depends_on_keys.length > 40 || args.depends_on_keys.some(key => typeof key !== 'string' || !key || key.length > 100))) throw new Error('invalid_depends_on_keys');
        if (args.parent_item_key !== undefined) string(args, 'parent_item_key', 100);
        result = await this.options.request('/node/tasks', { goal: string(args, 'goal'), title: args.title, deliverables: Array.isArray(args.deliverables) ? args.deliverables.map(String).slice(0, 20) : [], engine: args.engine, device_id: string(args, 'device_id', 100), item_key: string(args, 'item_key', 100), depends_on_keys: args.depends_on_keys ?? [], ...(args.parent_item_key ? { parent_item_key: args.parent_item_key } : {}) }); break; }
      case 'task_status': result = await this.options.request(`/tasks/${encodeURIComponent(string(args, 'id', 100))}`); break;
      default: throw new Error('unsupported_tool');
    }
    await this.options.onOperation?.(name, result);
    return result;
  }
  private artifacts(): ArtifactTools { return new ArtifactTools({ resolvePath: (path, create) => this.path(path, create), request: this.options.request, signal: this.options.signal, assertActive: this.options.assertActive, fetcher: this.options.fetcher }); }
  private async path(path: string, create: boolean): Promise<string> {
    const root = await realpath(this.options.cwd), candidate = resolve(root, path);
    const rel = relative(root, candidate);
    if (rel.startsWith('..') || isAbsolute(rel)) throw new Error('path_outside_workspace');
    if (create) {
      // Check each existing ancestor before creating directories to prevent symlink escape.
      let ancestor = dirname(candidate);
      while (true) {
        try { const actual = await realpath(ancestor); if (!this.inside(root, actual)) throw new Error('symlink_outside_workspace'); break; }
        catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; ancestor = dirname(ancestor); }
      }
      await mkdir(dirname(candidate), { recursive: true, mode: 0o700 });
      try { const actual = await realpath(candidate); if (!this.inside(root, actual)) throw new Error('symlink_outside_workspace'); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
      return candidate;
    }
    const actual = await realpath(candidate);
    if (!this.inside(root, actual)) throw new Error('symlink_outside_workspace');
    return actual;
  }
  private inside(root: string, path: string): boolean { const rel = relative(root, path); return !rel.startsWith('..') && !isAbsolute(rel); }
  private shell(command: string): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const child = spawn('/bin/zsh', ['-lc', command], { cwd: this.options.cwd, stdio: ['ignore', 'pipe', 'pipe'], signal: this.options.signal, timeout: 30_000, env: { PATH: process.env.PATH, HOME: process.env.HOME, LANG: process.env.LANG } });
      let stdout = '', stderr = '';
      child.stdout.on('data', d => { stdout = (stdout + String(d)).slice(-65_536); });
      child.stderr.on('data', d => { stderr = (stderr + String(d)).slice(-65_536); });
      child.once('error', reject); child.once('close', code => resolve({ exit_code: code, stdout, stderr }));
    });
  }
}

/** Private loopback transport for a Codex-launched MCP process; never a public control endpoint. */
export async function startToolBridge(broker: Pick<ToolBroker, 'definitions' | 'execute'>): Promise<{ url: string; token: string; close: () => Promise<void> }> {
  const token = randomBytes(32).toString('hex');
  const server: Server = createServer(async (req, res) => {
    try {
      const auth = req.headers.authorization ?? '';
      const expected = `Bearer ${token}`;
      if (Buffer.byteLength(auth) !== Buffer.byteLength(expected) || !timingSafeEqual(Buffer.from(auth), Buffer.from(expected))) { res.writeHead(401).end(); return; }
      if (req.method === 'GET' && req.url === '/tools') { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(broker.definitions())); return; }
      if (req.method !== 'POST' || req.url !== '/call') { res.writeHead(404).end(); return; }
      let body = '';
      for await (const chunk of req) { body += String(chunk); if (Buffer.byteLength(body) > 1_200_000) throw new Error('request_too_large'); }
      const input = JSON.parse(body) as { name: string; arguments: Args };
      const result = await broker.execute(input.name, input.arguments ?? {});
      res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ result }));
    } catch (error) { res.writeHead(400, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: (error as Error).message })); }
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('bridge_listen_failed');
  return { url: `http://127.0.0.1:${address.port}`, token, close: () => new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); }) };
}

/** Constrain both discovery and execution, including planning/review runtimes without a full worker broker. */
export function startRuntimeToolBridge(context: Pick<RuntimeContext, 'tools' | 'executeTool' | 'signal'>) {
  const allowed = new Map(context.tools.map(tool => [tool.name, tool]));
  return startToolBridge({ definitions: () => [...allowed.values()], execute: (name, args) => {
    if (context.signal.aborted) throw new DOMException('Execution stopped', 'AbortError');
    if (!allowed.has(name)) throw new Error('tool_not_authorized');
    return context.executeTool(name, args);
  } });
}
