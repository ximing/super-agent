import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import { EventEmitter } from 'node:events';
import type { RuntimeAdapter, RuntimeContext, RuntimeResult, UsageSample } from '@super-agent/tool-broker/runtime';
import { abortError, checkAbort, sleep } from '@super-agent/tool-broker/runtime';
import { managedCodexArgs, managedCompatibilityMessage, verifyManagedCli } from './managed.js';
export { managedCodexArgs } from './managed.js';

type Obj = Record<string, unknown>;
interface RpcMessage { id?: number | string; method?: string; params?: Obj; result?: unknown; error?: { message?: string; code?: number } }
export class CodexRpc extends EventEmitter {
  private nextId = 0;
  private pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  private child: ChildProcessWithoutNullStreams;
  constructor(command = 'codex', args = ['app-server', '--stdio'], private timeoutMs = 120_000, env?: NodeJS.ProcessEnv) {
    super();
    this.child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'], ...(env ? { env } : {}) });
    const lines = createInterface({ input: this.child.stdout, crlfDelay: Infinity });
    lines.on('line', line => { try { this.receive(JSON.parse(line) as RpcMessage); } catch { /* Ignore non-protocol lines; never upload stderr or credential-bearing startup text. */ } });
    this.child.stderr.resume();
    this.child.on('error', error => this.fail(error));
    this.child.on('exit', code => { this.fail(new Error(`codex_process_exited:${code}`)); this.emit('exited', code); });
  }
  private receive(message: RpcMessage): void {
    if (message.id !== undefined && !message.method && typeof message.id === 'number') {
      const pending = this.pending.get(message.id);
      if (pending) { this.pending.delete(message.id); clearTimeout(pending.timer); message.error ? pending.reject(new Error(`codex_rpc:${message.error.code ?? 'unknown'}:${message.error.message ?? 'request failed'}`)) : pending.resolve(message.result); }
    } else if (message.method) this.emit(message.id === undefined ? 'notification' : 'request', message);
  }
  request<T = Obj>(method: string, params: Obj = {}): Promise<T> {
    const id = ++this.nextId;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`codex_rpc_timeout:${method}`)); }, this.timeoutMs);
      this.pending.set(id, { resolve: value => resolve(value as T), reject, timer });
      this.child.stdin.write(`${JSON.stringify({ id, method, params })}\n`, error => { if (error) { clearTimeout(timer); this.pending.delete(id); reject(error); } });
    });
  }
  notify(method: string, params?: Obj): void { this.child.stdin.write(`${JSON.stringify({ method, ...(params ? { params } : {}) })}\n`); }
  reply(id: number | string, result: unknown): void { this.child.stdin.write(`${JSON.stringify({ id, result })}\n`); }
  private fail(error: Error): void { for (const item of this.pending.values()) { clearTimeout(item.timer); item.reject(error); } this.pending.clear(); }
  async close(): Promise<void> {
    if (this.child.exitCode !== null) return;
    this.child.stdin.end();
    await new Promise<void>(resolve => {
      const timer = setTimeout(() => { this.child.kill('SIGKILL'); resolve(); }, 3000);
      this.child.once('exit', () => { clearTimeout(timer); resolve(); });
    });
  }
}

