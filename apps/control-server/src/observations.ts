import { randomUUID } from 'node:crypto';
import type { TaskStatus } from '@super-agent/protocol';
import { ApiError, type Doc, type Tx } from './store.js';
import { expires, text, uuid } from './auth.js';
import { graphLock } from './team.js';

function engineName(value: unknown): 'codex' | 'grok' {
  if (value !== 'codex' && value !== 'grok') throw new ApiError(422, 'invalid_engine', '执行引擎无效');
  return value;
}

const TASK_STATUSES = new Set<TaskStatus>(['queued', 'blocked', 'running', 'waiting_input', 'waiting_device', 'awaiting_approval', 'pausing', 'paused', 'switching', 'awaiting_review', 'succeeded', 'failed', 'cancelled']);
const DELIVERIES = new Set(['pending', 'accepted', 'rejected', 'needs_input']);
const ONLINE_MS = 30_000;

function sitesOf(value: unknown): string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 20) throw new ApiError(422, 'invalid_observation', '观察规则需要 1 至 20 个网站');
  return [...new Set(value.map(site => text(site, 'site', 253).toLowerCase()))];
}

function projectOf(value: unknown): string | null {
  if (value == null || value === '') return null;
  return text(value, 'project', 128);
}

/** A follow-up task may only see the rule's own project and sites, never global memory. */
export function observationScope(rule: Doc): Doc {
  return { project: rule.project ?? null, sites: [...(rule.sites ?? [])], global_preference: false, statuses: ['verified'], max_version: null };
}

export function observationInput(body: Doc, existing?: Doc | null): Doc {
  const source = body.source ?? existing?.source;
  if (source !== 'task_result' && source !== 'page') throw new ApiError(422, 'invalid_observation', '观察来源只能是任务结果或网页');
  const sites = body.sites === undefined && existing ? [...existing.sites] : sitesOf(body.sites);
  const match = body.match ?? existing?.match ?? null;
  const value = body.value === undefined ? existing?.value ?? null : body.value == null ? null : text(body.value, 'value', 80);
  const url = body.url === undefined ? existing?.url ?? null : body.url == null || body.url === '' ? null : text(body.url, 'url', 1000);
  const condition = body.condition === undefined ? existing?.condition ?? null : body.condition == null ? null : text(body.condition, 'condition', 500);
  if (source === 'task_result') {
    if (!['status', 'delivery', 'reason'].includes(match)) throw new ApiError(422, 'invalid_observation', '任务观察需要 status、delivery 或 reason');
    if (match === 'status' && !TASK_STATUSES.has(value)) throw new ApiError(422, 'invalid_observation', '任务状态不在可观察范围内');
    if (match === 'delivery' && !DELIVERIES.has(value)) throw new ApiError(422, 'invalid_observation', '交付状态不在可观察范围内');
    if (match === 'reason' && !value) throw new ApiError(422, 'invalid_observation', '需要观察的原因码');
    if (!existing && !body.task_id) throw new ApiError(422, 'invalid_observation', '任务观察需要指定任务');
  } else {
    if (!condition) throw new ApiError(422, 'invalid_observation', '网页观察需要业务条件');
    if (!url) throw new ApiError(422, 'invalid_observation', '网页观察需要地址');
    let host = '';
    try { const parsed = new URL(url); if (parsed.protocol !== 'https:') throw new Error('protocol'); host = parsed.hostname.toLowerCase(); }
    catch { throw new ApiError(422, 'invalid_observation', '网页地址需要是 https'); }
    if (!sites.includes(host)) throw new ApiError(422, 'invalid_observation', '网页地址必须落在规则授权的网站内');
  }
  const minutes = Number(body.cooldown_minutes ?? existing?.cooldown_minutes);
  if (!Number.isInteger(minutes) || minutes < 5 || minutes > 1440) throw new ApiError(422, 'invalid_observation', '冷却时间应在 5 分钟至 24 小时之间');
  return {
    kind: 'observation',
    title: text(body.title ?? existing?.title ?? body.goal, 'title', 200),
    goal: text(body.goal ?? existing?.goal, 'goal'),
    enabled: body.enabled === undefined ? existing?.enabled !== false : body.enabled === true,
    device_id: uuid(body.device_id ?? existing?.device_id),
    engine: engineName(body.engine ?? existing?.engine),
    project: body.project === undefined && existing ? existing.project ?? null : projectOf(body.project),
    sites, source, match, value, url, condition, cooldown_minutes: minutes,
    task_id: body.task_id ? uuid(body.task_id) : existing?.task_id ?? null,
  };
}

function fingerprintFor(task: Doc, delivery: Doc | null): string {
  return `${task.id}:${task.status}:${task.delivery_status ?? ''}:${delivery?.status ?? ''}:${task.updated_at ?? ''}`;
}

