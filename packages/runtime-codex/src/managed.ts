import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

export const managedFeaturesDisabled = ['shell_tool', 'unified_exec', 'apps', 'plugins', 'browser_use', 'computer_use', 'multi_agent', 'view_image', 'hooks'] as const;
export const managedCompatibilityMessage = 'codex_managed_cli_incompatible: Codex must support the managed tool flags tested with 0.170.0; update the local CLI/configuration';
/** Only section names are retained. Secret/configuration values are never returned or copied. */
async function mcpSections(path: string): Promise<string[]> {
  const names = new Set<string>();
  const lines = createInterface({ input: createReadStream(path, { encoding: 'utf8' }), crlfDelay: Infinity });
  let container = false;
  try {
    for await (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      // Inline/dotted table assignments cannot be safely enumerated as section names.
      if (/^(?:mcp_servers|"mcp_servers"|'mcp_servers')\s*[.=]/.test(trimmed)) throw new Error('codex_managed_mcp_config_requires_section_headers');
      if (trimmed.startsWith('[')) {
        container = /^\[\s*(?:mcp_servers|"mcp_servers"|'mcp_servers')\s*\]/.test(trimmed);
        const prefix = /^\[\s*(?:mcp_servers|"mcp_servers"|'mcp_servers')\s*\./;
        if (prefix.test(trimmed)) {
          const match = /^\[\s*(?:mcp_servers|"mcp_servers"|'mcp_servers')\s*\.\s*("(?:[^"\\]|\\.)*"|'[^']*'|[a-zA-Z0-9_-]+)\s*(?:\.|\])/.exec(trimmed);
          if (!match) throw new Error('codex_managed_mcp_section_unsupported');
          names.add(match[1]!);
        } else if (!container && /(?:^|[.\s"'])mcp_servers(?:[.\s"']|$)/.test(trimmed)) throw new Error('codex_managed_mcp_section_unsupported');
      } else if (container) throw new Error('codex_managed_mcp_config_requires_section_headers');
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    if (error instanceof Error && error.message.startsWith('codex_managed_')) throw error;
    throw new Error('codex_managed_config_unreadable');
  } finally { lines.close(); }
  return [...names];
}
function ancestorConfigs(cwd: string): string[] {
  const result: string[] = []; let current = resolve(cwd);
  while (true) { result.push(join(current, '.codex', 'config.toml')); const parent = dirname(current); if (parent === current) return result; current = parent; }
}
export async function managedCodexArgs(options: { cwd: string; configHome?: string; launchCwd?: string; systemConfig?: string }): Promise<string[]> {
  const configHome = options.configHome ?? process.env.CODEX_HOME ?? join(homedir(), '.codex');
  const paths = new Set([join(configHome, 'config.toml'), options.systemConfig ?? '/etc/codex/config.toml', ...ancestorConfigs(options.cwd), ...ancestorConfigs(options.launchCwd ?? process.cwd())]);
  const names = new Set<string>();
  for (const path of paths) for (const name of await mcpSections(path)) names.add(name);
  return [...managedFeaturesDisabled.flatMap(feature => ['--disable', feature]), ...[...names].flatMap(name => ['-c', `mcp_servers.${name}.enabled=false`]), '-c', 'web_search="disabled"', 'app-server', '--stdio'];
}
export async function verifyManagedCli(command: string): Promise<void> {
  let output: string;
  try { output = (await promisify(execFile)(command, ['features', 'list'], { timeout: 10_000, maxBuffer: 128 * 1024 })).stdout; }
  catch { throw new Error(managedCompatibilityMessage); }
  const supported = new Set(output.split(/\r?\n/).map(line => /^([a-z_]+)\s+/.exec(line)?.[1]));
  if (managedFeaturesDisabled.some(feature => !supported.has(feature))) throw new Error(managedCompatibilityMessage);
}
