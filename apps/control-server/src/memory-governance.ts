import { randomUUID } from 'node:crypto';
import { ApiError, type Doc, type Tx } from './store.js';
import { text, uuid } from './auth.js';

export type MemoryRole = 'user' | 'planner' | 'worker';
export interface MemoryAccess {
  role: MemoryRole; project: string | null; sites: string[]; global_preference: boolean;
  statuses: string[]; max_version: number | null;
}
const STATUSES = ['candidate', 'verified', 'stale', 'expired', 'superseded'];

export function normalizeMemoryScope(value: unknown): Doc | null {
  if (value == null) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ApiError(422, 'invalid_memory_scope', '记忆范围无效');
  const raw = value as Doc;
  const sites = Array.isArray(raw.sites) ? [...new Set(raw.sites.map(site => text(site, 'site', 253).toLowerCase()))].slice(0, 20) : [];
  const project = typeof raw.project === 'string' && raw.project.trim() ? text(raw.project, 'project', 128) : null;
  if (raw.global_preference !== undefined && raw.global_preference !== true && raw.global_preference !== false) throw new ApiError(422, 'invalid_memory_scope', '全局记忆授权无效');
  const statuses = Array.isArray(raw.statuses) ? raw.statuses.filter((status: unknown) => typeof status === 'string' && STATUSES.includes(status)) : ['verified'];
  const max = raw.max_version == null || raw.max_version === '' ? null : Number(raw.max_version);
  if (max != null && (!Number.isSafeInteger(max) || max < 1)) throw new ApiError(422, 'invalid_memory_scope', '记忆版本范围无效');
  return { project, sites, global_preference: raw.global_preference === true, statuses: statuses.length ? statuses : ['verified'], max_version: max };
}

export function workerAccess(task: Doc | null, binding: Doc | null): MemoryAccess {
  const memory = task?.scope?.memory && typeof task.scope.memory === 'object' ? task.scope.memory : {};
  const sites = Array.isArray(memory.sites) ? memory.sites.filter((site: unknown) => typeof site === 'string' && site).map((site: string) => site.toLowerCase()) : [];
  return {
    role: 'worker',
    project: typeof memory.project === 'string' && memory.project ? memory.project : (typeof binding?.project === 'string' ? binding.project : null),
    sites, global_preference: memory.global_preference === true,
    statuses: (() => { const requested = Array.isArray(memory.statuses) ? memory.statuses.filter((status: string) => STATUSES.includes(status)) : []; return requested.length ? requested : ['verified']; })(),
    max_version: Number.isSafeInteger(memory.max_version) ? memory.max_version : null,
  };
}

export function plannerAccess(settings: Doc | null, binding: Doc | null, task: Doc | null): MemoryAccess {
  if (task) {
    const access = workerAccess(task, binding);
    return { ...access, role: 'planner', statuses: [...new Set([...access.statuses, 'candidate'])] };
  }
  return { role: 'planner', project: typeof binding?.project === 'string' ? binding.project : null, sites: [], global_preference: settings?.memory_global_read === true, statuses: ['verified', 'candidate'], max_version: null };
}

export function publicAccess(access: MemoryAccess): Doc {
  return { role: access.role, project: access.project, sites: access.sites, global_preference: access.global_preference, statuses: access.statuses, max_version: access.max_version };
}

function siteOf(memory: Doc): string | null { return typeof memory.site === 'string' && memory.site.trim() ? memory.site.trim().toLowerCase() : null; }
function projectOf(memory: Doc): string | null {
  const applicability = memory.governance?.applicability?.project;
  const value = typeof applicability === 'string' && applicability ? applicability : memory.recall_project ?? memory.project ?? null;
  return typeof value === 'string' && value ? value : null;
}
function globalPreference(memory: Doc): boolean {
  return memory.type === 'preference' && !siteOf(memory) && (memory.scope_kind === 'global' || memory.governance?.applicability?.global === true);
}

/** Task scope is checked for both search hits and direct id reads. An empty site is not a wildcard. */
export function assessMemory(memory: Doc, access: MemoryAccess, now = new Date().toISOString()): { allowed: boolean; presentation: Doc } {
  if (access.role === 'user') return { allowed: true, presentation: memory };
  const governance = memory.governance ?? {};
  const expired = (typeof governance.valid_until === 'string' && governance.valid_until <= now) || governance.verification === 'expired' || memory.status === 'expired';
  const superseded = !expired && (governance.verification === 'superseded' || typeof governance.superseded_by === 'string' || memory.status === 'superseded');
  const status = expired ? 'expired' : superseded ? 'superseded' : memory.status ?? 'verified';
  if (access.max_version != null && Number(memory.version) > access.max_version) return { allowed: false, presentation: memory };
  if (!access.statuses.includes(status)) return { allowed: false, presentation: memory };
  const project = projectOf(memory), site = siteOf(memory), global = globalPreference(memory);
  if (project && access.project && project !== access.project) return { allowed: false, presentation: memory };
  if (project && !access.project) return { allowed: false, presentation: memory };
  if (!project && access.project && !global) return { allowed: false, presentation: memory };
  if (site) { if (!access.sites.includes(site)) return { allowed: false, presentation: memory }; }
  else if (!global || !access.global_preference) return { allowed: false, presentation: memory };
  const conflict = governance.verification === 'conflict' || (Array.isArray(governance.conflicts_with) && governance.conflicts_with.length > 0);
  const withheld = status === 'expired' || status === 'superseded' || conflict;
  const settled = status === 'verified' && !withheld && governance.claim !== 'inference';
  const presentation: Doc = { ...memory, status, claim: governance.claim ?? null, fresh: settled, stale: !settled, stale_reason: settled ? null : conflict ? 'conflict' : status === 'verified' && governance.claim === 'inference' ? 'inference' : status };
  if (withheld) presentation.content = null;
  return { allowed: true, presentation };
}

