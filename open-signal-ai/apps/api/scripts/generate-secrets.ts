import { randomBytes } from 'node:crypto';
import { generateKeyBase64 } from '../src/lib/crypto.ts';

/**
 * Prints freshly generated secrets for YOUR local .env file.
 * Run on your own computer:  npm run gen:key -w @open-signal/api
 * Copy the lines into apps/api/.env. Never paste them into chats, issues or git.
 */
process.stdout.write(
  [
    '# Generated locally — keep private',
    `ENCRYPTION_KEY=${generateKeyBase64()}`,
    'ENCRYPTION_KEY_ID=k1',
    `SESSION_SECRET=${randomBytes(48).toString('base64url')}`,
    '',
  ].join('\n'),
);
