import { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, chmodSync } from 'node:fs';
import { dirname } from 'node:path';
import type { WireMessage, RunContext, ToolStepUpdate } from '@super-agent/protocol';
type Row = Record<string, unknown>;

/** Local durable inbox/outbox. No model credentials are ever stored here. */
export class LocalStore {
  readonly db: DatabaseSync;
  private inTransaction = false;
  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    if (path !== ':memory:') chmodSync(path, 0o600);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS kv(key TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS inbox(command_id TEXT PRIMARY KEY,payload_hash TEXT NOT NULL,message TEXT NOT NULL,state TEXT NOT NULL,created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS producers(run_id TEXT PRIMARY KEY,producer_id TEXT NOT NULL,next_seq INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS outbox(message_id TEXT PRIMARY KEY,run_id TEXT,payload TEXT NOT NULL,created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS local_runs(run_id TEXT PRIMARY KEY,context TEXT NOT NULL,state TEXT NOT NULL,binding TEXT,updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS usage_revisions(identity TEXT PRIMARY KEY,revision INTEGER NOT NULL,payload_hash TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS assistant_outbox(message_id TEXT PRIMARY KEY,payload TEXT NOT NULL,created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS coordinator_outbox(event_id TEXT PRIMARY KEY,payload TEXT NOT NULL,created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS tool_receipts(id TEXT PRIMARY KEY,run_id TEXT NOT NULL,tool TEXT NOT NULL,result_hash TEXT NOT NULL,completed_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS tool_steps(id TEXT PRIMARY KEY,run_id TEXT NOT NULL,status TEXT NOT NULL,payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS observations(command_id TEXT PRIMARY KEY,payload TEXT NOT NULL,updated_at TEXT NOT NULL);
    `);
  }
  get<T>(key: string): T | undefined { const row = this.db.prepare('SELECT value FROM kv WHERE key=?').get(key) as Row | undefined; return row ? JSON.parse(String(row.value)) as T : undefined; }
  set(key: string, value: unknown): void { this.db.prepare('INSERT INTO kv VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, JSON.stringify(value)); }
  command(message: WireMessage): 'new' | 'duplicate' {
    const commandId = String(message.payload.command_id ?? message.message_id);
    const payload = JSON.stringify(message), hash = createHash('sha256').update(payload).digest('hex');
    const previous = this.db.prepare('SELECT payload_hash FROM inbox WHERE command_id=?').get(commandId) as Row | undefined;
    if (previous) { if (previous.payload_hash !== hash) throw new Error('command_hash_conflict'); return 'duplicate'; }
    this.db.prepare('INSERT INTO inbox VALUES(?,?,?,?,?)').run(commandId, hash, payload, 'stored', new Date().toISOString());
    return 'new';
  }
  commandState(id: string, state: string): void { this.db.prepare('UPDATE inbox SET state=? WHERE command_id=?').run(state, id); }
  pendingCommands(): WireMessage[] { return (this.db.prepare("SELECT message FROM inbox WHERE state='stored' ORDER BY created_at").all() as Row[]).map(r => JSON.parse(String(r.message)) as WireMessage); }
  enqueue(kind: string, payload: Record<string, unknown>, runId?: string): WireMessage {
    const ownsTransaction = !this.inTransaction;
    if (ownsTransaction) this.db.exec('BEGIN IMMEDIATE');
    try {
      let produced = payload;
      if (runId && kind !== 'command.ack') {
        let row = this.db.prepare('SELECT * FROM producers WHERE run_id=?').get(runId) as Row | undefined;
        if (!row) { this.db.prepare('INSERT INTO producers VALUES(?,?,1)').run(runId, randomUUID()); row = this.db.prepare('SELECT * FROM producers WHERE run_id=?').get(runId) as Row; }
        const seq = Number(row.next_seq);
        this.db.prepare('UPDATE producers SET next_seq=? WHERE run_id=?').run(seq + 1, runId);
        produced = { ...payload, producer_id: String(row.producer_id), producer_seq: String(seq) };
      }
      const message: WireMessage = { protocol_version: '1.0', message_id: randomUUID(), kind, sent_at: new Date().toISOString(), payload: produced };
      this.db.prepare('INSERT INTO outbox VALUES(?,?,?,?)').run(message.message_id, runId ?? null, JSON.stringify(message), message.sent_at);
      if (ownsTransaction) this.db.exec('COMMIT'); return message;
    } catch (error) { if (ownsTransaction) this.db.exec('ROLLBACK'); throw error; }
  }
  pendingReports(limit = 100): WireMessage[] { return (this.db.prepare('SELECT payload FROM outbox ORDER BY created_at,rowid LIMIT ?').all(limit) as Row[]).map(r => JSON.parse(String(r.payload)) as WireMessage); }
  acknowledge(ids: string[]): void { const statement = this.db.prepare('DELETE FROM outbox WHERE message_id=?'); for (const id of ids) statement.run(id); }
  saveRun(context: RunContext, state: string, binding?: Record<string, string>): void {
    this.db.prepare('INSERT INTO local_runs VALUES(?,?,?,?,?) ON CONFLICT(run_id) DO UPDATE SET context=excluded.context,state=excluded.state,binding=COALESCE(excluded.binding,local_runs.binding),updated_at=excluded.updated_at').run(context.run.id, JSON.stringify(context), state, binding ? JSON.stringify(binding) : null, new Date().toISOString());
  }
  run(runId: string): { context: RunContext; state: string; binding: Record<string, string> | null } | undefined {
    const row = this.db.prepare('SELECT * FROM local_runs WHERE run_id=?').get(runId) as Row | undefined;
    return row ? { context: JSON.parse(String(row.context)) as RunContext, state: String(row.state), binding: row.binding ? JSON.parse(String(row.binding)) as Record<string, string> : null } : undefined;
  }
  unfinished(): { context: RunContext; state: string }[] {
    return (this.db.prepare("SELECT context,state FROM local_runs WHERE state IN ('starting','running','waiting_input')").all() as Row[]).map(r => ({ context: JSON.parse(String(r.context)) as RunContext, state: String(r.state) }));
  }
  usageRevision(runId: string, requestKey: string, payload: unknown): number | null {
    const identity = `${runId}:${requestKey}`, hash = createHash('sha256').update(JSON.stringify(payload)).digest('hex');
    const row = this.db.prepare('SELECT * FROM usage_revisions WHERE identity=?').get(identity) as Row | undefined;
    if (row?.payload_hash === hash) return null;
    const revision = row ? Number(row.revision) + 1 : 1;
    this.db.prepare('INSERT INTO usage_revisions VALUES(?,?,?) ON CONFLICT(identity) DO UPDATE SET revision=excluded.revision,payload_hash=excluded.payload_hash').run(identity, revision, hash);
    return revision;
  }
  recordUsage(runId: string, requestKey: string, payload: Record<string, unknown>): WireMessage | null {
    this.db.exec('BEGIN IMMEDIATE'); this.inTransaction = true;
    try {
      const revision = this.usageRevision(runId, requestKey, payload);
      const message = revision === null ? null : this.enqueue('usage.report', { ...payload, usage_revision: revision }, runId);
      this.db.exec('COMMIT'); return message;
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    finally { this.inTransaction = false; }
  }
  saveAssistant(messageId: string, payload: Record<string, unknown>): void { this.db.prepare('INSERT INTO assistant_outbox VALUES(?,?,?) ON CONFLICT(message_id) DO UPDATE SET payload=excluded.payload').run(messageId, JSON.stringify(payload), new Date().toISOString()); }
  assistantPending(): { messageId: string; payload: Record<string, unknown> }[] { return (this.db.prepare('SELECT * FROM assistant_outbox ORDER BY created_at').all() as Row[]).map(row => ({ messageId: String(row.message_id), payload: JSON.parse(String(row.payload)) as Record<string, unknown> })); }
  assistantDone(messageId: string): void { this.db.prepare('DELETE FROM assistant_outbox WHERE message_id=?').run(messageId); }
  saveCoordinator(eventId: string, payload: unknown): void { this.db.prepare('INSERT INTO coordinator_outbox VALUES(?,?,?) ON CONFLICT(event_id) DO UPDATE SET payload=excluded.payload').run(eventId, JSON.stringify(payload), new Date().toISOString()); }
  coordinatorPending<T>(): { eventId: string; payload: T }[] { return (this.db.prepare('SELECT * FROM coordinator_outbox ORDER BY created_at').all() as Row[]).map(row => ({ eventId: String(row.event_id), payload: JSON.parse(String(row.payload)) as T })); }
  coordinatorDone(eventId: string): void { this.db.prepare('DELETE FROM coordinator_outbox WHERE event_id=?').run(eventId); }
  operation(runId: string, tool: string, result: unknown): void { this.db.prepare('INSERT INTO tool_receipts VALUES(?,?,?,?,?)').run(randomUUID(), runId, tool, createHash('sha256').update(JSON.stringify(result ?? null)).digest('hex'), new Date().toISOString()); }
  receipts(runId: string): Record<string, unknown>[] { return this.db.prepare('SELECT id,tool,result_hash,completed_at FROM tool_receipts WHERE run_id=? ORDER BY completed_at,rowid').all(runId) as Record<string, unknown>[]; }
  /** A step update and its delivery must commit together, including across node restarts. */
  recordStep(runId: string, step: ToolStepUpdate, authorization: { device_id: string; lease_epoch: string }): WireMessage | null {
    this.db.exec('BEGIN IMMEDIATE'); this.inTransaction = true;
    try {
      const safe: ToolStepUpdate = { step_id: step.step_id, tool: step.tool, status: step.status, started_at: step.started_at, completed_at: step.completed_at, error_code: step.error_code };
      const serialized = JSON.stringify(safe);
      const old = this.db.prepare('SELECT run_id,status,payload FROM tool_steps WHERE id=?').get(step.step_id) as Row | undefined;
      if (old && old.run_id !== runId) throw new Error('tool_step_run_conflict');
      if (old?.payload === serialized) { this.db.exec('COMMIT'); return null; }
      if (old && old.status !== 'running') throw new Error('tool_step_already_completed');
      this.db.prepare('INSERT INTO tool_steps VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET status=excluded.status,payload=excluded.payload').run(step.step_id, runId, step.status, serialized);
      const message = this.enqueue('step.updated', { ...authorization, ...safe, run_id: runId }, runId);
      this.db.exec('COMMIT'); return message;
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    finally { this.inTransaction = false; }
  }
  unfinishedSteps(runId: string): ToolStepUpdate[] {
    return (this.db.prepare("SELECT payload FROM tool_steps WHERE run_id=? AND status='running' ORDER BY rowid").all(runId) as Row[]).map(row => JSON.parse(String(row.payload)) as ToolStepUpdate);
  }
  saveObservation(commandId: string, payload: unknown): void {
    this.db.prepare('INSERT INTO observations VALUES(?,?,?) ON CONFLICT(command_id) DO UPDATE SET payload=excluded.payload,updated_at=excluded.updated_at').run(commandId, JSON.stringify(payload), new Date().toISOString());
  }
  observations(): unknown[] {
    return (this.db.prepare('SELECT payload FROM observations ORDER BY updated_at,rowid').all() as Row[]).map(row => JSON.parse(String(row.payload)));
  }
  close(): void { this.db.close(); }
}
