import { DEFAULT_THEME, MODULES, botTokenSchema, type BotConfig } from '@open-signal/shared';
import { loadEnv } from '../src/config/env.ts';
import { createSecretBoxFromEnv, createStore } from '../src/app.ts';
import { maskBotToken } from '../src/lib/crypto.ts';
import { newId } from '../src/lib/ids.ts';
import { tokenAad } from '../src/domain/bots.ts';
import { C } from '../src/storage/collections.ts';

/**
 * Creates ONE local development bot in the local store so the Mini App and
 * API can be explored before the admin panel can create bots (Stage 2).
 *
 * - Without DEV_BOT_TOKEN the bot has no Telegram token: the Mini App shows its
 *   theme and screens, but Telegram sign-in is impossible (honestly reported).
 * - With DEV_BOT_TOKEN (typed by you into apps/api/.env, never shared) the token
 *   is stored encrypted. No webhook is registered — that is Stage 3.
 */
const env = loadEnv();
if (env.STORAGE_DRIVER !== 'local') throw new Error('seed-dev works only with STORAGE_DRIVER=local');

const store = createStore(env);
const box = createSecretBoxFromEnv(env);

const existing = await store.query<{ id: string }>(C.bots, { where: [{ field: 'devOnly', op: '==', value: true }], limit: 1 });
if (existing[0]) {
  process.stdout.write(`Dev bot already exists: ${existing[0].id}\n`);
  printUrls(existing[0].id);
  await store.close();
  process.exit(0);
}

const rawToken = process.env['DEV_BOT_TOKEN']?.trim();
let token: string | null = null;
if (rawToken) {
  const parsed = botTokenSchema.safeParse(rawToken);
  if (!parsed.success) throw new Error('DEV_BOT_TOKEN has an invalid format');
  token = parsed.data;
}

const botId = `dev${newId().replace(/[^A-Za-z0-9]/g, '').slice(0, 10)}`;
const now = new Date().toISOString();
const modules = Object.fromEntries(MODULES.map((m) => [m, true])) as BotConfig['modules'];
const config: BotConfig = {
  name: 'Open Signal Dev',
  username: 'OpenSignalDevBot',
  description: { ru: 'Локальный бот для разработки', uk: 'Локальний бот для розробки', en: 'Local development bot' },
  shortDescription: {},
  miniAppTitle: 'OPEN SIGNAL AI',
  defaultLanguage: 'ru',
  theme: DEFAULT_THEME,
  avatarMediaId: null,
  logoMediaId: null,
  supportContact: '',
  modules,
  accountBinding: {
    traderIdPattern: '^[A-Za-z0-9_-]{3,64}$',
    gatedModules: ['signals'],
    partnerLinkTemplate: null,
    recheckCooldownSec: 30,
    supportHintAfterHours: 24,
  },
};

await store.create(C.bots, botId, {
  id: botId,
  status: 'active',
  telegramBotId: token ? Number(token.split(':')[0]) : null,
  tokenEnc: token ? box.encrypt(token, tokenAad(botId)) : null,
  tokenMasked: token ? maskBotToken(token) : null,
  webhookSecretHash: null,
  devOnly: true,
  createdAt: now,
  updatedAt: now,
  archivedAt: null,
});
await store.create(C.botConfigs, botId, { ...config, botId, updatedAt: now });
await store.close();

process.stdout.write(`Dev bot created: ${botId}${token ? ` (token ${maskBotToken(token)})` : ' (no Telegram token)'}\n`);
printUrls(botId);

function printUrls(id: string) {
  process.stdout.write(`Mini App:  http://localhost:5173/?bot=${id}\nPublic config: http://localhost:${env.PORT}/api/public/bots/${id}/config\n`);
}
