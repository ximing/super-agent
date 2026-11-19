export const BUDGET_CEILING = {
  max_total_tokens: 5_000_000,
  max_model_calls: 2_000,
  max_tool_steps: 5_000,
  max_runtime_ms: 28_800_000,
} as const;

export type BudgetKey = keyof typeof BUDGET_CEILING;

export const BUDGET_RECOVERY: Record<string, string> = {
  token_limit: '这个任务的 Token 已用到当前上限。提高对应活动的 Token 上限后可以继续。',
  model_call_limit: '这个任务的模型调用次数已用到当前上限。提高上限后可以继续。',
  tool_step_limit: '这个任务的工具步骤已用到当前上限。提高上限后可以继续。',
  time_limit: '这一次活动的运行时间已到上限。提高单次时长后可以再开始一次。',
  budget_exhausted: '金额预算已用完。提高本月或本任务金额上限后，才能开始新的模型调用。',
  budget_unknown: '还有费用没核算清楚，不能按 0 计算。确认费用或调整金额上限前，不会开始新的模型调用。',
};

const DIMENSIONS: Record<string, {key: BudgetKey; label: string; placeholder: string}> = {
  token_limit: {key: 'max_total_tokens', label: 'Token', placeholder: '新的 Token 上限'},
  model_call_limit: {key: 'max_model_calls', label: '模型调用次数', placeholder: '新的模型调用次数'},
  tool_step_limit: {key: 'max_tool_steps', label: '工具步骤', placeholder: '新的工具步骤上限'},
  time_limit: {key: 'max_runtime_ms', label: '单次时长（毫秒）', placeholder: '新的单次时长（毫秒）'},
};

export const BUDGET_CATEGORIES = [
  {id: 'worker', label: '执行'},
  {id: 'assistant', label: '助理'},
  {id: 'review', label: '验收'},
  {id: 'proactive', label: '主动规划'},
] as const;

export const BUDGET_LIMITS: {key: BudgetKey; label: string; ceiling: number}[] = [
  {key: 'max_total_tokens', label: 'Token', ceiling: BUDGET_CEILING.max_total_tokens},
  {key: 'max_model_calls', label: '模型调用', ceiling: BUDGET_CEILING.max_model_calls},
  {key: 'max_tool_steps', label: '工具步骤', ceiling: BUDGET_CEILING.max_tool_steps},
  {key: 'max_runtime_ms', label: '单次时长（毫秒）', ceiling: BUDGET_CEILING.max_runtime_ms},
];

export type RuntimeLimits = Partial<Record<BudgetKey, number>>;

export function recoveryText(code: string | null): string {
  return code && BUDGET_RECOVERY[code] ? BUDGET_RECOVERY[code] : code ? `任务状态：${code}` : '';
}

export function budgetDimension(code: string | null): {key: BudgetKey; label: string; ceiling: number; recovery: string; placeholder: string} | null {
  if (!code || !DIMENSIONS[code]) return null;
  const dimension = DIMENSIONS[code];
  return {key: dimension.key, label: dimension.label, ceiling: BUDGET_CEILING[dimension.key], recovery: BUDGET_RECOVERY[code] ?? '', placeholder: dimension.placeholder};
}

export function storedBudgetValue(budget: RuntimeLimits | null | undefined, key: BudgetKey): number | null {
  const value = budget?.[key];
  return typeof value === 'number' ? value : null;
}

/** Merge one stopping dimension. Other limit keys are absent so a time change cannot reset them. */
export function taskBudgetMerge(reason: string | null, value: number): {mode: 'merge'; limits: Partial<Record<BudgetKey, number>>} {
  const spec = budgetDimension(reason);
  if (!spec) throw new Error('这个状态不能通过提高用量上限继续');
  if (!Number.isSafeInteger(value) || value < 1 || value > spec.ceiling) throw new Error(`${spec.label}需为 1–${spec.ceiling} 的整数`);
  return {mode: 'merge', limits: {[spec.key]: value}};
}