export function retrospectiveCandidate(run: Doc, task: Doc, evidenceRefs: Doc[] = [], now = new Date().toISOString()): Doc {
  const memory = task.scope?.memory ?? {};
  const sites = Array.isArray(memory.sites) ? memory.sites.filter((site: unknown) => typeof site === 'string').slice(0, 20) : [];
  const refs = evidenceRefs.slice(0, 20).map(ref => ({ kind: String(ref.kind ?? 'artifact'), id: String(ref.id) }));
  return {
    title: `复盘：${String(task.title ?? task.goal ?? '任务').slice(0, 120)}`,
    content: [`claim: inference`, `outcome: ${run.outcome ?? 'succeeded'}`, `task: ${task.id}`, `run: ${run.id}`, `goal: ${String(task.goal ?? '').slice(0, 500)}`, `summary: ${String(run.summary ?? '').slice(0, 500)}`, `evidence: ${refs.map(ref => `${ref.kind}:${ref.id}`).join(',') || 'none'}`].join('\n'),
    type: 'experience', site: sites[0] ?? null, status: 'candidate', scope_kind: null,
    governance: {
      claim: 'inference', evidence_refs: refs,
      applicability: { project: typeof memory.project === 'string' ? memory.project : null, sites, global: false },
      verification: 'candidate', valid_until: null, supersedes: null, superseded_by: null, conflicts_with: [],
      operation_key: `retrospective:${run.outcome ?? 'succeeded'}:${run.id}`, source_run_id: run.id, source_task_id: task.id, observed_at: now, operations: [`retrospective:${run.outcome ?? 'succeeded'}:${run.id}`],
    },
    source: 'retrospective',
  };
}

export async function proposeRetrospective(tx: Tx, run: Doc, task: Doc, outcome: 'succeeded' | 'failed' = 'succeeded'): Promise<Doc> {
  const key = `retrospective:${outcome}:${run.id}`;
  const existing = (await tx.all('memories')).find(memory => memory.governance?.operation_key === key || memory.governance?.operations?.includes(key));
  if (existing) return existing;
  const refs = (await tx.all('artifacts')).filter(artifact => artifact.task_id === task.id && artifact.run_id === run.id && artifact.status === 'ready' && artifact.provenance === 'tool_broker').map(artifact => ({ kind: artifact.evidence_kind ?? 'artifact', id: artifact.id }));
  const candidate = retrospectiveCandidate({ ...run, outcome }, task, refs);
  const locals = (await tx.all('memories')).filter(memory => memory.status === 'verified' && memory.site && memory.site === candidate.site && memory.title === candidate.title && memory.content && memory.content !== candidate.content);
  if (locals.length) { candidate.governance.verification = 'conflict'; candidate.governance.conflicts_with = locals.map(memory => memory.id); }
  const saved = await tx.put('memories', candidate, randomUUID());
  if (saved.status !== 'candidate' || saved.governance?.verification === 'verified') throw new ApiError(500, 'memory_governance', '复盘不能自动标为已验证');
  return saved;
}

/** Relations stay on the product overlay. Recall content is not edited, deleted, or published. */
export async function relateMemory(tx: Tx, id: string, body: Doc): Promise<Doc> {
  const memoryId = uuid(id), relation = body.relation;
  if (!['conflicts', 'supersedes', 'expires'].includes(relation)) throw new ApiError(422, 'invalid_memory_relation', '记忆关系无效');
  const operation = text(body.operation_key, 'operation_key', 200);
  const current = await tx.get('memories', memoryId) ?? { id: memoryId, status: 'verified', governance: {} };
  const operations: string[] = Array.isArray(current.governance?.operations) ? [...current.governance.operations] : [];
  if (operations.includes(operation)) return current;
  const governance: Doc = { ...(current.governance ?? {}), operations: [...operations, operation] };
  if (relation === 'conflicts' || relation === 'supersedes') {
    const other = uuid(body.other_id, 'other_id');
    if (other === memoryId) throw new ApiError(422, 'invalid_memory_relation', '记忆关系不能指向自己');
    if (relation === 'conflicts') {
      governance.verification = 'conflict';
      governance.conflicts_with = [...new Set([...(governance.conflicts_with ?? []), other])];
    } else {
      governance.supersedes = other;
      const previous = await tx.get('memories', other) ?? { id: other, status: 'verified', governance: {} };
      const previousOps: string[] = Array.isArray(previous.governance?.operations) ? previous.governance.operations : [];
      if (!previousOps.includes(operation)) await tx.put('memories', { ...previous, content: previous.content, governance: { ...(previous.governance ?? {}), operations: [...previousOps, operation], verification: 'superseded', superseded_by: memoryId } }, other);
    }
  } else {
    const until = typeof body.valid_until === 'string' ? body.valid_until : new Date().toISOString();
    if (!/^\d{4}-\d{2}-\d{2}T.+(?:Z|[+-]\d{2}:\d{2})$/.test(until) || !Number.isFinite(Date.parse(until))) throw new ApiError(422, 'invalid_memory_relation', '有效期需要带时区的 ISO 时间');
    governance.valid_until = new Date(Date.parse(until)).toISOString();
    governance.verification = Date.parse(until) <= Date.now() ? 'expired' : governance.verification === 'expired' ? 'candidate' : governance.verification ?? 'candidate';
  }
  if (governance.verification === 'verified') throw new ApiError(422, 'invalid_memory_relation', '关系不能把记忆标为已验证');
  return tx.put('memories', { ...current, status: current.status === 'candidate' ? 'candidate' : current.status ?? 'verified', governance }, memoryId);
}