function matched(rule: Doc, task: Doc, delivery: Doc | null): boolean {
  if (rule.match === 'status') return task.status === rule.value;
  if (rule.match === 'delivery') return (delivery?.status ?? task.delivery_status) === rule.value;
  return task.reason_code === rule.value;
}

function pushHistory(rule: Doc, entry: Doc): Doc[] {
  return [...(Array.isArray(rule.history) ? rule.history : []), entry].slice(-30);
}

function suggest(rule: Doc, reason: string, fingerprint: string, now: number): Doc {
  const suggestion = { id: randomUUID(), status: 'pending', goal: rule.goal, reason: reason.slice(0, 500), fingerprint, task_id: null, created_at: new Date(now).toISOString() };
  const scope = observationScope(rule);
  suggestion.reason = `${suggestion.reason}\n确认后才会创建任务。实际记忆范围：项目 ${scope.project ?? '不限项目'}；网站 ${scope.sites.join('、') || '无'}；全局偏好关。`;
  return {
    ...rule,
    last_status: 'matched',
    last_fingerprint: fingerprint,
    consecutive_failures: 0,
    next_eligible_at: new Date(now + rule.cooldown_minutes * 60_000).toISOString(),
    suggestions: [...(rule.suggestions ?? []), suggestion].slice(-20),
    history: pushHistory(rule, { at: suggestion.created_at, status: 'matched', fingerprint, suggestion_id: suggestion.id, reason: suggestion.reason }),
  };
}

function deviceBusy(deviceId: string, runs: Doc[], views: Doc[], now: number): string | null {
  if (runs.some(run => run.device_id === deviceId && (['dispatched', 'starting', 'running', 'waiting_input', 'stopping'].includes(run.state) || ['lost', 'result_unknown'].includes(run.state)))) return 'active_or_unreconciled_run';
  if (views.some(view => view.device_id === deviceId && view.control_requested && view.state !== 'closed' && Date.parse(view.control_expires_at ?? view.expires_at) > now)) return 'human_control';
  return null;
}

/** Task-result rules record a confirmable suggestion. Page rules only queue a read-only worker check. */
export async function observeDue(tx: Tx, now = Date.now()): Promise<void> {
  const rules = (await tx.all('schedules')).filter(rule => rule.kind === 'observation' && rule.enabled && Date.parse(rule.next_eligible_at) <= now);
  if (!rules.length) return;
  const runs = await tx.all('runs');
  const views = await tx.all('views');
  const tasks = await tx.all('tasks');
  const deliveries = await tx.all('task_deliveries');
  const devices = await tx.all('devices');
  const commands = await tx.all('commands');
  for (const rule of rules) {
    const busy = deviceBusy(rule.device_id, runs, views, now);
    if (busy) {
      await tx.put('schedules', { ...rule, last_status: 'suppressed', next_eligible_at: new Date(now + 60_000).toISOString(), history: pushHistory(rule, { at: new Date(now).toISOString(), status: 'suppressed', fingerprint: null, suggestion_id: null, reason: busy }) }, rule.id);
      continue;
    }
    if (rule.source === 'task_result') {
      const task = tasks.find(item => item.id === rule.task_id);
      if (!task) continue;
      const delivery = deliveries.find(item => item.run_id === task.current_run_id) ?? null;
      if (!matched(rule, task, delivery)) {
        if (rule.last_status === 'matched') await tx.put('schedules', { ...rule, last_status: 'clear', last_fingerprint: null, next_eligible_at: new Date(now).toISOString() }, rule.id);
        continue;
      }
      const fingerprint = fingerprintFor(task, delivery);
      if (fingerprint === rule.last_fingerprint) continue;
      const saved = suggest(rule, `任务「${task.title ?? task.goal}」达到 ${rule.match}=${rule.value}`, fingerprint, now);
      const suggestion = saved.suggestions.at(-1);
      await tx.put('schedules', saved, rule.id);
      if (suggestion) await tx.emit('observation.suggested', { rule_id: rule.id, suggestion_id: suggestion.id, status: 'pending' });
      continue;
    }
    const device = devices.find(item => item.id === rule.device_id);
    const online = !!device?.last_seen_at && Date.parse(device.last_seen_at) >= now - ONLINE_MS;
    const browser = device?.capabilities?.slots?.browser === 1;
    if (!online || !browser) {
      await tx.put('schedules', { ...rule, last_status: 'suppressed', next_eligible_at: new Date(now + 60_000).toISOString(), history: pushHistory(rule, { at: new Date(now).toISOString(), status: 'suppressed', fingerprint: null, suggestion_id: null, reason: !online ? 'device_offline' : 'browser_unavailable' }) }, rule.id);
      continue;
    }
    if (commands.some(command => command.device_id === rule.device_id && command.kind === 'observation.check' && command.state === 'pending' && command.payload?.rule_id === rule.id && Date.parse(command.expires_at) > now)) continue;
    const commandId = randomUUID();
    await tx.put('commands', { protocol_version: '1.0', message_id: randomUUID(), kind: 'observation.check', sent_at: new Date(now).toISOString(), device_id: rule.device_id, state: 'pending', expires_at: expires(600_000), payload: { command_id: commandId, rule_id: rule.id, source: 'page', url: rule.url, sites: rule.sites, condition: rule.condition, project: rule.project } }, commandId);
    await tx.put('schedules', { ...rule, last_status: 'watching', next_eligible_at: new Date(now + 10 * 60_000).toISOString() }, rule.id);
  }
}

