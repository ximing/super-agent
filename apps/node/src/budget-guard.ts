import { DEFAULT_BUDGET_LIMITS, type BudgetCategory, type RuntimeBudgetLimits, type BudgetStopReason } from '@super-agent/protocol';
import type { UsageSample } from '@super-agent/tool-broker';

export class BudgetStop extends Error {
  constructor(public readonly reason: BudgetStopReason) { super(`budget_stop:${reason}`); this.name = 'BudgetStop'; }
}

export function limitsFor(category: BudgetCategory, override?: Partial<RuntimeBudgetLimits> | null): RuntimeBudgetLimits {
  const base = DEFAULT_BUDGET_LIMITS[category];
  const cap = (key: keyof RuntimeBudgetLimits) => {
    const value = Number(override?.[key]);
    return Number.isSafeInteger(value) && value > 0 ? Math.min(base[key], value) : base[key];
  };
  return { max_total_tokens: cap('max_total_tokens'), max_model_calls: cap('max_model_calls'), max_tool_steps: cap('max_tool_steps'), max_runtime_ms: cap('max_runtime_ms') };
}

/** Limits are this activity's remaining allowance (historical task spend already subtracted). Stopping applies before the next controllable call. An in-flight provider request is not a provider-account hard cap. */
export class BudgetGuard {
  calls = 0; tools = 0; inputTokens = 0; outputTokens = 0; exceeded: BudgetStopReason | null = null;
  private readonly seen = new Map<string, { input: number; output: number }>();
  constructor(private readonly limits: RuntimeBudgetLimits, private readonly startedAt = Date.now()) {}
  private decide(now = Date.now()): BudgetStopReason | null {
    if (this.exceeded) return this.exceeded;
    if (now - this.startedAt >= this.limits.max_runtime_ms) return 'time_limit';
    if (this.calls >= this.limits.max_model_calls) return 'model_call_limit';
    if (this.tools >= this.limits.max_tool_steps) return 'tool_step_limit';
    if (this.inputTokens + this.outputTokens >= this.limits.max_total_tokens) return 'token_limit';
    return null;
  }
  beforeModelCall(now = Date.now()): void {
    const reason = this.decide(now);
    if (reason) throw new BudgetStop(reason);
    this.calls += 1;
  }
  beforeToolCall(now = Date.now()): void {
    const reason = this.decide(now);
    if (reason) throw new BudgetStop(reason);
    this.tools += 1;
  }
  noteUsage(usage: UsageSample, now = Date.now()): BudgetStopReason | null {
    const prior = this.seen.get(usage.request_key) ?? { input: 0, output: 0 };
    const input = Math.max(prior.input, usage.input_tokens ?? 0), output = Math.max(prior.output, usage.output_tokens ?? 0);
    this.inputTokens += input - prior.input; this.outputTokens += output - prior.output;
    this.seen.set(usage.request_key, { input, output });
    this.exceeded = this.decide(now);
    return this.exceeded;
  }
}
