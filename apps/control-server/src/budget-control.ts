import { Decimal } from 'decimal.js';
import { BUDGET_HEARTBEAT_MS, BUDGET_IN_FLIGHT_BOUNDARY, DEFAULT_BUDGET_LIMITS, type ActivityKind, type BudgetCategory, type BudgetStopReason, type RuntimeBudgetLimits } from '@super-agent/protocol';
import type { Doc } from './store.js';

export type { ActivityKind };
export interface BudgetUsage { input_tokens: number; output_tokens: number; model_calls: number; tool_steps: number; started_at: number }
export interface ReservationInput {
  operation_key: string;
  activity_kind: ActivityKind;
  activity_id: string;
  task_id?: string | null;
  run_id?: string | null;
  category: BudgetCategory;
  limits: RuntimeBudgetLimits;
  amount?: string | null;
  expires_at: string;
  money_treatment: string;
}

const TERMINAL_RESERVATION = new Set(['released', 'settled', 'expired']);
const GRANT_FIELDS = ['activity_kind', 'activity_id', 'task_id', 'run_id', 'renewed_at', 'heartbeat_at'] as const;

export function limitsFor(category: BudgetCategory, override?: Doc | null): RuntimeBudgetLimits {
  const base = DEFAULT_BUDGET_LIMITS[category];
  const cap = (key: keyof RuntimeBudgetLimits) => {
    const value = Number(override?.[key]);
    return Number.isSafeInteger(value) && value > 0 ? Math.min(base[key], value) : base[key];
  };
  return { max_total_tokens: cap('max_total_tokens'), max_model_calls: cap('max_model_calls'), max_tool_steps: cap('max_tool_steps'), max_runtime_ms: cap('max_runtime_ms') };
}

export function publicGrant(reservation: Doc): Doc {
  const grant: Doc = {
    grant_id: reservation.id, category: reservation.category ?? 'worker', limits: reservation.limits, money_treatment: reservation.money_treatment ?? 'unconfigured',
    in_flight_boundary: BUDGET_IN_FLIGHT_BOUNDARY, dollar_cap: 'not_enforced', status: reservation.status, expires_at: reservation.expires_at,
  };
  for (const key of GRANT_FIELDS) if (reservation[key] !== undefined) grant[key] = reservation[key];
  return grant;
}

/** Same operation key returns the original hold. Unknown dollars are not inserted as zero. */
export function admitReservation(existing: Doc[], request: Doc): { reservation: Doc; created: boolean } {
  const prior = existing.find(reservation => reservation.operation_key === request.operation_key);
  if (prior) return { reservation: prior, created: false };
  return { reservation: request, created: true };
}

function knownHoldAmount(amount: unknown): string | null {
  if (typeof amount === 'number') return Number.isFinite(amount) ? String(amount) : null;
  if (typeof amount !== 'string' || amount === '') return null;
  try {
    const value = new Decimal(amount);
    return value.isFinite() ? amount : null;
  } catch {
    return null;
  }
}

// Null, missing, or unknown-treatment amounts are not zero-dollar holds.
function unknownHold(reservation: Doc): boolean {
  const treatment = reservation.money_treatment;
  if (typeof treatment === 'string' && treatment.startsWith('unknown')) return true;
  return knownHoldAmount(reservation.amount) == null;
}

export interface ReservationLiveness { activeRunIds: ReadonlySet<string>; now: number }

/** The only in-force rule for admission, task holds, reserved totals, and tick renewal. */
export function reservationInForce(reservation: Doc, liveness: ReservationLiveness): boolean {
  if (reservation.status !== 'reserved') return false;
  const now = liveness.now;
  if (Date.parse(reservation.expires_at) > now) return true;
  const kind = reservation.activity_kind;
  const runId = typeof reservation.run_id === 'string' ? reservation.run_id : '';
  if ((kind === 'run' || (kind == null && runId)) && runId && liveness.activeRunIds.has(runId)) return true;
  if (kind === 'assistant' || kind === 'review' || kind === 'proactive') {
    const beat = Date.parse(reservation.heartbeat_at);
    return Number.isFinite(beat) && now - beat <= BUDGET_HEARTBEAT_MS;
  }
  return false;
}

export function activeHold(reservations: Doc[], now = Date.now(), activeRunIds: ReadonlySet<string> = new Set()): Decimal {
  const liveness = { activeRunIds, now };
  return reservations.reduce((sum: Decimal, reservation) => {
    if (!reservationInForce(reservation, liveness) || unknownHold(reservation)) return sum;
    const amount = knownHoldAmount(reservation.amount);
    return amount == null ? sum : sum.plus(amount);
  }, new Decimal(0));
}

