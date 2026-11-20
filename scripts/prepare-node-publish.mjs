import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

// Assemble one installable package. Workspace packages stay @super-agent/* inside
// the tarball so existing imports keep working; only the published name uses the scope.
const root = resolve(import.meta.dirname, '..');
const target = resolve(process.argv[2] ?? '');
if (!process.argv[2]) throw new Error('usage: node scripts/prepare-node-publish.mjs <output-dir>');

const packages = {
  '@super-agent/protocol': 'packages/protocol',
  '@super-agent/tool-broker': 'packages/tool-broker',
  '@super-agent/runtime-codex': 'packages/runtime-codex',
  '@super-agent/runtime-grok': 'packages/runtime-grok',
};

function readPackage(relativeDir) {
  const dir = join(root, relativeDir);
  const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
  const entry = pkg.main ?? 'dist/index.js';
  if (!readFileSync(join(dir, entry)).length) throw new Error(`${relativeDir} dist is empty`);
  return { dir, pkg };
}

function vendored(relativeDir) {
  const { dir, pkg } = readPackage(relativeDir);
  const dependencies = {};
  for (const [name, range] of Object.entries(pkg.dependencies ?? {})) {
    const source = packages[name];
    if (!source || !String(range).startsWith('workspace:')) throw new Error(`${pkg.name} depends on ${name}@${range}, which this pack does not vendor`);
    dependencies[name] = JSON.parse(readFileSync(join(root, source, 'package.json'), 'utf8')).version;
  }
  return {
    manifest: {
      name: pkg.name,
      version: pkg.version,
      type: 'module',
      ...(pkg.main ? { main: pkg.main } : {}),
      ...(pkg.types ? { types: pkg.types } : {}),
      ...(pkg.exports ? { exports: pkg.exports } : {}),
      files: ['dist'],
      ...(Object.keys(dependencies).length ? { dependencies } : {}),
    },
    dir,
  };
}

const nodePkg = JSON.parse(readFileSync(join(root, 'apps/node/package.json'), 'utf8'));
const vendoredPackages = Object.fromEntries(Object.entries(packages).map(([name, relativeDir]) => [name, vendored(relativeDir)]));
rmSync(target, { recursive: true, force: true });
mkdirSync(target, { recursive: true });
cpSync(join(root, 'apps/node/dist'), join(target, 'dist'), { recursive: true });

const dependencies = Object.fromEntries(Object.entries(vendoredPackages).map(([name, item]) => [name, item.manifest.version]));
const manifest = {
  name: '@aimo-supa-agent/node',
  version: nodePkg.version,
  description: 'Super Agent execution node. Model credentials stay on the computer that runs it.',
  type: 'module',
  bin: { 'super-agent-node': 'dist/cli.js' },
  files: ['dist'],
  engines: { node: '>=24.14.0' },
  repository: { type: 'git', url: 'git+https://github.com/ximing/super-agent.git', directory: 'apps/node' },
  dependencies,
  bundleDependencies: Object.keys(dependencies),
};
writeFileSync(join(target, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`);
writeFileSync(join(target, 'README.md'), `# @aimo-supa-agent/node

\`\`\`sh
npm install -g @aimo-supa-agent/node
super-agent-node --help
\`\`\`

Requires Node.js 24.14 or newer. The command connects to a cloud control server and keeps model credentials on this computer.
`);

for (const [name, item] of Object.entries(vendoredPackages)) {
  const destination = join(target, 'node_modules', ...name.split('/'));
  mkdirSync(destination, { recursive: true });
  writeFileSync(join(destination, 'package.json'), `${JSON.stringify(item.manifest, null, 2)}\n`);
  cpSync(join(item.dir, 'dist'), join(destination, 'dist'), { recursive: true });
}

process.stdout.write(`prepared ${manifest.name}@${manifest.version} at ${target}\n`);
