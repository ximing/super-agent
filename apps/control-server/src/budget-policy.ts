import { Decimal } from 'decimal.js';
import { BUDGET_IN_FLIGHT_BOUNDARY, BUDGET_LIMIT_CEILING, BUDGET_LIMIT_KEYS, BUDGET_RECOVERY, DEFAULT_BUDGET_LIMITS, type BudgetCategory, type BudgetLimitKey, type BudgetStopReason, type BudgetWriteMode, type RuntimeBudgetLimits } from '@super-agent/protocol';
import { accumulatedStop, dollarAdmission, publicGrant, usageByCategory, usageTotals, type BudgetUsage } from './budget-control.js';
import { ApiError, type Doc } from './store.js';

const LIMIT_KEYS = ['max_total_tokens', 'max_model_calls', 'max_tool_steps', 'max_runtime_ms'] as const;
const CATEGORIES: BudgetCategory[] = ['worker', 'assistant', 'review', 'proactive'];

export function isBudgetCategory(value: unknown): value is BudgetCategory {
  return CATEGORIES.includes(value as BudgetCategory);
}

/** A partial override is stored as given. Values outside the product ceiling are rejected by the caller. */
export function sanitizeLimits(input: unknown): Partial<RuntimeBudgetLimits> | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const source = input as Record<string, unknown>;
  const out: Partial<RuntimeBudgetLimits> = {};
  for (const key of LIMIT_KEYS) {
    if (source[key] === undefined || source[key] === null) continue;
    const value = Number(source[key]);
    if (!Number.isSafeInteger(value) || value < 1 || value > BUDGET_LIMIT_CEILING[key]) return null;
    out[key] = value;
  }
  return Object.keys(out).length ? out : null;
}

export function sanitizeCategoryLimits(input: unknown): Partial<Record<BudgetCategory, Partial<RuntimeBudgetLimits>>> | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const source = input as Record<string, unknown>;
  const out: Partial<Record<BudgetCategory, Partial<RuntimeBudgetLimits>>> = {};
  for (const category of CATEGORIES) {
    if (source[category] === undefined) continue;
    const limits = sanitizeLimits(source[category]);
    if (!limits) return null;
    out[category] = limits;
  }
  return out;
}

/** Later layers replace earlier ones. Missing keys keep the previous value. Time is the activity window, not a sum. */
export function configuredLimits(category: BudgetCategory, layers: Array<Partial<RuntimeBudgetLimits> | null | undefined>): RuntimeBudgetLimits {
  const limits = { ...DEFAULT_BUDGET_LIMITS[category] };
  for (const layer of layers) {
    if (!layer) continue;
    for (const key of LIMIT_KEYS) {
      const value = Number(layer[key]);
      if (Number.isSafeInteger(value) && value > 0) limits[key] = Math.min(BUDGET_LIMIT_CEILING[key], value);
    }
  }
  return limits;
}

export function stepsFor(steps: Doc[], category: string): Doc[] {
  return steps.filter(step => {
    const value = step.category;
    if (value === undefined || value === null || value === '') return category === 'worker';
    return value === category || (category === 'worker' && value === 'subagent');
  });
}

export function usageStop(limits: RuntimeBudgetLimits, spent: { input_tokens: number; output_tokens: number; model_calls: number; tool_steps: number; started_at: number }): BudgetStopReason | null {
  const calls = accumulatedStop(limits, spent);
  if (calls === 'model_call_limit' || calls === 'token_limit') return calls;
  if (spent.tool_steps >= limits.max_tool_steps) return 'tool_step_limit';
  return null;
}

export function presentGrant(reservation: Doc): Doc {
  return {
    ...publicGrant(reservation),
    ...(reservation.activity_kind ? { activity_kind: reservation.activity_kind } : {}),
    ...(reservation.activity_id ? { activity_id: reservation.activity_id } : {}),
    ...(reservation.task_id ? { task_id: reservation.task_id } : {}),
    run_id: reservation.activity_kind === 'run' ? reservation.run_id ?? null : reservation.run_id ?? null,
    ...(reservation.ceiling ? { ceiling: reservation.ceiling } : {}),
    in_flight_boundary: BUDGET_IN_FLIGHT_BOUNDARY,
  };
}

