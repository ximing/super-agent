import { constants } from 'node:fs';
import { access } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Persist only command lookup paths, never a snapshot of the process environment. */
export function launchAgentPath(execPath: string, currentPath = ''): string {
  const common = ['/opt/homebrew/bin', '/opt/homebrew/sbin', '/usr/local/bin', '/usr/local/sbin', '/usr/bin', '/bin', '/usr/sbin', '/sbin'];
  return [...new Set([dirname(execPath), ...currentPath.split(':'), ...common].filter(path => isAbsolute(path) && !/[\x00-\x1f\x7f]/.test(path)).map(path => resolve(path)))].join(':');
}
export function launchAgentPlist(options: { execPath: string; scriptUrl: URL; configPath: string; outputDir: string; currentPath?: string }): string {
  const xml = (value: string) => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
  const args = [options.execPath, fileURLToPath(options.scriptUrl), 'start', '--config', options.configPath];
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict><key>Label</key><string>com.superagent.node</string><key>ProgramArguments</key><array>${args.map(value => `<string>${xml(value)}</string>`).join('')}</array><key>EnvironmentVariables</key><dict><key>PATH</key><string>${xml(launchAgentPath(options.execPath, options.currentPath))}</string></dict><key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>StandardOutPath</key><string>${xml(join(options.outputDir, 'node.log'))}</string><key>StandardErrorPath</key><string>${xml(join(options.outputDir, 'node-error.log'))}</string></dict></plist>\n`;
}
const csiUnavailable = 'CSI browser service is unavailable; other tasks can continue. See the Mac node setup instructions.';
export async function ensureCsiStarted(fake: boolean, options: {
  home?: string;
  checkExecutable?: (path: string) => Promise<void>;
  run?: (command: string, args: string[]) => Promise<unknown>;
  log?: (message: string) => void;
} = {}): Promise<'skipped-fake' | 'ready' | 'unavailable'> {
  if (fake) return 'skipped-fake';
  const command = join(options.home ?? homedir(), '.csi', 'bin', 'csi');
  try {
    await (options.checkExecutable ?? (async path => access(path, constants.X_OK)))(command);
    // CSI's documented start is idempotent and never installs/restarts/stops the daemon.
    await (options.run ?? (async (path, args) => promisify(execFile)(path, args, { timeout: 10_000, maxBuffer: 64 * 1024 })))(command, ['start']);
    return 'ready';
  } catch {
    options.log?.(csiUnavailable);
    return 'unavailable';
  }
}
