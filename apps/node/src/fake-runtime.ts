import type { RuntimeAdapter, RuntimeContext, RuntimeResult } from '@super-agent/tool-broker/runtime';
import { checkAbort, sleep } from '@super-agent/tool-broker/runtime';
/** Explicit integration-test runtime. Never selected unless fake_runtime=true locally. */
export class FakeRuntime implements RuntimeAdapter {
  private stopped = false;
  async execute(context: RuntimeContext): Promise<RuntimeResult> {
    await context.emit({ type: 'progress', summary: '[FakeRuntime 测试] 已开始' });
    await context.executeTool('memory_search', { query: context.goal });
    for (let i = 0; i < 3; i++) { checkAbort(context.signal); if (this.stopped) throw new DOMException('Stopped', 'AbortError'); await sleep(30, context.signal); }
    await context.executeTool('files_write', { path: 'test-result.txt', content: `Explicit FakeRuntime result for: ${context.goal}` });
    await context.emit({ type: 'usage', usage: { request_key: `fake:${context.runId}`, input_tokens: 10, cached_input_tokens: 0, output_tokens: 5, reasoning_tokens: 0 } });
    return { text: `[FakeRuntime 测试完成] ${context.goal}` };
  }
  async steer(_text: string): Promise<void> {}
  async stop(): Promise<void> { this.stopped = true; }
}
