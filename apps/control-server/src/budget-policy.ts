import { Decimal } from 'decimal.js';
import { BUDGET_IN_FLIGHT_BOUNDARY, BUDGET_LIMIT_CEILING, BUDGET_RECOVERY, DEFAULT_BUDGET_LIMITS, type BudgetCategory, type BudgetStopReason, type RuntimeBudgetLimits } from '@super-agent/protocol';
import { accumulatedStop, dollarAdmission, publicGrant, usageByCategory, usageTotals, type BudgetUsage } from './budget-control.js';
import type { Doc } from './store.js';

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

export function dollarGate(budget: Doc, reservations: Doc[], amount: string | null, now = Date.now()): { ok: boolean; reason: BudgetStopReason | null } {
  const monthly = budget.monthly_limit_usd !== null && budget.monthly_limit_usd !== undefined;
  // A null hold is unknown. Probe with zero only so an existing known hold is still summed;
  // the stored reservation keeps amount null and blocks the next dollar admission.
  if (amount === null && !monthly && budget.task_limit_usd !== '0') return { ok: true, reason: null };
  const decision = dollarAdmission(budget, reservations, amount ?? '0', now);
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

export function reservationProtected(reservation: Doc, activeRun: boolean, assistantLeaseAlive: boolean, now = Date.now()): boolean {
  if (reservation.status !== 'reserved') return false;
  if (Date.parse(reservation.expires_at) > now) return true;
  if ((reservation.activity_kind === 'run' || (!reservation.activity_kind && reservation.run_id)) && activeRun) return true;
  if (['assistant', 'review', 'proactive'].includes(reservation.activity_kind) && assistantLeaseAlive) return true;
  return false;
}

export function spendFor(records: Doc[], steps: Doc[], category: string): BudgetUsage {
  return usageTotals(usageByCategory(records, category), stepsFor(steps, category), null);
}
