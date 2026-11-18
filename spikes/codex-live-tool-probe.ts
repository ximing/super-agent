/** One explicitly requested, bounded inference turn. Never part of default tests. */
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { CodexRpc, CodexRuntime, type CodexErrorInfo } from '../packages/runtime-codex/src/index.js';
import { BrowserActor, ToolBroker, type UsageSample } from '../packages/tool-broker/src/index.js';

const args = process.argv.slice(2), outputIndex = args.indexOf('--output');
const directory = await mkdtemp(join(tmpdir(), 'super-agent-live-tool-'));
const controller = new AbortController();
const marker = 'SUPER_AGENT_DYNAMIC_TOOL_OK', fixtureName = 'fixture.txt';
const fixture = `Return exactly this marker: ${marker}\nReceipt nonce: ${randomUUID()}\n`;
let calls = 0, fixtureRead = false, markerMatched = false, success = false, failure: string | null = null;
const usage = new Map<string, UsageSample>();
const protocolMethods = new Set<string>();
const errorCodes: CodexErrorInfo[] = [];
const started = performance.now();
const useDefaultModel = args.includes('--default-model');
const totalBudgetMs = useDefaultModel ? 90_000 : Math.min(55_000, Math.max(5000, Number(process.env.SUPER_AGENT_PROBE_TIMEOUT_MS) || 55_000));
const budgetMs = totalBudgetMs - 4000; // Reserve RPC/child shutdown time within the total budget.
const timer = setTimeout(() => controller.abort(), budgetMs);
try {
  const publicConfig = await readFile(join(process.env.CODEX_HOME ?? join(homedir(), '.codex'), 'config.toml'), 'utf8');
  let modelId = process.env.SUPER_AGENT_CODEX_MODEL ?? /^model\s*=\s*"([^"]+)"/m.exec(publicConfig)?.[1];
  if (useDefaultModel) {
    const discovery = new CodexRpc(process.env.SUPER_AGENT_CODEX_COMMAND ?? 'codex', ['app-server', '--stdio'], 1000);
    try {
      await discovery.request('initialize', { clientInfo: { name: 'super-agent-model-discovery', version: '0.1.0' }, capabilities: { experimentalApi: true } }); discovery.notify('initialized');
      const models = await discovery.request<{ data: { id: string; isDefault?: boolean }[] }>('model/list', {});
      modelId = models.data.find(model => model.isDefault)?.id;
    } finally { await discovery.close(); }
  }
  if (!modelId) throw new Error('Configure a local model for the explicit live probe');
  await writeFile(join(directory, fixtureName), fixture, { mode: 0o400 });
  const broker = new ToolBroker({ runId: randomUUID(), cwd: directory, browser: new BrowserActor(), signal: controller.signal,
    assertActive: () => { if (controller.signal.aborted) throw new Error('Probe stopped'); },
    request: async () => { throw new Error('Cloud tools are disabled in this probe'); },
    ask: async () => { throw new Error('Questions are disabled in this probe'); } });
  // Native tool switches are per-process, never written to the user's global configuration.
  const disabled = ['shell_tool', 'unified_exec', 'apps', 'plugins', 'browser_use', 'computer_use', 'multi_agent', 'view_image', 'hooks'];
  const mcpNames = [...publicConfig.matchAll(/^\[mcp_servers\.([a-zA-Z0-9_-]+)\]/gm)].map(match => match[1]!);
  const runtime = new CodexRuntime({ command: process.env.SUPER_AGENT_CODEX_COMMAND ?? 'codex',
    args: [...disabled.flatMap(feature => ['--disable', feature]), ...mcpNames.flatMap(name => ['-c', `mcp_servers.${name}.enabled=false`]), '-c', 'web_search="disabled"', '-c', 'model_reasoning_effort="low"', 'app-server', '--stdio'],
    timeoutMs: 1000, maxRunMs: Math.max(1000, budgetMs - (performance.now() - started)), reasoningEffort: 'low', sandbox: 'read-only', onProtocolEvent: method => protocolMethods.add(method), onErrorInfo: info => { errorCodes.push(info); } });
  const result = await runtime.execute({ runId: 'live-readonly-probe', taskId: 'live-readonly-probe', cwd: directory, modelId,
    goal: `Call files_read once with path "${fixtureName}". Read its marker, then reply with only that marker. Do not guess it.`,
    developerInstructions: 'This is a bounded read-only adapter acceptance probe. Only the supplied files_read tool is allowed. Do not invoke shell, browser, network, file-write or any other tool. Do not discover skills, inspect configuration, credentials or other files. No memory search is applicable. Reply with the fixture marker only; no explanation.',
    tools: broker.definitions().filter(tool => tool.name === 'files_read'), signal: controller.signal,
    executeTool: async (name, toolArgs) => {
      if (name !== 'files_read' || toolArgs.path !== fixtureName || calls >= 1) throw new Error('Probe permits one fixture read only');
      calls++; const value = await broker.execute(name, toolArgs);
      fixtureRead = JSON.stringify(value).includes(marker); return value;
    },
    emit: event => { if (event.type === 'usage') usage.set(event.usage.request_key, event.usage); },
  });
  markerMatched = result.text.trim() === marker;
  success = calls === 1 && fixtureRead && markerMatched;
  if (!success) failure = 'tool_receipt_or_marker_not_verified';
} catch (error) {
  failure = errorCodes.length ? 'structured_error_observed' : controller.signal.aborted ? 'deadline_stopped' : error instanceof Error && error.name === 'AbortError' ? 'interrupted' : 'runtime_failed';
} finally {
  clearTimeout(timer); controller.abort();
  await chmod(join(directory, fixtureName), 0o600).catch(() => undefined);
  await rm(directory, { recursive: true, force: true });
}
const totals = { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0, reasoning_tokens: 0 };
for (const sample of usage.values()) for (const key of Object.keys(totals) as (keyof typeof totals)[]) totals[key] += sample[key] ?? 0;
const report = { checked_at: new Date().toISOString(), runtime: 'real-local-codex', success, tool_calls: calls,
  fixture_read_succeeded: fixtureRead, fixed_marker_matched: markerMatched, dynamic_tool_receipt_verified: success,
  model_turns_started: protocolMethods.has('turn/start/completed') ? 1 : 0, protocol_methods: [...protocolMethods], error_codes: errorCodes, usage_samples: usage.size, usage: usage.size ? totals : null,
  duration_ms: Math.round(performance.now() - started), total_budget_ms: totalBudgetMs, default_model_selected: useDefaultModel, reasoning_effort: 'low', network_path: args.includes('--existing-system-proxy') ? 'existing-macos-system-proxy-via-explicit-env' : 'process-default', failure, temporary_fixture_removed: true, provider_credentials_uploaded: false };
if (outputIndex >= 0 && args[outputIndex + 1]) await writeFile(args[outputIndex + 1]!, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
if (!success) process.exitCode = 1;
