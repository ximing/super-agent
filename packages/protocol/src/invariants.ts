import type { CostSource, RunState } from './index.js';

const transitions: Record<RunState, readonly RunState[]> = {
  created: ['dispatched', 'cancelled', 'failed'],
  dispatched: ['starting', 'lost', 'cancelled', 'failed'],
  starting: ['running', 'stopping', 'failed', 'lost', 'result_unknown'],
  running: ['waiting_input', 'stopping', 'succeeded', 'failed', 'lost', 'result_unknown'],
  waiting_input: ['running', 'stopping', 'failed', 'lost', 'result_unknown'],
  stopping: ['paused', 'cancelled', 'failed', 'lost', 'result_unknown'],
  paused: [], succeeded: [], failed: [], cancelled: [],
  lost: ['paused', 'succeeded', 'failed', 'cancelled', 'result_unknown'],
  result_unknown: ['paused', 'succeeded', 'failed', 'cancelled'],
};

/** Equality permits an idempotent update; callers must still verify ownership and epoch. */
export function canTransitionRun(from: RunState, to: RunState): boolean {
  return from === to || transitions[from].includes(to);
}

/** An offline device is not proof that an in-flight submission did not happen. */
export function canStartReplacement(state: RunState, quiesced: boolean, receiptsKnown: boolean): boolean {
  return quiesced && receiptsKnown && ['paused', 'succeeded', 'failed', 'cancelled'].includes(state);
}

const DECIMAL = /^(0|[1-9]\d*)(?:\.(\d{1,10}))?$/;
const SCALE = 10_000_000_000n;

export function moneyToTicks(value: string): bigint {
  const match = DECIMAL.exec(value);
  if (!match) throw new Error('Money must be a nonnegative decimal string with at most ten decimal places');
  return BigInt(match[1]!) * SCALE + BigInt((match[2] ?? '').padEnd(10, '0'));
}

export function ticksToMoney(value: bigint): string {
  if (value < 0n) throw new Error('Cost cannot be negative');
  const whole = value / SCALE;
  const fraction = (value % SCALE).toString().padStart(10, '0').replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : whole.toString();
}

export interface KnownOrUnknownCost {
  source: CostSource;
  currency: string | null;
  amount: string | null;
}

const MODEL_PROXY_ERROR = 'Model proxy requires an HTTP(S) URL with an explicit port and no credentials, path, query, or SOCKS proxy';

/** The WHATWG parser hides a scheme's default port, so read the port the user actually wrote. */
function writtenModelProxyPort(value: string): string {
  const withScheme = /^https?:\/\//i.test(value) ? value : `http://${value}`;
  const authority = withScheme.slice(withScheme.indexOf('://') + 3).split(/[/?#]/, 1)[0] ?? '';
  if (authority.startsWith('[')) {
    const end = authority.indexOf(']');
    const tail = end >= 0 ? authority.slice(end + 1) : '';
    return tail.startsWith(':') ? tail.slice(1) : '';
  }
  const hostport = authority.slice(authority.lastIndexOf('@') + 1);
  const colon = hostport.lastIndexOf(':');
  return colon >= 0 ? hostport.slice(colon + 1) : '';
}

/** Canonical `http(s)://host:port/` for Grok and Codex. Loopback is dialed by the worker, never rewritten. */
export function normalizeModelProxyUrl(value: string): string {
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 300 || /[\u0000-\u0020]/.test(trimmed)) throw new Error(MODEL_PROXY_ERROR);
  if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed) && !/^https?:\/\//i.test(trimmed)) throw new Error(MODEL_PROXY_ERROR);
  let url: URL;
  try { url = new URL(/^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`); } catch { throw new Error(MODEL_PROXY_ERROR); }
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error(MODEL_PROXY_ERROR);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error(MODEL_PROXY_ERROR);
  const portText = writtenModelProxyPort(trimmed);
  const port = Number(portText);
  if (!url.hostname || !/^\d+$/.test(portText) || !Number.isInteger(port) || port < 1 || port > 65535) throw new Error(MODEL_PROXY_ERROR);
  if (url.port && Number(url.port) !== port) throw new Error(MODEL_PROXY_ERROR);
  return url.port ? url.href : `${url.protocol}//${url.host}:${port}/`;
}

/** Keep currencies and sources separate, and keep unavailable cost out of the zero bucket. */
export function summarizeCosts(records: readonly KnownOrUnknownCost[]) {
  const groups = new Map<string, { currency: string; source: CostSource; ticks: bigint }>();
  let unknown_count = 0;
  for (const cost of records) {
    if (cost.source === 'unavailable' || cost.amount === null || cost.currency === null) {
      unknown_count += 1;
      continue;
    }
    if (!/^[A-Z]{3}$/.test(cost.currency)) throw new Error('Invalid currency');
    const key = `${cost.currency}:${cost.source}`;
    const group = groups.get(key) ?? { currency: cost.currency, source: cost.source, ticks: 0n };
    group.ticks += moneyToTicks(cost.amount);
    groups.set(key, group);
  }
  return {
    totals: [...groups.values()].map(({ currency, source, ticks }) => ({ currency, source, amount: ticksToMoney(ticks) })),
    unknown_count,
    request_count: records.length,
    coverage: records.length ? (records.length - unknown_count) / records.length : 0,
  };
}
