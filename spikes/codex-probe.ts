/** Read-only transport/tool-capability probe: no turn/start and no model inference. */
import { CodexRpc } from '../packages/runtime-codex/dist/index.js';
import { writeFile } from 'node:fs/promises';

const rpc = new CodexRpc(process.env.SUPER_AGENT_CODEX_COMMAND ?? 'codex', ['app-server', '--stdio'], 30_000);
const args = process.argv.slice(2), outputIndex = args.indexOf('--output');
try {
  const initialized = await rpc.request<{ userAgent?: string; platformFamily?: string }>('initialize', {
    clientInfo: { name: 'super-agent-readonly-probe', title: 'Super-agent read-only probe', version: '0.1.0' },
    capabilities: { experimentalApi: true },
  });
  rpc.notify('initialized');
  const models = await rpc.request<{ data: { id: string; isDefault?: boolean }[] }>('model/list', {});
  const started = await rpc.request<{ thread: { id: string } }>('thread/start', {
    cwd: process.cwd(), sandbox: 'read-only', approvalPolicy: 'never',
    developerInstructions: 'Capability probe only. No model turn will be started.',
    dynamicTools: [{ name: 'memory_probe', description: 'Read-only placeholder tool for schema validation, never invoked.', inputSchema: { type: 'object', properties: {}, additionalProperties: false } }],
  });
  await rpc.request('thread/archive', { threadId: started.thread.id });
  const report = { checked_at: new Date().toISOString(), transport: 'stdio', initialized: true,
    platform_family: initialized.platformFamily ?? null, configured_models_count: models.data.length,
    read_only_thread_created_and_archived: true, dynamic_tool_definition_accepted: true,
    model_turn_started: false, provider_credentials_uploaded: false };
  if (outputIndex >= 0 && args[outputIndex + 1]) await writeFile(args[outputIndex + 1]!, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} catch (error) {
  process.stderr.write(`Codex read-only probe failed: ${(error as Error).message}\n`); process.exitCode = 1;
} finally { await rpc.close(); }
