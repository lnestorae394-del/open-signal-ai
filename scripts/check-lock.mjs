// Dependency lock check (plain .mjs: runs before anything else is installed).
//  1. package-lock.json must exist (created by the first `npm install`, then committed to git);
//  2. it must describe the same direct dependencies as the package.json files;
//  3. what is installed in node_modules must be exactly the version written in the lock.
// Render runs `npm install`, which installs the exact versions from a committed lock.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = new URL('..', import.meta.url).pathname;
const fail = (lines) => {
  console.error(['', ...lines.map((l, i) => (i === 0 ? `✖ ${l}` : `  ${l}`)), ''].join('\n'));
  process.exit(1);
};

const lockPath = join(root, 'package-lock.json');
if (!existsSync(lockPath)) {
  fail([
    'package-lock.json is missing.',
    'Run `npm install` once in the project folder: it creates package-lock.json.',
    'Then add it to git: git add package-lock.json',
  ]);
}
const lock = JSON.parse(readFileSync(lockPath, 'utf8'));
if (!(lock.lockfileVersion >= 3)) fail([`package-lock.json has lockfileVersion ${lock.lockfileVersion}; npm 9+ (bundled with Node 22) writes version 3.`, 'Delete it and run `npm install` again.']);

const workspaces = ['', 'apps/admin', 'apps/api', 'apps/miniapp', 'packages/shared', 'packages/ui', 'packages/i18n'];
const problems = [];
for (const ws of workspaces) {
  const pkg = JSON.parse(readFileSync(join(root, ws, 'package.json'), 'utf8'));
  const entry = lock.packages?.[ws];
  if (!entry) {
    problems.push(`${ws || 'root'}: not in package-lock.json`);
    continue;
  }
  for (const sec of ['dependencies', 'devDependencies']) {
    for (const [name, range] of Object.entries(pkg[sec] ?? {})) {
      if ((entry[sec] ?? {})[name] !== range) problems.push(`${ws || 'root'}: ${name}@${range} in package.json, ${entry[sec]?.[name] ?? 'nothing'} in package-lock.json`);
    }
  }
}
if (problems.length) fail(['package-lock.json does not match package.json:', ...problems, 'Run `npm install` to update the lock, then commit both files.']);

// Installed versions = locked versions (only checked when node_modules exists).
if (existsSync(join(root, 'node_modules'))) {
  for (const [path, meta] of Object.entries(lock.packages ?? {})) {
    // Workspace links and platform-specific optional packages (e.g. esbuild builds for other OSes) are skipped.
    if (!path.startsWith('node_modules/') || meta.link || meta.optional) continue;
    const pj = join(root, path, 'package.json');
    if (!existsSync(pj)) {
      if (!meta.optional && !meta.peer) problems.push(`${path.slice(13)}: locked ${meta.version}, not installed`);
      continue;
    }
    const v = JSON.parse(readFileSync(pj, 'utf8')).version;
    if (meta.version && v !== meta.version) problems.push(`${path.slice(13)}: locked ${meta.version}, installed ${v}`);
  }
  if (problems.length) fail(['node_modules differs from package-lock.json:', ...problems.slice(0, 20), 'Run `npm ci` (clean install from the lock).']);
}
console.log(`✓ package-lock.json v${lock.lockfileVersion}: ${Object.keys(lock.packages ?? {}).filter((p) => p.startsWith('node_modules/')).length} packages locked, matches package.json`);
