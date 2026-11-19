#!/usr/bin/env node
import { access, chmod, copyFile, cp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Only built local-worker workspaces are copied. Never include .env, user config, logs, journals or credentials.
const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const output = process.argv[2] && resolve(process.argv[2]);
if (!output) throw Error('Usage: node apps/node/scripts/bundle.mjs /absolute/new/release-directory');
const packages = ['protocol', 'tool-broker', 'runtime-codex', 'runtime-grok'];
for (const location of ['apps/node', ...packages.map(name => `packages/${name}`)]) await access(join(repository, location, 'dist'));
await mkdir(output, { mode: 0o700 }); // Refuse to overwrite an existing release.
try {
 for (const location of ['apps/node', ...packages.map(name => `packages/${name}`)]) {
  const target = join(output, location); await mkdir(target, { recursive: true });
  await cp(join(repository, location, 'dist'), join(target, 'dist'), { recursive: true });
  await copyFile(join(repository, location, 'package.json'), join(target, 'package.json'));
 }
 const modules = join(output, 'node_modules', '@super-agent'); await mkdir(modules, { recursive: true });
 for (const name of packages) await symlink(`../../packages/${name}`, join(modules, name));
 await writeFile(join(output, 'package.json'), JSON.stringify({ private: true, type: 'module', engines: { node: '>=24.14.0' } }, null, 2) + '\n', { mode: 0o600 });
 await chmod(join(output, 'apps/node/dist/cli.js'), 0o700);
 process.stdout.write(`Worker release prepared: ${output}\nUse the target Mac's Node 24.14+ to run apps/node/dist/cli.js; no pnpm install or server infrastructure is needed.\n`);
} catch (error) { await rm(output, { recursive: true, force: true }); throw error; }