export function dollarAdmission(budget: Doc, reservations: Doc[], nextAmount: string, now = Date.now(), activeRunIds: ReadonlySet<string> = new Set()): { ok: boolean; reason: string | null } {
  if (budget.task_limit_usd === '0' || (nextAmount === '0' && budget.task_limit_usd === '0')) return { ok: false, reason: 'budget_exhausted' };
  if (budget.monthly_limit_usd !== null && budget.monthly_limit_usd !== undefined) {
    const liveness = { activeRunIds, now };
    if ((budget.unknown_count ?? 0) > 0 || reservations.some(reservation => reservationInForce(reservation, liveness) && unknownHold(reservation))) return { ok: false, reason: 'budget_unknown' };
    if (new Decimal(budget.used_usd ?? '0').plus(activeHold(reservations, now, activeRunIds)).plus(nextAmount).gt(budget.monthly_limit_usd)) return { ok: false, reason: 'budget_exhausted' };
  }
  return { ok: true, reason: null };
}

/** Cumulative task usage ignores wall-clock age so an old task is not expired merely by its creation time. */
export function accumulatedStop(limits: RuntimeBudgetLimits, usage: BudgetUsage): string | null {
  if (usage.model_calls >= limits.max_model_calls) return 'model_call_limit';
  if (usage.input_tokens + usage.output_tokens >= limits.max_total_tokens) return 'token_limit';
  return null;
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

export function usageByCategory(records: Doc[], category: string): Doc[] {
  return records.filter(record => record.category === category || (category === 'worker' && record.category === 'subagent'));
}

export function remainingLimits(limits: RuntimeBudgetLimits, spent: BudgetUsage): RuntimeBudgetLimits {
  const used = (value: number) => Number.isFinite(value) ? value : 0;
  return {
    max_total_tokens: Math.max(0, limits.max_total_tokens - (used(spent.input_tokens) + used(spent.output_tokens))),
    max_model_calls: Math.max(0, limits.max_model_calls - used(spent.model_calls)),
    max_tool_steps: Math.max(0, limits.max_tool_steps - used(spent.tool_steps)),
    max_runtime_ms: limits.max_runtime_ms,
  };
}

export function grantBlocked(limits: RuntimeBudgetLimits): BudgetStopReason | null {
  if (limits.max_model_calls <= 0) return 'model_call_limit';
  if (limits.max_total_tokens <= 0) return 'token_limit';
  if (limits.max_tool_steps <= 0) return 'tool_step_limit';
  return null;
}

export function categoryStop(limits: RuntimeBudgetLimits, records: Doc[]): string | null {
  return accumulatedStop(limits, usageTotals(records, [], null));
}

function nullableId(value: string | null | undefined): string | null {
  return typeof value === 'string' ? value : null;
}

export function buildReservation(input: ReservationInput): Doc {
  return {
    operation_key: input.operation_key,
    activity_kind: input.activity_kind,
    activity_id: input.activity_id,
    task_id: nullableId(input.task_id),
    run_id: nullableId(input.run_id),
    category: input.category,
    limits: input.limits,
    amount: typeof input.amount === 'string' ? input.amount : null,
    status: 'reserved',
    expires_at: input.expires_at,
    renewed_at: null,
    heartbeat_at: new Date().toISOString(),
    money_treatment: input.money_treatment,
    late_usage: false,
  };
}

export function renewReservation(existing: Doc, nowIso: string, extendMs: number): Doc {
  return { ...existing, status: 'reserved', renewed_at: nowIso, heartbeat_at: nowIso, expires_at: new Date(Date.parse(nowIso) + extendMs).toISOString() };
}

export function releaseReservation(existing: Doc, status: 'released' | 'settled' | 'expired', nowIso: string): Doc {
  if (TERMINAL_RESERVATION.has(existing.status)) return existing;
  return { ...existing, status, released_at: nowIso };
}

/** Close or expire a hold. Amount is the reservation, never a copy of measured cost. */
export function settleReservation(existing: Doc, linked: Doc[], nowIso: string, closing: 'close' | 'expire'): Doc {
  if (TERMINAL_RESERVATION.has(existing.status)) return existing;
  if (closing === 'expire') return { ...existing, status: 'expired', settlement_state: 'open', released_at: nowIso };
  const unknownCount = linked.filter(row => row?.cost?.amount == null).length;
  if (!linked.length) return { ...existing, status: 'released', settlement_state: 'awaiting_usage', settlement_unknown_count: 0, released_at: nowIso };
  if (unknownCount > 0) return { ...existing, status: 'released', settlement_state: 'unknown', settlement_unknown_count: unknownCount, released_at: nowIso };
  return { ...existing, status: 'settled', settlement_state: 'settled', settlement_unknown_count: 0, released_at: nowIso };
}

export function reservationExpired(existing: Doc, nowMs: number): boolean {
  return existing.status === 'reserved' && Date.parse(existing.expires_at) <= nowMs;
}