export function recovery(reason: string): string {
  return BUDGET_RECOVERY[reason as BudgetStopReason] ?? '调整限额或金额上限后可以继续。已经发出的请求仍可能产生用量。';
}

/** Hold is not the measured cost. Null means the price is unknown and must not be added as zero. */
export function holdFor(budget: Doc): { amount: string | null; treatment: 'known' | 'unknown_not_zero' | 'unconfigured' } {
  const monthly = budget.monthly_limit_usd !== null && budget.monthly_limit_usd !== undefined;
  const task = budget.task_limit_usd !== null && budget.task_limit_usd !== undefined;
  if (!monthly && !task) return { amount: '0', treatment: 'unconfigured' };
  if ((budget.unknown_count ?? 0) > 0) return { amount: null, treatment: 'unknown_not_zero' };
  if (task) return { amount: String(budget.task_limit_usd), treatment: 'known' };
  return { amount: null, treatment: 'unknown_not_zero' };
}

export function dollarGate(budget: Doc, reservations: Doc[], amount: string | null, now = Date.now(), activeRunIds: ReadonlySet<string> = new Set()): { ok: boolean; reason: BudgetStopReason | null } {
  const monthly = budget.monthly_limit_usd !== null && budget.monthly_limit_usd !== undefined;
  // A null hold is unknown. Probe with zero only so an existing known hold is still summed;
  // the stored reservation keeps amount null and blocks the next dollar admission.
  if (amount === null && !monthly && budget.task_limit_usd !== '0') return { ok: true, reason: null };
  const decision = dollarAdmission(budget, reservations, amount ?? '0', now, activeRunIds);
  return { ok: decision.ok, reason: (decision.reason as BudgetStopReason | null) ?? null };
}

export function taskDollarStop(budget: Doc, records: Doc[]): BudgetStopReason | null {
  if (budget.task_limit_usd === null || budget.task_limit_usd === undefined) return null;
  if (budget.task_limit_usd === '0') return 'budget_exhausted';
  let known = new Decimal(0);
  let unknown = 0;
  for (const record of records) {
    if (!record.cost || record.cost.amount === null || record.cost.source === 'unavailable') unknown += 1;
    else if (record.cost.currency === 'USD') known = known.plus(record.cost.amount);
  }
  if (unknown > 0) return 'budget_unknown';
  if (known.gte(budget.task_limit_usd)) return 'budget_exhausted';
  return null;
}

export function budgetWriteMode(value: unknown): BudgetWriteMode {
  if (value === undefined || value === 'merge') return 'merge';
  if (value === 'replace') return 'replace';
  throw new ApiError(422, 'invalid_budget', '预算写入模式无效');
}

function readLimitPatch(input: unknown, ignoreForeign: boolean): Partial<Record<BudgetLimitKey, number | null>> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new ApiError(422, 'invalid_budget', '任务用量上限无效');
  const source = input as Record<string, unknown>;
  const patch: Partial<Record<BudgetLimitKey, number | null>> = {};
  let count = 0;
  for (const key of Object.keys(source)) {
    if (!(BUDGET_LIMIT_KEYS as readonly string[]).includes(key)) {
      if (ignoreForeign) continue;
      throw new ApiError(422, 'invalid_budget', '任务用量上限无效');
    }
    count += 1;
    const raw = source[key];
    if (raw === null) { patch[key as BudgetLimitKey] = null; continue; }
    const value = Number(raw);
    if (!Number.isSafeInteger(value) || value < 1 || value > BUDGET_LIMIT_CEILING[key as BudgetLimitKey]) throw new ApiError(422, 'invalid_budget', '任务用量上限无效');
    patch[key as BudgetLimitKey] = value;
  }
  if (!count) throw new ApiError(422, 'invalid_budget', '任务用量上限无效');
  return patch;
}