export function memoryScopePayload(input: {project: string; sites: string; globalPreference: boolean; statuses: string; maxVersion: string}): {
  project: string | null; sites: string[]; global_preference: boolean; statuses: string[]; max_version: number | null;
} {
  const split = (value: string) => value.split(/[\s,，]+/).map(item => item.trim()).filter(Boolean);
  const project = input.project.trim();
  const maxRaw = input.maxVersion.trim();
  let maxVersion: number | null = null;
  if (maxRaw) {
    const parsed = Number(maxRaw);
    if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error('记忆最大版本需为大于 0 的整数');
    maxVersion = parsed;
  }
  const statuses = split(input.statuses);
  return {
    project: project ? project : null,
    sites: split(input.sites),
    global_preference: input.globalPreference === true,
    statuses: statuses.length ? statuses : ['verified'],
    max_version: maxVersion,
  };
}

/** Page rules require an https URL whose host is one of the sites. Task rules name the status, delivery, or reason being watched. */
export function observationRuleBody(input: {
  title: string; goal: string; deviceId: string; engine: string; sites: string; project: string;
  cooldownMinutes: number; source: 'task_result' | 'page'; taskId?: string; match?: string; value?: string; url?: string; condition?: string;
}): Record<string, unknown> {
  const sites = input.sites.split(/[\s,，]+/).map(site => site.trim().toLowerCase()).filter(Boolean);
  if (!sites.length) throw new Error('观察规则至少需要一个网站');
  const body: Record<string, unknown> = {
    title: input.title.trim(), goal: input.goal.trim(), device_id: input.deviceId, engine: input.engine,
    sites, project: input.project.trim() ? input.project.trim() : null, cooldown_minutes: input.cooldownMinutes, source: input.source,
  };
  if (input.source === 'task_result') {
    body.task_id = input.taskId;
    body.match = input.match;
    body.value = input.value;
  } else {
    const url = new URL(input.url ?? '');
    if (url.protocol !== 'https:' || !sites.includes(url.hostname.toLowerCase())) throw new Error('网页地址必须是授权网站上的 https 地址');
    body.url = url.toString();
    body.condition = input.condition?.trim();
  }
  return body;
}

/** Always sends `project`. Empty text clears it; a visible saved name is not omitted. */
export function memoryBindingBody(input: {url: string; token: string; project: string}): {url: string; token: string; project: string | null} {
  const project = input.project.trim();
  return {url: input.url, token: input.token, project: project ? project : null};
}

export function memorySettingsConflictMessage(status: number, code: string): string | null {
  if (code === 'version_conflict' && status === 412) return '记忆连接已变化，请刷新后重试。';
  return null;
}

export function executionSettingsBody(input: {engine: string; device: string; assistant: string; memoryGlobalRead: boolean}): {
  default_engine: string; default_device_id: string | null; assistant_device_id: string | null; memory_global_read: boolean;
} {
  return {
    default_engine: input.engine,
    default_device_id: input.device || null,
    assistant_device_id: input.assistant || null,
    memory_global_read: input.memoryGlobalRead,
  };
}

export function moneyBudgetMerge(monthly: string, task: string): {mode: 'merge'; monthly_limit_usd: string | null; task_limit_usd: string | null} {
  return {mode: 'merge', monthly_limit_usd: monthly || null, task_limit_usd: task || null};
}

/** Category merge omits money fields so a category save cannot null monthly or task USD. */
export function categoryLimitsMerge(draft: Record<string, Record<string, string> | undefined>): {mode: 'merge'; category_limits: Record<string, RuntimeLimits>} {
  const categoryLimits: Record<string, RuntimeLimits> = {};
  for (const category of BUDGET_CATEGORIES) {
    const partial: RuntimeLimits = {};
    for (const limit of BUDGET_LIMITS) {
      const raw = draft[category.id]?.[limit.key]?.trim() ?? '';
      if (!raw) continue;
      const value = Number(raw);
      if (!Number.isSafeInteger(value) || value < 1 || value > limit.ceiling) throw new Error(`${category.label}的${limit.label}需为 1–${limit.ceiling} 的整数`);
      partial[limit.key] = value;
    }
    if (Object.keys(partial).length) categoryLimits[category.id] = partial;
  }
  if (!Object.keys(categoryLimits).length) throw new Error('请填写要保存的活动上限');
  return {mode: 'merge', category_limits: categoryLimits};
}

