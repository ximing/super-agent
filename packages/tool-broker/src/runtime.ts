export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}
export interface UsageSample {
  request_key: string;
  input_tokens: number | null;
  cached_input_tokens: number | null;
  output_tokens: number | null;
  reasoning_tokens: number | null;
  cost_ticks?: string;
}
export type RuntimeEvent =
  | { type: 'progress'; summary: string }
  | { type: 'message'; text: string }
  | { type: 'usage'; usage: UsageSample }
  | { type: 'binding'; binding: Record<string, string> }
  | { type: 'question'; text: string; options?: string[] };
export interface RuntimeContext {
  runId: string;
  taskId: string;
  goal: string;
  modelId: string;
  cwd: string;
  checkpoint?: Record<string, unknown> | null;
  tools: ToolDefinition[];
  executeTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  emit: (event: RuntimeEvent) => void | Promise<void>;
  signal: AbortSignal;
  mcp?: { url: string; token: string; script: string };
  developerInstructions?: string;
}
export interface RuntimeResult { text: string; binding?: Record<string, string> }
export interface RuntimeAdapter {
  execute(context: RuntimeContext): Promise<RuntimeResult>;
  steer(text: string): Promise<void>;
  stop(): Promise<void>;
}
export function abortError(): Error { return new DOMException('Execution stopped', 'AbortError'); }
export function checkAbort(signal: AbortSignal): void { if (signal.aborted) throw abortError(); }
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(abortError()); return; }
    const timer = setTimeout(() => { cleanup(); resolve(); }, ms);
    const onAbort = () => { clearTimeout(timer); cleanup(); reject(abortError()); };
    const cleanup = () => signal?.removeEventListener('abort', onAbort);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
