// Local development: rebuilds the web apps on change and restarts the API on change.
// Uses .env in the repository root (create it with: npm run gen:secrets > .env).
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';

if (!existsSync('.env')) {
  console.error('\n✖ .env is missing. Create it with:\n\n    npm run gen:secrets > .env\n');
  process.exit(1);
}
const procs = [
  spawn(process.execPath, ['scripts/build-web.mjs', '--watch'], { stdio: 'inherit' }),
  spawn(process.execPath, ['--env-file=.env', '--watch', 'apps/api/src/server.ts'], { stdio: 'inherit', env: { ...process.env, NODE_ENV: 'development' } }),
];
const stop = () => {
  for (const p of procs) p.kill('SIGTERM');
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
console.log('\nAdmin panel: http://localhost:8080/admin/\nMini App:    http://localhost:8080/app/?bot=<botId>\n');
