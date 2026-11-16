// Production build of the Admin panel and the Mini App.
//   node scripts/build-web.mjs           → dist/web/{admin,app}
//   node scripts/build-web.mjs --watch   → rebuild on change (development)
//
// JS: esbuild (bundled, minified, content-hashed). CSS: Tailwind CSS v4 compiler
// API, with class candidates collected from the sources of each app + packages/ui.
import { build, context } from 'esbuild';
import { compile } from 'tailwindcss';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'dist/web');
const require = createRequire(import.meta.url);
const TAILWIND_DIR = dirname(require.resolve('tailwindcss/package.json'));
const watch = process.argv.includes('--watch');

const APPS = [
  { name: 'admin', dir: 'apps/admin', title: 'OPEN SIGNAL AI · Control center', telegram: false },
  { name: 'app', dir: 'apps/miniapp', title: 'OPEN SIGNAL AI', telegram: true },
];

function walk(dir, acc = []) {
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) walk(p, acc);
    else if (/\.(tsx?|html)$/.test(f)) acc.push(p);
  }
  return acc;
}

const hash = (buf) => createHash('sha256').update(buf).digest('hex').slice(0, 10);

async function buildCss(app) {
  const entry = join(ROOT, app.dir, 'src/index.css');
  const compiler = await compile(readFileSync(entry, 'utf8'), {
    base: dirname(entry),
    loadStylesheet: async (id, base) => {
      const path = id === 'tailwindcss' ? join(TAILWIND_DIR, 'index.css') : resolve(base, id);
      return { path, base: dirname(path), content: readFileSync(path, 'utf8') };
    },
  });
  const candidates = new Set();
  for (const f of [...walk(join(ROOT, app.dir, 'src')), ...walk(join(ROOT, 'packages/ui/src'))]) {
    for (const m of readFileSync(f, 'utf8').matchAll(/[^\s"'`{}<>]+/g)) candidates.add(m[0]);
  }
  return compiler.build([...candidates]);
}

function html(app, js, css) {
  return `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover${app.telegram ? ', maximum-scale=1, user-scalable=no' : ''}">
<meta name="theme-color" content="#000000">
<meta name="color-scheme" content="dark">
${app.telegram ? '' : '<meta name="robots" content="noindex, nofollow">\n'}<title>${app.title}</title>
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='9' fill='%23FF2D46'/%3E%3Cpath d='M5 17h5l3-7 5 14 3-9 2 2h4' fill='none' stroke='white' stroke-width='2.6' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E">
<link rel="preload" href="/${app.name}/assets/fonts/inter-400.woff" as="font" type="font/woff" crossorigin>
<link rel="preload" href="/${app.name}/assets/fonts/inter-display-800.woff" as="font" type="font/woff" crossorigin>
<link rel="stylesheet" href="/${app.name}/assets/${css}">
${app.telegram ? '<script src="https://telegram.org/js/telegram-web-app.js"></script>\n' : ''}</head>
<body>
<div id="root"></div>
<script type="module" src="/${app.name}/assets/${js}"></script>
</body>
</html>
`;
}

async function buildApp(app, { minify = true } = {}) {
  const out = join(OUT, app.name);
  const assets = join(out, 'assets');
  rmSync(out, { recursive: true, force: true });
  mkdirSync(join(assets, 'fonts'), { recursive: true });

  const res = await build({
    entryPoints: [join(ROOT, app.dir, 'src/main.tsx')],
    bundle: true,
    write: false,
    minify,
    sourcemap: false,
    format: 'esm',
    target: ['es2022', 'safari15', 'chrome100'],
    jsx: 'automatic',
    loader: { '.css': 'empty' },
    define: { 'process.env.NODE_ENV': minify ? '"production"' : '"development"' },
    logLevel: 'warning',
    legalComments: 'none',
  });
  const jsCode = res.outputFiles[0].contents;
  const jsName = `app-${hash(jsCode)}.js`;
  writeFileSync(join(assets, jsName), jsCode);

  const css = await buildCss(app);
  const cssName = `app-${hash(css)}.css`;
  writeFileSync(join(assets, cssName), css);

  for (const f of readdirSync(join(ROOT, 'packages/ui/fonts'))) copyFileSync(join(ROOT, 'packages/ui/fonts', f), join(assets, 'fonts', f));
  writeFileSync(join(out, 'index.html'), html(app, jsName, cssName));
  return { app: app.name, js: jsCode.length, css: css.length, warnings: res.warnings.length };
}

async function buildAll(opts) {
  const results = [];
  for (const app of APPS) results.push(await buildApp(app, opts));
  for (const r of results) console.log(`✓ ${r.app.padEnd(5)}  js ${(r.js / 1024).toFixed(0)} KB  css ${(r.css / 1024).toFixed(0)} KB  warnings ${r.warnings}`);
  return results;
}

if (watch) {
  await buildAll({ minify: false });
  // Rebuild everything when any source changes (fast enough for two small apps).
  const ctx = await context({
    entryPoints: APPS.map((a) => join(ROOT, a.dir, 'src/main.tsx')),
    bundle: true,
    write: false,
    outdir: join(ROOT, 'dist/.watch'),
    jsx: 'automatic',
    loader: { '.css': 'empty' },
    logLevel: 'silent',
    plugins: [{ name: 'rebuild', setup: (b) => b.onEnd(() => buildAll({ minify: false }).catch((e) => console.error(e))) }],
  });
  await ctx.watch();
  console.log('watching for changes…');
} else {
  const results = await buildAll();
  if (results.some((r) => r.warnings > 0)) process.exitCode = 1;
  if (!existsSync(join(OUT, 'admin/index.html')) || !existsSync(join(OUT, 'app/index.html'))) process.exitCode = 1;
}