export function memoryRelationBody(input: {relation: 'conflicts' | 'supersedes' | 'expires'; otherId?: string; validUntil?: string; governanceVersion: number; operationKey: string}): Record<string, string | number> {
  const body: Record<string, string | number> = {relation: input.relation, operation_key: input.operationKey, governance_version: input.governanceVersion};
  if (input.relation === 'expires') body.valid_until = normalizeValidUntil(input.validUntil ?? '');
  else {
    const other = input.otherId?.trim() ?? '';
    if (!other) throw new Error('请填写另一条记忆的标识');
    body.other_id = other;
  }
  return body;
}

export function normalizeValidUntil(value: string): string {
  const trimmed = value.trim();
  const dated = /^\d{4}-\d{2}-\d{2}$/.test(trimmed) ? `${trimmed}T00:00:00Z` : trimmed;
  if (!/^\d{4}-\d{2}-\d{2}T.+(?:Z|[+-]\d{2}:\d{2})$/.test(dated) || !Number.isFinite(Date.parse(dated))) throw new Error('有效期需要带时区的 ISO 时间，例如 2026-12-01T00:00:00+08:00');
  return new Date(dated).toISOString();
}

export function relationConflictMessage(status: number, code: string): string | null {
  if (code === 'version_conflict' && (status === 409 || status === 412)) return '记忆关系已变化，请刷新后重试。不会用旧版本重复提交。';
  return null;
}

export function presentCostReservation(summary: {reserved_hold_usd?: string | null; reserved_unknown_count?: number | null; unknown_count?: number | null}): {
  reserved_hold_usd: string | null; reserved_unknown_count: number | null; unknown_count: number | null; hold_label: string; reserved_unknown_label: string; unknown_label: string;
} {
  const hold = typeof summary.reserved_hold_usd === 'string' && summary.reserved_hold_usd.trim() !== '' ? summary.reserved_hold_usd : null;
  const reservedUnknown = typeof summary.reserved_unknown_count === 'number' ? summary.reserved_unknown_count : null;
  const unknown = typeof summary.unknown_count === 'number' ? summary.unknown_count : null;
  return {
    reserved_hold_usd: hold,
    reserved_unknown_count: reservedUnknown,
    unknown_count: unknown,
    hold_label: hold == null ? '预留金额尚未确定' : `预留 ${hold} USD`,
    reserved_unknown_label: reservedUnknown == null ? '预留未知笔数尚未取得' : `${reservedUnknown} 笔预留金额尚未确定`,
    unknown_label: unknown == null ? '未知请求次数尚未取得' : `${unknown} 次请求未取得金额`,
  };
}

export function memoryGovernanceLine(memory: {
  origin?: string | null; source?: string | null; expires_at?: string | null;
  governance?: {verification?: string; valid_until?: string | null; conflicts_with?: string[]; supersedes?: string | null; superseded_by?: string | null; version?: number; claim?: string; evidence_refs?: {kind?: string; id?: string}[]};
}): string {
  const governance = memory.governance;
  const evidence = governance?.evidence_refs?.map(item => [item.kind, item.id].filter(Boolean).join(':')).filter(Boolean).join('、');
  const claim = governance?.claim === 'inference' ? '推断' : governance?.claim === 'observed' ? '观察到的记录' : governance?.claim;
  const parts = [
    memory.source || memory.origin ? `来源 ${memory.source ?? memory.origin}` : null,
    evidence ? `证据 ${evidence}` : claim ? `主张 ${claim}` : null,
    governance?.verification ? `核验 ${governance.verification}` : null,
    governance?.version != null ? `治理 v${governance.version}` : null,
    governance?.valid_until || memory.expires_at ? `有效至 ${governance?.valid_until ?? memory.expires_at}` : null,
    governance?.conflicts_with?.length ? `冲突 ${governance.conflicts_with.join('、')}` : null,
    governance?.supersedes ? `替代 ${governance.supersedes}` : null,
    governance?.superseded_by ? `已被 ${governance.superseded_by} 替代` : null,
  ].filter((item): item is string => !!item);
  return parts.join(' · ');
}
