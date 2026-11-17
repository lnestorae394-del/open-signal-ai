import { useEffect, useState } from 'react';
import { Badge, EmptyState, IconBot, Notice, Panel, Select } from '@open-signal/ui';
import { useI18n } from '../i18n.tsx';
import { useMe } from '../session.tsx';
import { api, errorText } from '../lib/api.ts';
import type { BotDetail, BotSummary } from '../lib/types.ts';
import { Loading, PageTitle } from '../components/layout.tsx';
import { UsersTable } from '../components/UsersTable.tsx';
import { SettingsTab } from './BotDetail.tsx';

function useBots() {
  const { t } = useI18n();
  const [bots, setBots] = useState<BotSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api<{ bots: BotSummary[] }>('GET', '/bots').then((r) => setBots(r.bots), (e: unknown) => setError(errorText(t, e)));
  }, [t]);
  return { bots, error };
}

/** All users of every bot the admin may see, with a bot filter. */
export function UsersPage() {
  const { t } = useI18n();
  const { bots, error } = useBots();
  return (
    <div className="os-enter">
      <PageTitle title={t('admin.users.title')} subtitle={t('admin.users.subtitle')} />
      {error ? <Notice tone="danger">{error}</Notice> : !bots ? <Loading /> : <UsersTable bots={bots} />}
    </div>
  );
}

interface SystemInfo {
  nodeVersion: string;
  environment: string;
  publicUrl: string;
  storage: string;
  indexes: { total?: number; ready?: number; building?: number; error?: string | null };
  languages: string[];
  encryptionKeyId: string;
  previousKeyConfigured: boolean;
  sessionTtlSec: number;
  adminSessionTtlSec: number;
  initDataMaxAgeSec: number;
  corsOrigins: string[];
  signalEngine: string;
}


/** Settings: languages and Mini App, Forex, OTC per bot, plus system parameters. */
export function SettingsPage() {
  const { t } = useI18n();
  const me = useMe();
  const { bots, error } = useBots();
  const [botId, setBotId] = useState('');
  const [bot, setBot] = useState<BotDetail | null>(null);
  const [botError, setBotError] = useState<string | null>(null);
  const [system, setSystem] = useState<SystemInfo | null>(null);

  useEffect(() => {
    if (bots?.length && !botId) setBotId(bots[0]!.botId);
  }, [bots, botId]);
  useEffect(() => {
    if (!botId) return;
    setBot(null);
    api<{ bot: BotDetail }>('GET', `/bots/${botId}`).then((r) => (setBot(r.bot), setBotError(null)), (e: unknown) => setBotError(errorText(t, e)));
  }, [botId, t]);
  useEffect(() => {
    if (me.role === 'owner') void api<{ system: SystemInfo }>('GET', '/system').then((r) => setSystem(r.system), () => undefined);
  }, [me.role]);

  return (
    <div className="os-enter">
      <PageTitle title={t('admin.settings.title')} subtitle={t('admin.settings.subtitle')} />
      {error ? <Notice tone="danger">{error}</Notice> : !bots ? <Loading /> : bots.length === 0 ? (
        <Panel><EmptyState icon={<IconBot />} text={t('admin.dashboard.noBotsText')} /></Panel>
      ) : (
        <>
          <div className="mb-6 flex flex-col gap-3 md:flex-row md:items-center">
            <div className="w-full md:max-w-xs">
              <Select ariaLabel={t('admin.users.bot')} value={botId} onChange={setBotId} options={bots.map((b) => ({ value: b.botId, label: `${b.name} (@${b.username})` }))} />
            </div>
          </div>
          {botError ? <Notice tone="danger">{botError}</Notice> : !bot ? <Loading /> : <SettingsTab key={bot.botId} bot={bot} onSaved={setBot} />}
        </>
      )}

      {system ? (
        <Panel className="mt-8 p-5 lg:p-6">
          <h2 className="text-[17px] font-semibold">{t('admin.settings.system')}</h2>
          <p className="mt-1 text-[14px] text-muted">{t('admin.settings.systemHint')}</p>
          <dl className="mt-5 grid gap-x-8 gap-y-4 text-[14px] md:grid-cols-2 xl:grid-cols-3">
            {[
              [t('admin.settings.publicUrl'), system.publicUrl],
              [t('admin.settings.environment'), system.environment],
              ['Node.js', system.nodeVersion],
              [t('admin.dashboard.storage'), system.storage === 'firestore' ? 'Firestore' : t('admin.dashboard.local')],
              [t('admin.dashboard.indexes'), system.indexes.error ? system.indexes.error : system.indexes.total !== undefined ? t('admin.dashboard.indexesReady', { ready: system.indexes.ready ?? 0, total: system.indexes.total }) : t('admin.dashboard.indexesPending')],
              [t('admin.settings.languages'), system.languages.map((l) => l.toUpperCase()).join(', ')],
              [t('admin.settings.encryption'), `AES-256-GCM, ${system.encryptionKeyId}${system.previousKeyConfigured ? `, ${t('admin.settings.previousKey')}` : ''}`],
              [t('admin.settings.sessionTtl'), `${Math.round(system.sessionTtlSec / 3600)} h / ${Math.round(system.adminSessionTtlSec / 86400)} d`],
              [t('admin.settings.initDataAge'), `${system.initDataMaxAgeSec} s`],
              ['CORS', system.corsOrigins.length ? system.corsOrigins.join(', ') : t('admin.settings.sameOrigin')],
            ].map(([k, v]) => (
              <div key={k}>
                <dt className="text-[13px] text-muted">{k}</dt>
                <dd className="mt-0.5 break-all">{v}</dd>
              </div>
            ))}
            <div>
              <dt className="text-[13px] text-muted">{t('admin.settings.marketData')}</dt>
              <dd className="mt-1"><Badge tone="warning">{t('admin.signals.engineTraining')}</Badge></dd>
            </div>
          </dl>
        </Panel>
      ) : null}
    </div>
  );
}
