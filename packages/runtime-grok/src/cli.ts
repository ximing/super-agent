import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { startRuntimeToolBridge } from '@super-agent/tool-broker';
import { checkAbort, abortError, type RuntimeAdapter, type RuntimeContext, type RuntimeResult } from '@super-agent/tool-broker/runtime';
import { AcpClient, initializeParams, type Json } from './acp.js';
import { managedArgs, managedProfile, prepareManagedHome } from './managed.js';

export interface GrokCliDiagnostic { phase: 'spawn' | 'initialize' | 'authenticate' | 'session_new' | 'verify_mcp' | 'prompt' | 'completed' | 'notification' | 'client_request'; kind?: 'permission' | 'filesystem' | 'terminal' | 'other' | 'agent_message_chunk' | 'agent_thought_chunk' | 'tool_call' | 'tool_call_update' | 'usage_update'; tool?: string }
export interface GrokCliOptions { command?: string; timeoutMs?: number; maxRunMs?: number; authPath?: string; onDiagnostic?: (diagnostic: GrokCliDiagnostic) => void }
const compatibleVersion = (init: Json) => (init.agentInfo?.version ?? init._meta?.agentVersion) === '1.0.89';
const number = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;

/** Official Grok Build ACP adapter; uses the local login, never a copied bearer or the control server. */
export class GrokCliRuntime implements RuntimeAdapter {
  private client?: AcpClient;
  private sessionId?: string;
  private controller?: AbortController;
  private queued: string[] = [];
  constructor(private readonly options: GrokCliOptions = {}) {}
  supportsVision(): boolean { return false; }
  async execute(context: RuntimeContext): Promise<RuntimeResult> {
    checkAbort(context.signal);
    this.controller = new AbortController();
    const signal = AbortSignal.any([context.signal, this.controller.signal, AbortSignal.timeout(this.options.maxRunMs ?? 60 * 60_000)]);
    const managed = await prepareManagedHome({ authPath: this.options.authPath });
    let bridge: Awaited<ReturnType<typeof startRuntimeToolBridge>> | undefined;
    let client: AcpClient | undefined;
    let events = Promise.resolve(), text = '';
    let promptUsageKey: string | undefined, usageRecorded = false;
    const reportUsage = async (meta: Json = {}) => {
      if (!promptUsageKey || usageRecorded) return;
      usageRecorded = true;
      const sample = { request_key: promptUsageKey, input_tokens: number(meta.inputTokens), cached_input_tokens: number(meta.cachedReadTokens), output_tokens: number(meta.outputTokens), reasoning_tokens: number(meta.reasoningTokens) };
      await context.emit({ type: 'usage', usage: sample });
      context.budget?.noteUsage?.(sample);
    };
    const enqueue = (fn: () => void | Promise<void>) => { events = events.then(fn); events.catch(() => {}); };
    const onAbort = () => { if (this.sessionId) client?.notify('session/cancel', { sessionId: this.sessionId }); void client?.close(); };
    try {
      bridge = await startRuntimeToolBridge({ ...context, signal });
      await managed.configureBridge({ command: process.execPath, script: fileURLToPath(import.meta.resolve('@super-agent/tool-broker/mcp')), url: bridge.url, token: bridge.token });
      this.options.onDiagnostic?.({ phase: 'spawn' });
      this.client = client = new AcpClient(this.options.command ?? 'grok', [...managedArgs], managed.env, managed.cwd);
      signal.addEventListener('abort', onAbort, { once: true }); checkAbort(signal);
      client.onClientRequest = kind => this.options.onDiagnostic?.({ phase: 'client_request', kind });
      client.onNotification = (method, params) => {
        if (method !== 'session/update' || params.sessionId !== this.sessionId) return;
        const update = params.update ?? {};
        if (['agent_message_chunk', 'agent_thought_chunk', 'tool_call', 'tool_call_update', 'usage_update'].includes(update.sessionUpdate)) {
          const name = update._meta?.['x.ai/tool']?.name;
          const tool = ['search_tool', 'use_tool', ...context.tools.map(t => `super_agent__${t.name}`)].includes(name) ? name : 'unknown';
          this.options.onDiagnostic?.({ phase: 'notification', kind: update.sessionUpdate, ...(['tool_call', 'tool_call_update'].includes(update.sessionUpdate) ? { tool } : {}) });
        }
        if (update.sessionUpdate === 'agent_message_chunk' && update.content?.type === 'text') {
          text += String(update.content.text ?? '');
          if (text.length > 1_000_000) { this.controller?.abort(); return; }
        }
        if (update.sessionUpdate === 'tool_call') text = ''; // Return the final answer, excluding narration before the next tool round.
        if (update.sessionUpdate === 'tool_call') enqueue(() => context.emit({ type: 'progress', summary: 'Grok 正在调用受管工具' }));
      };
      this.options.onDiagnostic?.({ phase: 'initialize' });
      const init = await client.request('initialize', initializeParams(), this.options.timeoutMs);
      if (!compatibleVersion(init)) throw Error('grok_cli_version_incompatible');
      if (init.protocolVersion !== 1 || !Array.isArray(init.authMethods) || !init.authMethods.some((method: Json) => method.id === 'cached_token')) throw Error('grok_cli_protocol_incompatible');
      this.options.onDiagnostic?.({ phase: 'authenticate' });
      await client.request('authenticate', { methodId: 'cached_token', _meta: { headless: true } }, this.options.timeoutMs);
      this.options.onDiagnostic?.({ phase: 'session_new' });
      const result = await client.request('session/new', { cwd: managed.cwd, mcpServers: [{ name: 'super_agent', command: process.execPath, args: [fileURLToPath(import.meta.resolve('@super-agent/tool-broker/mcp'))], env: [{ name: 'SUPER_AGENT_TOOL_URL', value: bridge.url }, { name: 'SUPER_AGENT_TOOL_TOKEN', value: bridge.token }] }], _meta: { sessionKind: 'headless', agentProfile: managedProfile, ...(context.modelId && context.modelId !== 'configured-default' ? { modelId: context.modelId } : {}), systemPromptOverride: `You are a managed local assistant. Perform only the user's authorized goal through the super_agent tools. Never use native filesystem, shell, browser, plugins, or external MCP servers. Search user memory for unfamiliar company work; ask when required information or scope is missing. ${context.developerInstructions ?? ''}` } }, this.options.timeoutMs);
      if (typeof result.sessionId !== 'string') throw Error('grok_cli_session_missing');
      this.sessionId = result.sessionId;
      if (context.modelId && context.modelId !== 'configured-default') await client.request('session/set_config_option', { sessionId: this.sessionId, configId: 'model', value: { value: context.modelId } }, this.options.timeoutMs);
      // ACP merges client and configured servers. An isolated home is necessary; also verify the effective catalog before sending any prompt.
      this.options.onDiagnostic?.({ phase: 'verify_mcp' });
      const catalogResponse = await client.request('_x.ai/mcp/list', { sessionId: this.sessionId }, this.options.timeoutMs);
      const catalog = catalogResponse.result ?? catalogResponse;
      if (!Array.isArray(catalog.servers) || catalog.servers.some((server: Json) => server.name !== 'super_agent')) throw Error('grok_cli_unmanaged_mcp_detected');
      if (!catalog.servers.some((server: Json) => server.name === 'super_agent')) throw Error('grok_cli_managed_mcp_missing');
      await context.emit({ type: 'binding', binding: { session_id: this.sessionId } });
      for (const input of this.queued.splice(0)) await this.steer(input);
      const prompt = context.checkpoint ? `${context.goal}\nCheckpoint: ${JSON.stringify(context.checkpoint)}\nVerify current state before continuing unfinished work.` : context.goal;
      // The CLI owns its inner sampling loop. This checks the grant once before the prompt; it does not preempt each hidden round.
      context.budget?.beforeModelCall();
      this.options.onDiagnostic?.({ phase: 'prompt' });
      const response = await client.request('session/prompt', { sessionId: this.sessionId, prompt: [{ type: 'text', text: prompt }] }, this.options.maxRunMs ?? 60 * 60_000, () => { promptUsageKey = `grok-cli:${randomUUID()}`; });
      await reportUsage(response._meta ?? {});
      await events; checkAbort(signal);
      if (response.stopReason !== 'end_turn') throw Error(response.stopReason === 'cancelled' ? 'grok_cli_cancelled' : 'grok_cli_turn_incomplete');
      this.options.onDiagnostic?.({ phase: 'completed' });
      await context.emit({ type: 'message', text });
      return { text, binding: { session_id: this.sessionId } };
    } catch (error) {
      // A written prompt may have consumed provider resources even when the reply/usage was lost.
      // Initialization/authentication failures have no prompt key and never create a billable attempt.
      await reportUsage();
      if (signal.aborted) throw abortError(); throw error;
    }
    finally { signal.removeEventListener('abort', onAbort); await client?.close(); await bridge?.close(); await managed.close(); this.client = undefined; this.sessionId = undefined; }
  }
  async steer(text: string): Promise<void> {
    if (!this.client || !this.sessionId) { this.queued.push(text); return; }
    await this.client.request('_x.ai/interject', { sessionId: this.sessionId, text, interjectionId: randomUUID() }, this.options.timeoutMs);
  }
  async stop(): Promise<void> { this.controller?.abort(); }
}