export interface CodexErrorInfo { code: string; http_status: number | null; will_retry: boolean }
export function safeCodexError(params: Obj): CodexErrorInfo {
  const info = (params.error as Obj | undefined)?.codexErrorInfo;
  const known = new Set(['contextWindowExceeded', 'sessionBudgetExceeded', 'usageLimitExceeded', 'rateLimitExceeded', 'flexUnavailable', 'serverOverloaded', 'modelNotFound', 'policyCapacityUnavailable', 'cyberPolicy', 'misalignmentPolicyViolation', 'tooManyDenials', 'internalServerError', 'unauthorized', 'badRequest', 'threadRollbackFailed', 'sandboxError', 'other', 'inferenceHookDenied', 'httpConnectionFailed', 'responseStreamConnectionFailed', 'responseStreamDisconnected', 'responseTooManyFailedAttempts', 'activeTurnNotSteerable']);
  const key = typeof info === 'string' ? info : info && typeof info === 'object' ? Object.keys(info)[0] : undefined;
  const rawStatus = key && info && typeof info === 'object' ? ((info as Obj)[key] as Obj | undefined)?.httpStatusCode : undefined;
  return { code: key && known.has(key) ? key : 'unknown', http_status: typeof rawStatus === 'number' && Number.isInteger(rawStatus) && rawStatus >= 100 && rawStatus <= 599 ? rawStatus : null, will_retry: params.willRetry === true };
}
export interface CodexOptions { command?: string; args?: string[]; env?: NodeJS.ProcessEnv; timeoutMs?: number; maxRunMs?: number; sandbox?: 'read-only' | 'workspace-write' | 'danger-full-access'; reasoningEffort?: 'minimal' | 'low' | 'medium' | 'high' | 'xhigh'; toolsMode?: 'dynamic' | 'mcp'; onProtocolEvent?: (method: string) => void; onErrorInfo?: (info: CodexErrorInfo) => void }
export class CodexRuntime implements RuntimeAdapter {
  private rpc?: CodexRpc;
  private threadId?: string;
  private turnId?: string;
  private stopRequested = false;
  private context?: RuntimeContext;
  private pendingInputs: string[] = [];
  constructor(private readonly options: CodexOptions = {}) {}
  supportsVision(): boolean { return false; }
  async execute(context: RuntimeContext): Promise<RuntimeResult> {
    checkAbort(context.signal);
    this.context = context; this.stopRequested = false;
    const command = this.options.command ?? 'codex';
    if (this.options.args === undefined) await verifyManagedCli(command);
    const args = this.options.args ?? await managedCodexArgs({ cwd: context.cwd });
    checkAbort(context.signal);
    const rpc = this.rpc = new CodexRpc(command, args, this.options.timeoutMs, this.options.env);
    let initialized = false;
    let text = '';
    let resolveDone!: (result: RuntimeResult) => void, rejectDone!: (error: Error) => void;
    const done = new Promise<RuntimeResult>((resolve, reject) => { resolveDone = resolve; rejectDone = reject; });
    // Attach rejection handling immediately; startup may still be awaiting an RPC.
    void done.catch(() => undefined);
    const timer = setTimeout(() => rejectDone(new Error('codex_run_timeout')), this.options.maxRunMs ?? 3_600_000);
    const onAbort = () => { void this.stop(); rejectDone(abortError()); };
    context.signal.addEventListener('abort', onAbort, { once: true });
    rpc.on('exited', () => rejectDone(new Error('codex_process_exited')));
    rpc.on('notification', (message: RpcMessage) => {
      this.options.onProtocolEvent?.(message.method ?? 'unknown_notification');
      const params = message.params ?? {};
      if (params.threadId && this.threadId && params.threadId !== this.threadId) return;
      if (message.method === 'error') {
        const info = safeCodexError(params);
        this.options.onErrorInfo?.(info);
        if (!info.will_retry) rejectDone(new Error(`codex_error:${info.code}${info.http_status === null ? '' : `:http_${info.http_status}`}`));
      }
      if (message.method === 'turn/started') this.turnId = String((params.turn as Obj | undefined)?.id ?? '');
      if (message.method === 'item/agentMessage/delta') text += String(params.delta ?? '');
      if (message.method === 'item/started') {
        const item = params.item as Obj | undefined;
        void context.emit({ type: 'progress', summary: `Codex: ${String(item?.type ?? '正在执行')}` });
      }
      if (message.method === 'item/completed') {
        const item = params.item as Obj | undefined;
        if (item?.type === 'agentMessage' && typeof item.text === 'string') text = item.text;
      }
      if (message.method === 'thread/tokenUsage/updated') {
        const tokenUsage = params.tokenUsage as Obj | undefined;
        // last is the last turn; total is cumulative and must not be counted on each update.
        const usage = (tokenUsage?.last ?? {}) as Obj;
        if (Object.keys(usage).length) {
          const value = (key: string) => typeof usage[key] === 'number' ? usage[key] as number : null;
          const sample: UsageSample = { request_key: `codex:${this.threadId}:${String(params.turnId ?? this.turnId)}`, input_tokens: value('inputTokens'), cached_input_tokens: value('cachedInputTokens'), output_tokens: value('outputTokens'), reasoning_tokens: value('reasoningOutputTokens') };
          void context.emit({ type: 'usage', usage: sample });
          const budgetStop = context.budget?.noteUsage?.(sample);
          // The current Codex turn may already be in flight. Interrupt it; do not claim the sample itself was prevented.
          if (budgetStop) { void this.stop(); rejectDone(new Error(`budget_stop:${budgetStop}`)); }
        }
      }
      if (message.method === 'turn/completed') {
        const turn = params.turn as Obj | undefined;
        if (turn?.status === 'completed') resolveDone({ text, binding: { thread_id: this.threadId ?? '', turn_id: this.turnId ?? '' } });
        else if (turn?.status === 'interrupted') rejectDone(abortError());
        else rejectDone(new Error(`codex_turn_failed:${safeCodexError({ error: turn?.error }).code}`));
      }
    });
    rpc.on('request', (message: RpcMessage) => { this.options.onProtocolEvent?.(message.method ?? 'unknown_request'); void this.handleRequest(message, context).catch(error => { if (message.id !== undefined) rpc.reply(message.id, { success: false, contentItems: [{ type: 'inputText', text: (error as Error).message }] }); }); });
    try {
      await rpc.request('initialize', { clientInfo: { name: 'super-agent-node', title: 'Personal Super-agent', version: '0.1.0' }, capabilities: { experimentalApi: true } });
      initialized = true;
      this.options.onProtocolEvent?.('initialize/completed');
      rpc.notify('initialized');
      const config: Obj = {};
      const params: Obj = { cwd: context.cwd, approvalPolicy: 'never', sandbox: this.options.sandbox ?? 'workspace-write', model: context.modelId || undefined,
        developerInstructions: `You are a local worker for the user's explicitly authorized task. Do not read or export model credentials, cookies or other secrets. Use the provided browser tools for browser operations so progress and control remain observable. Search memory before unfamiliar work. Stop at task scope boundaries. ${context.developerInstructions ?? ''}`, serviceName: 'personal-super-agent' };
      if (this.options.toolsMode === 'mcp' && context.mcp) {
        config['mcp_servers.super_agent'] = { enabled: true, command: process.execPath, args: [context.mcp.script], env: { SUPER_AGENT_TOOL_URL: context.mcp.url, SUPER_AGENT_TOOL_TOKEN: context.mcp.token }, required: true };
        params.config = config;
      } else {
        params.dynamicTools = context.tools.map(tool => ({ name: tool.name, description: tool.description, inputSchema: tool.parameters }));
      }
      const result = await rpc.request<{ thread: { id: string } }>('thread/start', params);
      this.threadId = result.thread.id;
      this.options.onProtocolEvent?.('thread/start/completed');
      await context.emit({ type: 'binding', binding: { thread_id: this.threadId } });
      checkAbort(context.signal);
      const prompt = context.checkpoint ? `${context.goal}\n\nContinue only unfinished work. Checkpoint:\n${JSON.stringify(context.checkpoint)}` : context.goal;
      context.budget?.beforeModelCall();
      const started = await rpc.request<{ turn: { id: string } }>('turn/start', { threadId: this.threadId, input: [{ type: 'text', text: prompt }], ...(this.options.reasoningEffort ? { effort: this.options.reasoningEffort } : {}) });
      this.turnId = started.turn.id;
      this.options.onProtocolEvent?.('turn/start/completed');
      for (const input of this.pendingInputs.splice(0)) await this.steer(input);
      if (this.stopRequested) await this.stop();
      return await done;
    } catch (error) { if (!initialized && this.options.args === undefined) throw new Error(managedCompatibilityMessage); throw error; }
    finally { clearTimeout(timer); context.signal.removeEventListener('abort', onAbort); await rpc.close(); this.rpc = undefined; }
  }
  private async handleRequest(message: RpcMessage, context: RuntimeContext): Promise<void> {
    const params = message.params ?? {}, id = message.id!;
    if (message.method === 'item/tool/call') {
      const result = await context.executeTool(String(params.tool ?? params.name), (params.arguments ?? {}) as Obj);
      this.rpc?.reply(id, { success: true, contentItems: [{ type: 'inputText', text: JSON.stringify(result) }] });
    } else if (message.method === 'item/tool/requestUserInput' || message.method === 'tool/requestUserInput') {
      const answers: Obj = {};
      for (const question of (params.questions ?? []) as Obj[]) {
        const result = await context.executeTool('question_ask', { text: String(question.question ?? question.header ?? '需要你的决定'), options: ((question.options ?? []) as Obj[]).map(o => String(o.label ?? o.description ?? '')) });
        answers[String(question.id)] = { answers: [String((result as Obj).answer ?? '')] };
      }
      this.rpc?.reply(id, { answers });
    } else if (message.method?.includes('requestApproval')) {
      // Native unexpected approval cannot silently extend an existing task.
      const result = await context.executeTool('question_ask', { text: `Codex 请求额外授权：${String(params.reason ?? params.command ?? message.method)}`, options: ['拒绝', '允许此次操作'] });
      const answer = String((result as Obj).answer ?? '');
      this.rpc?.reply(id, { decision: /允许|allow|accept/i.test(answer) ? 'accept' : 'decline' });
    } else this.rpc?.reply(id, { action: 'decline', content: null });
  }
  async steer(text: string): Promise<void> {
    if (!this.rpc || !this.threadId || !this.turnId) { this.pendingInputs.push(text); return; }
    await this.rpc.request('turn/steer', { threadId: this.threadId, expectedTurnId: this.turnId, input: [{ type: 'text', text }] });
  }
  async stop(): Promise<void> {
    if (this.stopRequested) return;
    this.stopRequested = true;
    if (this.rpc && this.threadId && this.turnId) await Promise.race([this.rpc.request('turn/interrupt', { threadId: this.threadId, turnId: this.turnId }).catch(() => undefined), sleep(2000)]);
  }
}
