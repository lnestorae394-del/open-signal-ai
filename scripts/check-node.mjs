// Preflight: the project runs TypeScript directly with Node's built-in type
// stripping, which is enabled by default starting with Node.js 22.18.0.
// Plain .mjs on purpose — it must run on any Node version and explain the problem.
const [major, minor] = process.versions.node.split('.').map(Number);
const ok = major > 22 || (major === 22 && minor >= 18);
if (!ok) {
  console.error(
    [
      '',
      `✖ Node.js ${process.versions.node} is too old for OPEN SIGNAL AI (need 22.18.0 or newer).`,
      '  Reason: tests and the API run TypeScript natively (type stripping), enabled by default from Node 22.18.',
      '  Fix: install the current Node.js 22 LTS from https://nodejs.org (see docs/setup-from-scratch.md).',
      '',
    ].join('\n'),
  );
  process.exit(1);
}
