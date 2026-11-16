import { useEffect, useState } from 'react';
import { Badge, Button, EmptyState, IconBot, IconPlus, Notice, Panel, type Tone } from '@open-signal/ui';
import type { BotConfigEdit, BotStatus } from '@open-signal/shared';
import { useI18n } from '../i18n.tsx';
import { useMe } from '../session.tsx';
import { api, ApiError, errorText } from '../lib/api.ts';
import type { BotSummary } from '../lib/types.ts';
import { Loading, PageTitle, navigate } from '../components/layout.tsx';
import { BotForm, EMPTY_CONFIG } from '../components/BotForm.tsx';

export const STATUS_TONE: Record<BotStatus, Tone> = { active: 'success', disabled: 'warning', archived: 'neutral', token_invalid: 'danger' };
const STATUS_KEY: Record<BotStatus, string> = { active: 'statusActive', disabled: 'statusDisabled', archived: 'statusArchived', token_invalid: 'statusTokenInvalid' };
export const statusKey = (s: BotStatus) => `admin.bots.${STATUS_KEY[s]}`;

export function BotsPage() {
  const { t } = useI18n();
  const me = useMe();
  const [bots, setBots] = useState<BotSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api<{ bots: BotSummary[] }>('GET', '/bots').then((r) => setBots(r.bots), (e: unknown) => setError(errorText(t, e)));
  }, [t]);

  return (
    <div className="os-enter">
      <PageTitle
        title={t('admin.bots.title')}
        action={me.role === 'owner' ? <Button icon={<IconPlus size={18} />} onClick={() => navigate('/bots/new')}>{t('admin.bots.create')}</Button> : undefined}
      />
      {error ? <Notice tone="danger">{error}</Notice> : null}
      {!bots && !error ? <Loading /> : null}
      {bots && bots.length === 0 ? (
        <Panel className="p-6">
          <EmptyState icon={<IconBot />} title={t('admin.dashboard.noBots')} text={t('admin.dashboard.noBotsText')} />
        </Panel>
      ) : null}
      {bots && bots.length ? (
        <ul className="grid gap-4 md:grid-cols-2">
          {bots.map((b) => (
            <li key={b.botId}>
              <a href={`#/bots/${b.botId}/settings`} className="group block overflow-hidden rounded-[24px] border border-line bg-card transition-colors hover:border-line-strong">
                <div className="flex h-2" aria-hidden>
                  {[b.theme.primary, b.theme.secondary, b.theme.accent, b.theme.buttonTo].map((c, i) => (
                    <span key={i} className="flex-1" style={{ background: c }} />
                  ))}
                </div>
                <div className="p-5">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="truncate text-[19px] font-semibold tracking-[-0.015em]">{b.name}</div>
                      <div className="truncate text-[14px] text-muted">@{b.username}</div>
                    </div>
                    <Badge tone={STATUS_TONE[b.status]} dot>{t(statusKey(b.status))}</Badge>
                  </div>
                  <div className="mt-5 flex items-end justify-between gap-3">
                    <div>
                      <div className="os-display os-num text-[32px]">{b.usersCount}</div>
                      <div className="text-[13px] text-muted">{t('admin.dashboard.users')}</div>
                    </div>
                    <div className="flex flex-col items-end gap-1.5">
                      {b.telegram?.issues.length ? (
                        <Badge tone="warning">{t('admin.bots.telegramIssues', { n: b.telegram.issues.length })}</Badge>
                      ) : b.telegram?.webhookUrl ? (
                        <Badge tone="success">{t('admin.bots.telegramOk')}</Badge>
                      ) : null}
                      <Badge tone={b.partnerConfigured ? 'success' : 'neutral'}>{b.partnerConfigured ? t('admin.partner.configured') : t('admin.partner.notConfigured')}</Badge>
                    </div>
                  </div>
                </div>
              </a>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

export function BotNewPage() {
  const { t } = useI18n();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fields, setFields] = useState<Record<string, string>>({});

  const create = async (config: BotConfigEdit, token: string) => {
    setBusy(true);
    setError(null);
    setFields({});
    try {
      const r = await api<{ bot: BotSummary }>('POST', '/bots', { ...config, token });
      navigate(`/bots/${r.bot.botId}/settings`);
    } catch (e) {
      if (e instanceof ApiError) setFields(e.code === 'TELEGRAM_TOKEN_INVALID' || e.code === 'BOT_ALREADY_CONNECTED' ? { token: errorText(t, e) } : e.fields);
      setError(errorText(t, e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="os-enter">
      <PageTitle title={t('admin.editor.title')} subtitle={t('admin.editor.subtitle')} back={{ href: '#/bots', label: t('admin.bots.title') }} />
      {error ? <Notice tone="danger" className="mb-5">{error}</Notice> : null}
      <BotForm mode="create" initial={EMPTY_CONFIG} busy={busy} serverFields={fields} onSubmit={create} submitLabel={busy ? t('admin.editor.connecting') : t('admin.editor.connect')} />
    </div>
  );
}
