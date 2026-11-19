import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { AgentRecallAdapter } from '../src/recall.js';
import { ApiError, type Doc, type Tx } from '../src/store.js';
import { assessMemory, plannerAccess, proposeRetrospective, relateMemory, workerAccess } from '../src/memory-governance.js';

function localTx(tenant = randomUUID()): Tx {
  const tables = new Map<string, Map<string, Doc>>();
  const table = (name: string) => { if (!tables.has(name)) tables.set(name, new Map()); return tables.get(name)!; };
  return { tenant, get: async (name: string, id: string) => table(name).get(id) ?? null, all: async (name: string) => [...table(name).values()], remove: async (name: string, id: string) => { table(name).delete(id); }, put: async (name: string, doc: Doc, id: string = doc.id ?? randomUUID()) => { const value = { ...doc, id, version: (table(name).get(id)?.version ?? 0) + 1, created_at: new Date().toISOString(), updated_at: new Date().toISOString() }; table(name).set(id, value); return value; } } as unknown as Tx;
}
function upstream() {
  const memoryId = randomUUID(), calls: Doc[] = [];
  const rows = [{ id: memoryId, content: '公司入口在内部站点', type: 'fact', tags: ['existing'], version: 4, chainId: memoryId, project: 'alpha', updatedAt: '2026-11-18T12:00:00Z' }];
  const mocked = (async (input: URL | string | Request, init?: RequestInit) => {
    const url = new URL(String(input)), method = init?.method ?? 'GET';
    calls.push({ path: url.pathname, method });
    if (url.pathname === '/api/auth/me') return Response.json({ user: { id: 'alice', email: 'alice@example.com' } });
    if (url.pathname === '/api/memories/recall' || url.pathname === '/api/memories') return Response.json({ memories: rows });
    const found = rows.find(memory => memory.id === url.pathname.split('/').at(-1));
    if (!found) return Response.json({ error: 'missing' }, { status: 404 });
    if (method === 'PATCH' || method === 'DELETE') return Response.json({ memory: found });
    return Response.json({ memory: found });
  }) as typeof fetch;
  return { mocked, calls, memoryId };
}

test('task scope filters search and direct reads; an empty site is not visible to every task', async () => {
  const mock = upstream(), adapter = new AgentRecallAdapter({ encryptionKey: 'scope-test-key', fetch: mock.mocked });
  const owner = localTx(), other = localTx();
  await adapter.bind(owner, { url: 'https://recall.aimo.plus', token: 'alice-pat' });
  await adapter.bind(other, { url: 'https://recall.aimo.plus', token: 'alice-pat' });
  await owner.put('memories', { title: '入口', type: 'website', site: 'internal.example.com', status: 'verified' }, mock.memoryId);
  const allowed = workerAccess({ scope: { memory: { project: 'alpha', sites: ['internal.example.com'], global_preference: false } } }, { project: 'alpha' });
  const sibling = workerAccess({ scope: { memory: { project: 'alpha', sites: ['other.example.com'], global_preference: false } } }, { project: 'alpha' });
  const found = await adapter.search(owner, { query: '入口', site: 'internal.example.com' }, allowed);
  assert.equal(found.items.length, 1);
  assert.equal(found.items[0].fresh, true);
  assert.equal((await adapter.search(owner, { query: '入口' }, sibling)).items.length, 0);
  await assert.rejects(adapter.read(owner, mock.memoryId, sibling), (error: unknown) => error instanceof ApiError && error.status === 404);
  await assert.rejects(adapter.read(other, mock.memoryId, allowed), (error: unknown) => error instanceof ApiError && error.status === 404);
  assert.equal(mock.calls.filter(call => call.method === 'PATCH' || call.method === 'DELETE').length, 0);
});

test('global preferences require an explicit global scope and authorization', async () => {
  const memory = { id: 'pref', type: 'preference', site: null, status: 'verified', version: 1, content: '使用中文', scope_kind: 'global', recall_project: null };
  const open = plannerAccess({ memory_global_read: true }, null, null);
  const closed = plannerAccess({ memory_global_read: false }, null, null);
  assert.equal(assessMemory(memory, open).allowed, true);
  assert.equal(assessMemory({ ...memory, scope_kind: null }, open).allowed, false);
  assert.equal(assessMemory(memory, closed).allowed, false);
  assert.equal(assessMemory({ ...memory, type: 'experience', scope_kind: null, site: null }, workerAccess({ scope: { memory: { sites: ['internal.example.com'] } } }, null)).allowed, false);
});

test('candidates stay unverified and retrospective writes are idempotent without publishing', async () => {
  const tx = localTx();
  const task = { id: 'task', title: '核对页面', goal: '读取示例', scope: { memory: { project: 'isolated-test', sites: ['example.com'] } } };
  const run = { id: 'run', summary: '已读取' };
  const first = await proposeRetrospective(tx, run, task);
  const second = await proposeRetrospective(tx, run, task);
  assert.equal(first.id, second.id);
  assert.equal(first.status, 'candidate');
  assert.equal(first.governance.verification, 'candidate');
  assert.equal(first.governance.claim, 'inference');
  assert.notEqual(first.governance.verification, 'verified');
});

test('conflict, supersede and expiry are explicit and do not rewrite the other memory body', async () => {
  const tx = localTx();
  const kept = await tx.put('memories', { title: '旧事实', content: '原始公司内容', type: 'experience', site: 'example.com', status: 'verified' }, randomUUID());
  const newer = await tx.put('memories', { title: '新观察', content: '候选', type: 'experience', site: 'example.com', status: 'candidate' }, randomUUID());
  const conflict = await relateMemory(tx, newer.id, { relation: 'conflicts', other_id: kept.id, operation_key: 'conflict-1' });
  assert.deepEqual(await relateMemory(tx, newer.id, { relation: 'conflicts', other_id: kept.id, operation_key: 'conflict-1' }), conflict);
  assert.equal((await tx.get('memories', kept.id))?.content, '原始公司内容');
  await relateMemory(tx, newer.id, { relation: 'supersedes', other_id: kept.id, operation_key: 'supersede-1' });
  const expired = assessMemory({ ...(await tx.get('memories', kept.id)), status: 'verified' }, workerAccess({ scope: { memory: { sites: ['example.com'], statuses: ['verified', 'expired', 'superseded'] } } }, null));
  assert.equal(expired.presentation.status, 'superseded');
  assert.equal(expired.presentation.content, null);
  assert.equal(expired.presentation.fresh, false);
  const stale = assessMemory({ id: 'old', type: 'website', site: 'example.com', status: 'verified', version: 2, content: '过期内容', governance: { valid_until: '2020-01-01T00:00:00.000Z' } }, workerAccess({ scope: { memory: { sites: ['example.com'], statuses: ['expired'] } } }, null), '2026-11-19T00:00:00.000Z');
  assert.equal(stale.presentation.stale_reason, 'expired');
  assert.equal(stale.presentation.content, null);
});
