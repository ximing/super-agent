import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';

export type Json = Record<string, any>;
/** ACP stdio transport. Never exposes stderr, RPC error data, auth responses or full spawn environment. */
export class AcpClient {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<number, { resolve: (result: Json) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  private nextId = 0;
  private closed = false;
  onNotification?: (method: string, params: Json) => void;
  onClientRequest?: (kind: 'permission' | 'filesystem' | 'terminal' | 'other') => void;
  constructor(command: string, args: string[], env: NodeJS.ProcessEnv, cwd?: string) {
    this.child = spawn(command, args, { env, cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    // Drain, without retaining or logging provider output that can contain local credentials.
    this.child.stderr.resume();
    this.child.stdin.on('error', () => this.fail(new Error('grok_cli_stdin_closed')));
    const input = createInterface({ input: this.child.stdout, crlfDelay: Infinity });
    input.on('line', line => {
      if (Buffer.byteLength(line) > 2_000_000) { this.fail(new Error('grok_cli_frame_too_large')); return; }
      let msg: Json; try { msg = JSON.parse(line); } catch { this.fail(new Error('grok_cli_invalid_json')); return; }
      if (msg.method) {
        if (msg.id !== undefined) {
          this.onClientRequest?.(msg.method === 'session/request_permission' ? 'permission' : String(msg.method).startsWith('fs/') ? 'filesystem' : String(msg.method).startsWith('terminal/') ? 'terminal' : 'other');
          // No native filesystem, terminal, permission, auth-browser or external network requests are delegated.
          const reply = msg.method === 'session/request_permission' ? { result: { outcome: { outcome: 'cancelled' } } }
            : { error: { code: -32601, message: 'Unsupported managed client request' } };
          this.write({ jsonrpc: '2.0', id: msg.id, ...reply });
        } else this.onNotification?.(String(msg.method), msg.params ?? {});
      } else if (typeof msg.id === 'number') {
        const call = this.pending.get(msg.id); if (!call) return;
        this.pending.delete(msg.id); clearTimeout(call.timer);
        if (msg.error) call.reject(new Error(`grok_cli_rpc_${typeof msg.error.code === 'number' ? msg.error.code : 'error'}`)); else call.resolve(msg.result ?? {});
      }
    });
    this.child.once('error', () => this.fail(new Error('grok_cli_spawn_failed')));
    this.child.once('close', () => this.fail(new Error('grok_cli_closed')));
  }
  request(method: string, params: Json, timeoutMs = 30_000, onSent?: () => void): Promise<Json> {
    if (this.closed) return Promise.reject(new Error('grok_cli_closed'));
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('grok_cli_rpc_timeout')); }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      if (this.write({ jsonrpc: '2.0', id, method, params })) onSent?.();
      else { clearTimeout(timer); this.pending.delete(id); reject(new Error('grok_cli_stdin_closed')); }
    });
  }
  notify(method: string, params: Json): void { if (!this.closed) this.write({ jsonrpc: '2.0', method, params }); }
  private write(message: Json): boolean {
    if (this.child.stdin.destroyed || this.child.stdin.writableEnded) return false;
    this.child.stdin.write(`${JSON.stringify(message)}\n`); return true;
  }
  private fail(error: Error): void {
    this.closed = true;
    for (const call of this.pending.values()) { clearTimeout(call.timer); call.reject(error); }
    this.pending.clear();
  }
  async close(): Promise<void> {
    this.fail(new Error('grok_cli_stopped'));
    if (this.child.exitCode !== null || this.child.signalCode !== null) return;
    const exit = new Promise<void>(resolve => this.child.once('close', () => resolve()));
    this.child.kill('SIGTERM');
    const timer = setTimeout(() => this.child.kill('SIGKILL'), 1500);
    await exit; clearTimeout(timer);
  }
}
export const initializeParams = () => ({ protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false }, clientInfo: { name: 'super-agent-managed-worker', version: '0.1.0' } });