/** No prompt/model turn. A readable owner-only local login and official ACP cached-token support are required. */
export async function probeGrokCli(command = 'grok'): Promise<{ ready: boolean; models: string[]; reason?: string; version?: string }> {
  let managed: Awaited<ReturnType<typeof prepareManagedHome>> | undefined, client: AcpClient | undefined;
  try {
    managed = await prepareManagedHome(); client = new AcpClient(command, [...managedArgs], managed.env, managed.cwd);
    const result = await client.request('initialize', initializeParams(), 20_000);
    if (!compatibleVersion(result)) return { ready: false, models: [], reason: 'grok_cli_version_incompatible' };
    if (result.protocolVersion !== 1 || !result.authMethods?.some((m: Json) => m.id === 'cached_token')) return { ready: false, models: [], reason: 'grok_cli_protocol_incompatible' };
    try { await client.request('authenticate', { methodId: 'cached_token', _meta: { headless: true } }, 20_000); }
    catch { return { ready: false, models: [], reason: 'grok_cli_local_login_unavailable' }; }
    const rawVersion = result.agentInfo?.version ?? result._meta?.agentVersion;
    return { ready: true, models: ['configured-default'], ...(typeof rawVersion === 'string' && /^[\w.+-]{1,40}$/.test(rawVersion) ? { version: rawVersion } : {}) };
  } catch (error) { return { ready: false, models: [], reason: error instanceof Error && /^grok_cli_[a-z_]+$/.test(error.message) ? error.message : 'grok_cli_unavailable' }; }
  finally { await client?.close(); await managed?.close(); }
}