export async function reportObservation(tx: Tx, ruleId: string, deviceId: string, body: Doc, now = Date.now()): Promise<Doc> {
  await graphLock(tx);
  const rule = await tx.need('schedules', uuid(ruleId), true);
  if (rule.kind !== 'observation' || rule.device_id !== deviceId) throw new ApiError(404, 'not_found', '观察规则不存在');
  const status = body.status;
  if (!['matched', 'clear', 'failed', 'suppressed'].includes(status)) throw new ApiError(422, 'invalid_observation', '观察结果无效');
  const reason = text(body.reason ?? status, 'reason', 500);
  const fingerprint = typeof body.fingerprint === 'string' ? body.fingerprint.slice(0, 200) : null;
  if (status === 'matched') {
    if (!fingerprint) throw new ApiError(422, 'invalid_observation', '命中需要去重指纹');
    if (fingerprint === rule.last_fingerprint) return rule;
    const saved = suggest(rule, reason, fingerprint, now);
    const suggestion = saved.suggestions.at(-1);
    await tx.put('schedules', saved, rule.id);
    if (suggestion) await tx.emit('observation.suggested', { rule_id: rule.id, suggestion_id: suggestion.id, status: 'pending' });
    return saved;
  }
  if (status === 'failed') {
    const failures = Math.min(8, Number(rule.consecutive_failures ?? 0) + 1);
    const delay = Math.min(24 * 60 * 60_000, rule.cooldown_minutes * 60_000 * 2 ** (failures - 1));
    return tx.put('schedules', { ...rule, last_status: 'failed', consecutive_failures: failures, next_eligible_at: new Date(now + delay).toISOString(), history: pushHistory(rule, { at: new Date(now).toISOString(), status, fingerprint, suggestion_id: null, reason }) }, rule.id);
  }
  const delay = status === 'suppressed' ? 60_000 : rule.cooldown_minutes * 60_000;
  return tx.put('schedules', { ...rule, last_status: status, consecutive_failures: status === 'clear' ? 0 : rule.consecutive_failures ?? 0, last_fingerprint: status === 'clear' ? null : rule.last_fingerprint ?? null, next_eligible_at: new Date(now + delay).toISOString(), history: pushHistory(rule, { at: new Date(now).toISOString(), status, fingerprint, suggestion_id: null, reason }) }, rule.id);
}

export async function decideSuggestion(tx: Tx, ruleId: string, suggestionId: string, action: string, createTask: (body: Doc) => Promise<Doc>): Promise<Doc> {
  await graphLock(tx);
  const rule = await tx.need('schedules', uuid(ruleId), true);
  if (rule.kind !== 'observation') throw new ApiError(404, 'not_found', '观察规则不存在');
  const suggestions = [...(rule.suggestions ?? [])];
  const index = suggestions.findIndex(item => item.id === suggestionId);
  if (index < 0) throw new ApiError(404, 'not_found', '建议不存在');
  const suggestion = suggestions[index]!;
  if (action === 'dismiss') {
    if (suggestion.status === 'pending') suggestions[index] = { ...suggestion, status: 'dismissed' };
    return tx.put('schedules', { ...rule, suggestions }, rule.id);
  }
  if (action !== 'confirm') throw new ApiError(422, 'invalid_observation', '建议只能确认或忽略');
  if (suggestion.status === 'confirmed' && suggestion.task_id) return rule;
  if (suggestion.status !== 'pending') throw new ApiError(409, 'suggestion_closed', '这条建议已经处理');
  const task = await createTask({ title: rule.title, goal: suggestion.goal, engine: rule.engine, device_id: rule.device_id, deliverables: ['核对观察建议中的变化'], memory_scope: observationScope(rule) });
  suggestions[index] = { ...suggestion, status: 'confirmed', task_id: task.id };
  await tx.put('schedules', { ...rule, suggestions }, rule.id);
  await tx.emit('observation.confirmed', { rule_id: rule.id, suggestion_id: suggestion.id, task_id: task.id }, task.id);
  return { rule_id: rule.id, suggestion: suggestions[index], task };
}
