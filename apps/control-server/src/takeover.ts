import type { Doc, Tx } from './store.js';
import { ApiError } from './store.js';
import { uuid } from './auth.js';

function selectedEngine(value: unknown): 'codex' | 'grok' {
  if (value !== 'codex' && value !== 'grok') throw new ApiError(422, 'invalid_engine', '执行引擎无效');
  return value;
}

const ACTIVE = new Set(['dispatched', 'starting', 'running', 'waiting_input', 'stopping']);

/** Automatic replacement is refused until the previous execution authority is gone and side effects are reconciled. */
export async function takeoverPreflight(tx: Tx, taskId: string, deviceId: string, engineName: string, now = Date.now()): Promise<Doc> {
  const task = await tx.need('tasks', uuid(taskId));
  const device = await tx.need('devices', uuid(deviceId));
  const selected = selectedEngine(engineName);
  const run = task.current_run_id ? await tx.get('runs', task.current_run_id) : null;
  const checks: Doc[] = [];
  const leaseLive = !!run && ACTIVE.has(run.state) && Date.parse(run.lease_expires_at) > now;
  checks.push(leaseLive
    ? { name: 'authority', status: 'fail', detail: '旧执行租约仍有效，不能开始新的执行' }
    : { name: 'authority', status: 'pass', detail: run ? '旧执行权已结束或租约已失效' : '当前没有执行权' });
  checks.push(run && ['lost', 'result_unknown'].includes(run.state)
    ? { name: 'reconciliation', status: 'fail', detail: '上一次结果未知，先核对可能已经发生的操作' }
    : { name: 'reconciliation', status: 'pass', detail: '没有待核对的未知结果' });
  const online = !!device.last_seen_at && Date.parse(device.last_seen_at) >= now - 30_000;
  const cap = (device.capabilities?.engines ?? []).find((item: Doc) => item.engine === selected && item.ready === true);
  checks.push(!online
    ? { name: 'engine', status: 'fail', detail: '目标电脑离线' }
    : cap ? { name: 'engine', status: 'pass', detail: `${selected} 可用` } : { name: 'engine', status: 'fail', detail: '目标电脑没有就绪的所选引擎' });
  const sites = Array.isArray(task.scope?.memory?.sites) ? task.scope.memory.sites : [];
  const browser = device.capabilities?.slots?.browser === 1;
  checks.push(sites.length && !browser
    ? { name: 'browser', status: 'fail', detail: '任务带有网站范围，但目标电脑没有浏览器槽位' }
    : { name: 'browser', status: browser ? 'pass' : 'unknown', detail: browser ? '浏览器槽位可用' : '这台电脑没有上报浏览器槽位' });
  checks.push({ name: 'site_login', status: 'unknown', detail: '网站登录态只存在于这台 Mac 的浏览器里，服务端无法代替确认' });
  const artifacts = (await tx.all('artifacts')).filter(item => item.task_id === task.id && item.status === 'ready');
  const unverified = artifacts.filter(item => item.integrity !== 'server_snapshot' || typeof (item.claimed_sha256 ?? item.sha256) !== 'string');
  checks.push(unverified.length
    ? { name: 'artifacts', status: 'fail', detail: '有冻结产物缺少服务端快照或完整性摘要，不能自动恢复' }
    : { name: 'artifacts', status: artifacts.length ? 'pass' : 'unknown', detail: artifacts.length ? '可以按摘要恢复已冻结的产物' : '没有需要恢复的冻结产物' });
  return {
    ready: checks.every(check => check.status === 'pass'),
    automatic: false,
    checks,
    artifacts: artifacts.map(item => ({ id: item.id, name: item.name, integrity: item.integrity === 'server_snapshot' ? 'server_snapshot' : 'legacy_unverified', sha256: item.claimed_sha256 ?? item.sha256 ?? null })),
  };
}

export function assertSwitchTarget(preflight: Doc): void {
  const blocking = preflight.checks.find((check: Doc) => ['authority', 'reconciliation', 'engine'].includes(check.name) && check.status === 'fail');
  if (blocking) throw new ApiError(409, blocking.name === 'authority' ? 'execution_authority_live' : blocking.name === 'reconciliation' ? 'result_unknown' : 'engine_unavailable', blocking.detail);
}
