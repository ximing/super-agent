import { randomUUID } from 'node:crypto';
import type { RuntimeAdapter, RuntimeContext, RuntimeResult } from '@super-agent/tool-broker/runtime';
import { checkAbort, sleep } from '@super-agent/tool-broker/runtime';
type Obj = Record<string, unknown>;
export interface GrokOptions { apiKey: string; baseUrl?: string; fetcher?: typeof fetch; maxRounds?: number; maxOutputTokens?: number; requestTimeoutMs?: number }

/** Direct local API loop. The control server never sees the API key or proxies this request. */
export class GrokRuntime implements RuntimeAdapter {
  private controller?: AbortController;
  private queuedInputs: string[] = [];
  constructor(private readonly options: GrokOptions) {
    if (!options.apiKey) throw new Error('Grok API key is not configured on this computer');
    const url = new URL(options.baseUrl ?? 'https://api.x.ai/v1');
    if (url.protocol !== 'https:' && !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) throw new Error('Provider URL must use HTTPS');
  }
  supportsVision(): boolean { return Boolean(this.options.apiKey); }
  async execute(context: RuntimeContext): Promise<RuntimeResult> {
    checkAbort(context.signal);
    this.controller = new AbortController();
    const signal = AbortSignal.any([context.signal, this.controller.signal]);
    const fetcher = this.options.fetcher ?? fetch;
    const goalText = context.checkpoint ? `${context.goal}\nCheckpoint: ${JSON.stringify(context.checkpoint)}\nContinue unfinished steps, verify current environment before acting.` : context.goal;
    const images = (context.images ?? []).filter(image => typeof image.data_base64 === 'string' && image.data_base64.length > 0);
    const userContent = images.length
      ? [{ type: 'input_text', text: goalText }, ...images.map(image => ({ type: 'input_image', image_url: `data:${image.media_type || 'image/png'};base64,${image.data_base64}` }))]
      : goalText;
    const input: Obj[] = [{ role: 'system', content: `You are a local worker for the user's task. Use tools to perform authorized work, search memory for unfamiliar sites, and ask only for missing information or expanded scope. Do not read/export credentials. ${context.developerInstructions ?? ''}` },
      { role: 'user', content: userContent }];
    let previous: string | undefined;
    for (let round = 0; round < (this.options.maxRounds ?? 80); round++) {
      checkAbort(signal);
      context.budget?.beforeModelCall();
      for (const text of this.queuedInputs.splice(0)) input.push({ role: 'user', content: text });
      await context.emit({ type: 'progress', summary: `Grok 正在处理第 ${round + 1} 轮` });
      const vision = images.length > 0;
      const body: Obj = { model: context.modelId, input: !vision && previous ? input.splice(0) : input, tools: context.tools.map(t => ({ type: 'function', name: t.name, description: t.description, parameters: t.parameters })), max_output_tokens: this.options.maxOutputTokens ?? 4096, store: !vision };
      if (!vision && previous) body.previous_response_id = previous;
      let response: Obj;
      // One flag per logical round. Set inside request() only after the pre-send abort check.
      const roundAttempt = { sent: false };
      try { response = await this.request(fetcher, body, signal, roundAttempt); }
      catch (error) {
        if (roundAttempt.sent) {
          // The provider may still bill this in-flight call. One accounting attempt, not a provider-account hard cap. Missing cost_ticks means unavailable, not zero.
          const failed = { request_key: `xai:attempt:${context.runId}:${round}`, input_tokens: null, cached_input_tokens: null, output_tokens: null, reasoning_tokens: null, occurred_at: new Date().toISOString() };
          await context.emit({ type: 'usage', usage: failed });
          context.budget?.noteUsage?.(failed);
        }
        throw error;
      }
      const responseId = typeof response.id === 'string' ? response.id : `local-${randomUUID()}`;
      await context.emit({ type: 'binding', binding: { response_id: responseId } });
      const usage = (response.usage ?? {}) as Obj;
      const inputDetails = (usage.input_tokens_details ?? usage.prompt_tokens_details ?? {}) as Obj;
      const outputDetails = (usage.output_tokens_details ?? usage.completion_tokens_details ?? {}) as Obj;
      const n = (value: unknown) => typeof value === 'number' && Number.isFinite(value) ? value : null;
      const sample = { request_key: `xai:${responseId}`, input_tokens: n(usage.input_tokens ?? usage.prompt_tokens), cached_input_tokens: n(inputDetails.cached_tokens), output_tokens: n(usage.output_tokens ?? usage.completion_tokens), reasoning_tokens: n(outputDetails.reasoning_tokens), ...(usage.cost_in_usd_ticks === undefined ? {} : { cost_ticks: String(usage.cost_in_usd_ticks) }) };
      await context.emit({ type: 'usage', usage: sample });
      const budgetStop = context.budget?.noteUsage?.(sample);
      const outputs = (response.output ?? []) as Obj[];
      const calls = outputs.filter(o => o.type === 'function_call');
      if (!calls.length) {
        const text = outputs.filter(o => o.type === 'message').flatMap(o => (o.content ?? []) as Obj[]).filter(c => c.type === 'output_text').map(c => String(c.text ?? '')).join('\n') || String(response.output_text ?? '');
        if (!text && response.status === 'incomplete') throw new Error('grok_output_incomplete');
        await context.emit({ type: 'message', text }); return { text, binding: { response_id: responseId } };
      }
      if (budgetStop) throw new Error(`budget_stop:${budgetStop}`);
      previous = vision ? undefined : (typeof response.id === 'string' ? response.id : undefined);
      // The first input array is retained only for fallback if a provider omits response IDs.
      if (previous) input.length = 0; else input.push(...outputs);
      for (const call of calls) {
        checkAbort(signal);
        let result: unknown;
        try {
          const args = typeof call.arguments === 'string' ? JSON.parse(call.arguments) as Obj : call.arguments as Obj;
          if (!args || Array.isArray(args) || typeof args !== 'object') throw new Error('invalid_tool_arguments');
          result = await context.executeTool(String(call.name), args);
        } catch (error) {
          if (signal.aborted) throw error;
          result = { error: (error as Error).message };
        }
        input.push({ type: 'function_call_output', call_id: String(call.call_id), output: JSON.stringify(result) });
      }
    }
    throw new Error('grok_round_limit_reached');
  }
  private async request(fetcher: typeof fetch, body: Obj, signal: AbortSignal, roundAttempt: { sent: boolean }): Promise<Obj> {
    const url = `${(this.options.baseUrl ?? 'https://api.x.ai/v1').replace(/\/$/, '')}/responses`;
    for (let attempt = 0; attempt < 4; attempt++) {
      checkAbort(signal);
      const payload = JSON.stringify(body);
      const outbound = AbortSignal.any([signal, AbortSignal.timeout(this.options.requestTimeoutMs ?? 120_000)]);
      checkAbort(signal);
      roundAttempt.sent = true;
      const response = await fetcher(url, { method: 'POST', headers: { authorization: `Bearer ${this.options.apiKey}`, 'content-type': 'application/json' }, body: payload, signal: outbound });
      if ((response.status === 429 || response.status >= 500) && attempt < 3) { await response.body?.cancel(); await sleep(Math.min(20_000, 1000 * 2 ** attempt), signal); continue; }
      if (!response.ok) {
        await response.body?.cancel();
        // Do not upload provider response bodies; they can echo credentials or user content.
        throw new Error(`grok_http_${response.status}`);
      }
      return await response.json() as Obj;
    }
    throw new Error('grok_retry_exhausted');
  }
  async steer(text: string): Promise<void> { this.queuedInputs.push(text); }
  async stop(): Promise<void> { this.controller?.abort(); }
}

export { GrokCliRuntime, probeGrokCli, type GrokCliOptions, type GrokCliDiagnostic } from './cli.js';