/** Flat `{ max_model_calls: 2 }` and `{ mode?, limits }` both work. Default mode is merge. */
export function taskBudgetUpdate(body: Doc): { mode: BudgetWriteMode; patch: Partial<Record<BudgetLimitKey, number | null>> } {
  const mode = budgetWriteMode(body.mode);
  if (body.limits !== undefined && (body.limits === null || typeof body.limits !== 'object' || Array.isArray(body.limits))) throw new ApiError(422, 'invalid_budget', '任务用量上限无效');
  return { mode, patch: readLimitPatch(body.limits !== undefined ? body.limits : body, body.limits === undefined) };
}

export function mergeLimitOverride(stored: Partial<RuntimeBudgetLimits> | null | undefined, patch: Partial<Record<BudgetLimitKey, number | null>>, mode: BudgetWriteMode): Partial<RuntimeBudgetLimits> | null {
  const next: Partial<RuntimeBudgetLimits> = {};
  if (mode === 'merge' && stored && typeof stored === 'object' && !Array.isArray(stored)) {
    for (const key of BUDGET_LIMIT_KEYS) {
      const value = Number(stored[key]);
      if (Number.isSafeInteger(value) && value > 0) next[key] = value;
    }
  }
  for (const key of BUDGET_LIMIT_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(patch, key)) continue;
    if (patch[key] === null) delete next[key];
    else next[key] = patch[key] as number;
  }
  return Object.keys(next).length ? next : null;
}

export function mergeCategoryLimits(stored: Partial<Record<BudgetCategory, Partial<RuntimeBudgetLimits>>> | null | undefined, input: unknown, mode: BudgetWriteMode): Partial<Record<BudgetCategory, Partial<RuntimeBudgetLimits>>> | null {
  if (input === null) return null;
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new ApiError(422, 'invalid_budget', '活动用量上限无效');
  const source = input as Record<string, unknown>;
  for (const key of Object.keys(source)) if (!CATEGORIES.includes(key as BudgetCategory)) throw new ApiError(422, 'invalid_budget', '活动用量上限无效');
  const base: Partial<Record<BudgetCategory, Partial<RuntimeBudgetLimits>>> = {};
  if (mode === 'merge' && stored && typeof stored === 'object') {
    for (const category of CATEGORIES) {
      const merged = mergeLimitOverride(stored[category], {}, 'merge');
      if (merged) base[category] = merged;
    }
  }
  for (const category of CATEGORIES) {
    if (!Object.prototype.hasOwnProperty.call(source, category)) continue;
    const raw = source[category];
    if (raw === null) { delete base[category]; continue; }
    const patch = readLimitPatch(raw, false);
    const merged = mergeLimitOverride(mode === 'replace' ? null : base[category], patch, mode === 'replace' ? 'replace' : 'merge');
    if (merged) base[category] = merged;
    else delete base[category];
  }
  return Object.keys(base).length ? base : null;
}

function keptMoney(body: Doc, key: 'monthly_limit_usd' | 'task_limit_usd', stored: unknown): string | null {
  if (!Object.prototype.hasOwnProperty.call(body, key)) return stored == null ? null : requireMoney(stored);
  return requireMoney(body[key]);
}

function requireMoney(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== 'string' || !/^\d+(\.\d{1,10})?$/.test(value) || new Decimal(value).gt('1000000000')) throw new ApiError(422, 'invalid_amount', '金额需要为非负十进制字符串');
  return new Decimal(value).toFixed();
}

/** Omitted money or category fields stay. Explicit null clears that field. Category keys merge unless mode is replace. */
export function nextAccountBudget(stored: Doc, body: Doc): Doc {
  const mode = budgetWriteMode(body.mode);
  const categoryLimits = Object.prototype.hasOwnProperty.call(body, 'category_limits') ? mergeCategoryLimits(stored.category_limits, body.category_limits, mode) : stored.category_limits ?? null;
  return { monthly_limit_usd: keptMoney(body, 'monthly_limit_usd', stored.monthly_limit_usd), task_limit_usd: keptMoney(body, 'task_limit_usd', stored.task_limit_usd), ...(categoryLimits ? { category_limits: categoryLimits } : {}) };
}

export function spendFor(records: Doc[], steps: Doc[], category: string): BudgetUsage {
  return usageTotals(usageByCategory(records, category), stepsFor(steps, category), null);
}
