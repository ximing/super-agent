import { Decimal } from 'decimal.js';
import { BUDGET_IN_FLIGHT_BOUNDARY, DEFAULT_BUDGET_LIMITS, type BudgetCategory, type RuntimeBudgetLimits } from '@super-agent/protocol';
import type { Doc } from './store.js';

export interface BudgetUsage { input_tokens: number; output_tokens: number; model_calls: number; tool_steps: number; started_at: number }

export function limitsFor(category: BudgetCategory, override?: Doc | null): RuntimeBudgetLimits {
  const base = DEFAULT_BUDGET_LIMITS[category];
  const cap = (key: keyof RuntimeBudgetLimits) => {
    const value = Number(override?.[key]);
    return Number.isSafeInteger(value) && value > 0 ? Math.min(base[key], value) : base[key];
  };
  return { max_total_tokens: cap('max_total_tokens'), max_model_calls: cap('max_model_calls'), max_tool_steps: cap('max_tool_steps'), max_runtime_ms: cap('max_runtime_ms') };
}

export function publicGrant(reservation: Doc): Doc {
  return {
    grant_id: reservation.id, category: reservation.category ?? 'worker', limits: reservation.limits, money_treatment: reservation.money_treatment ?? 'unconfigured',
    in_flight_boundary: BUDGET_IN_FLIGHT_BOUNDARY, dollar_cap: 'not_enforced', status: reservation.status, expires_at: reservation.expires_at,
  };
}

/** Same operation key returns the original hold. Unknown dollars are not inserted as zero. */
export function admitReservation(existing: Doc[], request: Doc): { reservation: Doc; created: boolean } {
  const prior = existing.find(reservation => reservation.operation_key === request.operation_key);
  if (prior) return { reservation: prior, created: false };
  return { reservation: request, created: true };
}

export function activeHold(reservations: Doc[], now = Date.now()): Decimal {
  return reservations.filter(reservation => reservation.status === 'reserved' && Date.parse(reservation.expires_at) > now).reduce((sum: Decimal, reservation) => sum.plus(String(reservation.amount ?? '0')), new Decimal(0));
}

export function dollarAdmission(budget: Doc, reservations: Doc[], nextAmount: string, now = Date.now()): { ok: boolean; reason: string | null } {
  if (budget.task_limit_usd === '0' || (nextAmount === '0' && budget.task_limit_usd === '0')) return { ok: false, reason: 'budget_exhausted' };
  if (budget.monthly_limit_usd !== null && budget.monthly_limit_usd !== undefined) {
    if ((budget.unknown_count ?? 0) > 0) return { ok: false, reason: 'budget_unknown' };
    if (new Decimal(budget.used_usd ?? '0').plus(activeHold(reservations, now)).plus(nextAmount).gt(budget.monthly_limit_usd)) return { ok: false, reason: 'budget_exhausted' };
  }
  return { ok: true, reason: null };
}

export function evaluateLimits(limits: RuntimeBudgetLimits, usage: BudgetUsage, now = Date.now()): { stop: boolean; reason: string | null } {
  if (now - usage.started_at >= limits.max_runtime_ms) return { stop: true, reason: 'time_limit' };
  if (usage.model_calls >= limits.max_model_calls) return { stop: true, reason: 'model_call_limit' };
  if (usage.tool_steps >= limits.max_tool_steps) return { stop: true, reason: 'tool_step_limit' };
  if (usage.input_tokens + usage.output_tokens >= limits.max_total_tokens) return { stop: true, reason: 'token_limit' };
  return { stop: false, reason: null };
}

export function usageTotals(records: Doc[], steps: Doc[], startedAt: string | null): BudgetUsage {
  const mine = records.filter(record => record.cost);
  return {
    input_tokens: mine.reduce((sum, record) => sum + (Number(record.input_tokens) || 0), 0),
    output_tokens: mine.reduce((sum, record) => sum + (Number(record.output_tokens) || 0), 0),
    model_calls: mine.length,
    tool_steps: steps.length,
    started_at: startedAt ? Date.parse(startedAt) : Date.now(),
  };
}
