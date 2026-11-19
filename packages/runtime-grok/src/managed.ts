import { access, chmod, mkdir, mkdtemp, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

export const managedProfile = {
  name: 'super-agent-managed', description: 'Managed task worker using only the task broker',
  toolConfig: { tools: [{ id: 'GrokBuild:search_tool' }, { id: 'GrokBuild:use_tool' }] },
  tools: ['search_tool', 'use_tool'], disallowedTools: ['web_search', 'x_search'],
  discoverSkills: false, inheritSkills: false, agentsMd: false, injectDefaultTools: false,
  permissionMode: 'dontAsk', maxTurns: 80,
};
export const managedArgs = ['--no-plan', '--no-subagents', '--disable-web-search', '--deny', 'Bash', '--deny', 'Read(**)', '--deny', 'Edit', '--deny', 'Grep', '--deny', 'WebFetch', '--deny', 'WebSearch', '--allow', 'MCPTool(super_agent__*)', 'agent', '--no-leader', 'stdio'];

/** Isolate discovery without relocating, reading, exporting or copying the user's authentication store. */
export async function prepareManagedHome(options: { authPath?: string; parent?: string; systemPolicyDir?: string } = {}) {
  try { await access(options.systemPolicyDir ?? '/etc/grok'); throw new Error('grok_cli_system_policy_requires_review'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const source = options.authPath ?? process.env.GROK_AUTH_PATH ?? join(process.env.GROK_HOME || join(homedir(), '.grok'), 'auth.json');
  let authPath: string;
  try {
    authPath = await realpath(source);
    const meta = await stat(authPath);
    if (!meta.isFile() || (meta.mode & 0o077) !== 0 || typeof process.getuid === 'function' && meta.uid !== process.getuid()) throw Error('invalid_auth_metadata');
  } catch { throw new Error('grok_cli_local_login_required'); }
  const directory = await mkdtemp(join(options.parent ?? tmpdir(), 'super-agent-grok-'));
  await chmod(directory, 0o700);
  const cwd = join(directory, 'workspace'); await mkdir(cwd, { mode: 0o700 });
  const env = { ...process.env, GROK_HOME: directory, GROK_AUTH_PATH: authPath, GROK_DISABLE_AUTOUPDATER: '1', GROK_DISABLE_API_KEY_AUTH: '1', GROK_MEMORY: '0', GROK_SUBAGENTS: '0', GROK_WORKFLOWS: '0', GROK_GOAL: '0', GROK_WEB_FETCH: '0', GROK_MANAGED_MCPS_ENABLED: '0', GROK_MANAGED_MCP_GATEWAY_TOOLS_ENABLED: '0', GROK_TELEMETRY_ENABLED: '0' };
  for (const key of ['GROK_CONFIG', 'GROK_CONFIG_PATH', 'GROK_AUTH', 'GROK_AUTH_PROVIDER_COMMAND', 'GROK_AGENT']) delete env[key as keyof typeof env];
  for (const vendor of ['CLAUDE', 'CURSOR', 'CODEX']) for (const surface of ['HOOKS', 'MCPS', 'SKILLS', 'RULES', 'AGENTS', 'SESSIONS']) (env as NodeJS.ProcessEnv)[`GROK_${vendor}_${surface}_ENABLED`] = '0';
  const config = ['[permission]', 'allow = ["MCPTool(super_agent__*)"]', 'deny = ["Bash", "Read(**)", "Edit", "Grep", "WebFetch", "WebSearch"]', '[managed_mcps]', 'enabled = false', 'gateway_tools_enabled = false', '[memory]', 'enabled = false', '[memory_v2]', 'enabled = false', '[relay]', 'enabled = false', '[plugins]', 'enabled = []', '[session]', 'load_envrc = false', ...['claude', 'cursor', 'codex'].flatMap(v => [`[compat.${v}]`, ...['skills', 'rules', 'agents', 'mcps', 'hooks', 'sessions'].map(k => `${k} = false`)])].join('\n');
  await writeFile(join(directory, 'config.toml'), `${config}\n`, { mode: 0o600 });
  return { directory, cwd, env, configureBridge: (bridge: { command: string; script: string; url: string; token: string }) => writeFile(join(directory, 'config.toml'), `${config}\n[mcp_servers.super_agent]\ncommand = ${JSON.stringify(bridge.command)}\nargs = [${JSON.stringify(bridge.script)}]\nenabled = true\n[mcp_servers.super_agent.env]\nSUPER_AGENT_TOOL_URL = ${JSON.stringify(bridge.url)}\nSUPER_AGENT_TOOL_TOKEN = ${JSON.stringify(bridge.token)}\n`, { mode: 0o600 }), close: () => rm(directory, { recursive: true, force: true }) };
}
