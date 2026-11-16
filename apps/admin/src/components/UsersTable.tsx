import { useCallback, useEffect, useState } from 'react';
import { BINDING_STATES, type DepositStatus, type OnboardingStatus } from '@open-signal/shared';
import { Badge, Button, EmptyState, IconUsers, Notice, Panel, Select } from '@open-signal/ui';
import { useI18n } from '../i18n.tsx';
import { api, errorText } from '../lib/api.ts';
import type { BotSummary } from '../lib/types.ts';
import { dateTime } from '../lib/format.ts';
import { Loading } from './layout.tsx';

export interface UserRow {
  botId: string;
  botName: string;
  telegramId: number;
  username: string | null;
  firstName: string;
  languageCode: string | null;
  createdAt: string;
  lastSeenAt: string | null;
  launches: number;
  bindingState: (typeof BINDING_STATES)[number];
  onboardingStatus: OnboardingStatus;
  verification: 'not_submitted' | 'failed' | 'confirmed' | 'review';
  lastBindingError: string | null;
  depositCheck: 'awaiting' | 'checking' | 'confirmed' | 'error';
  traderId: string | null;
  traderIdMasked: string | null;
  registrationStartedAt: string | null;
  deposit: { status: DepositStatus; ftdAmount: number | null; ftdCurrency: string | null; ftdAt: string | null; depositsCount: number } | null;
}

const VERIFY_TONE = { not_submitted: 'neutral', failed: 'warning', confirmed: 'success', review: 'danger' } as const;
const CHECK_TONE = { awaiting: 'neutral', checking: 'warning', confirmed: 'success', error: 'danger' } as const;
const ONB_TONE: Record<OnboardingStatus, 'neutral' | 'info' | 'warning' | 'success' | 'danger'> = {
  registration: 'neutral',
  registration_started: 'info',
  trader_id: 'info',
  deposit: 'warning',
  needs_support: 'danger',
  completed: 'success',
};

/**
 * Users list. With `botId` it shows one bot (bot page); without it, every bot
 * the admin may see, with a bot filter (Users section).
 */
export function UsersTable({ botId, bots }: { botId?: string; bots?: BotSummary[] }) {
  const { t, lang } = useI18n();
  const [bot, setBot] = useState(botId ?? '');
  const [state, setState] = useState('');
  const [rows, setRows] = useState<UserRow[] | null>(null);
  const [next, setNext] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    async (before: string | null) => {
      try {
        const q = new URLSearchParams({ ...(state ? { state } : {}), ...(before ? { before } : {}), ...(!botId && bot ? { botId: bot } : {}) });
        const path = botId ? `/bots/${botId}/users?${q}` : `/users?${q}`;
        const r = await api<{ users: UserRow[]; nextBefore: string | null }>('GET', path);
        setRows((prev) => (before && prev ? [...prev, ...r.users] : r.users));
        setNext(r.nextBefore);
        setError(null);
      } catch (e) {
        setError(errorText(t, e));
      }
    },
    [botId, bot, state, t],
  );
  useEffect(() => {
    setRows(null);
    void load(null);
  }, [load]);

  const money = (d: NonNullable<UserRow['deposit']>) =>
    d.ftdAmount !== null ? new Intl.NumberFormat(lang, { style: 'currency', currency: d.ftdCurrency ?? 'USD' }).format(d.ftdAmount) : null;

  return (
    <Panel className="overflow-hidden">
      <div className="flex flex-wrap items-center gap-3 p-4">
        {!botId && bots ? (
          <div className="w-full max-w-[240px]">
            <Select ariaLabel={t('admin.users.bot')} value={bot} onChange={setBot} options={[{ value: '', label: t('admin.users.allBots') }, ...bots.map((b) => ({ value: b.botId, label: b.name }))]} />
          </div>
        ) : null}
        <div className="w-full max-w-[260px]">
          <Select
            ariaLabel={t('admin.users.binding')}
            value={state}
            onChange={setState}
            options={[{ value: '', label: t('admin.users.filterAll') }, ...BINDING_STATES.map((s) => ({ value: s, label: t(`binding.state.${s}`) }))]}
          />
        </div>
      </div>
      {error ? <Notice tone="danger" className="m-4">{error}</Notice> : null}
      {!rows ? <Loading /> : rows.length === 0 ? (
        <EmptyState icon={<IconUsers />} text={t('admin.users.empty')} />
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[980px] text-left text-[14px]">
            <thead className="text-[13px] text-muted">
              <tr className="border-y border-line">
                <th className="px-4 py-2.5 font-medium">{t('admin.users.user')}</th>
                {!botId ? <th className="px-4 py-2.5 font-medium">{t('admin.users.bot')}</th> : null}
                <th className="px-4 py-2.5 font-medium">Trader ID</th>
                <th className="px-4 py-2.5 font-medium">{t('admin.users.joined')}</th>
                <th className="px-4 py-2.5 font-medium">{t('admin.users.onboarding')}</th>
                <th className="px-4 py-2.5 font-medium">{t('admin.users.verification')}</th>
                <th className="px-4 py-2.5 font-medium">{t('admin.users.deposit')}</th>
                <th className="px-4 py-2.5 font-medium">{t('admin.users.launches')}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((u) => (
                <tr key={`${u.botId}_${u.telegramId}`} className="border-b border-line align-top last:border-0">
                  <td className="px-4 py-3">
                    <div className="font-medium">{u.firstName}{u.username ? <span className="text-muted"> @{u.username}</span> : null}</div>
                    <div className="os-num text-[12px] text-muted">{u.telegramId}</div>
                  </td>
                  {!botId ? (
                    <td className="px-4 py-3">
                      <a href={`#/bots/${u.botId}/users`} className="hover:text-primary">{u.botName}</a>
                      <div className="os-num text-[12px] text-muted">{u.botId}</div>
                    </td>
                  ) : null}
                  <td className="os-num px-4 py-3">{u.traderId ?? '—'}</td>
                  <td className="px-4 py-3 text-muted">{dateTime(u.createdAt, lang)}</td>
                  <td className="px-4 py-3"><Badge tone={ONB_TONE[u.onboardingStatus]} dot>{t(`admin.onboarding.${u.onboardingStatus}`)}</Badge></td>
                  <td className="px-4 py-3">
                    <Badge tone={VERIFY_TONE[u.verification]}>{t(`admin.verification.${u.verification}`)}</Badge>
                    {u.lastBindingError ? <div className="mt-1 text-[12px] text-muted">{t(`admin.bindingFailure.${u.lastBindingError}`)}</div> : null}
                  </td>
                  <td className="px-4 py-3">
                    <Badge tone={CHECK_TONE[u.depositCheck]}>{t(`onb.check.${u.depositCheck}`)}</Badge>
                    {u.deposit && money(u.deposit) ? <div className="os-num mt-1 text-[12px] text-muted">{money(u.deposit)}, {dateTime(u.deposit.ftdAt, lang)}{u.deposit.depositsCount > 1 ? ` (+${u.deposit.depositsCount - 1})` : ''}</div> : null}
                  </td>
                  <td className="os-num px-4 py-3">{u.launches}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {next ? (
        <div className="p-4">
          <Button variant="secondary" onClick={() => void load(next)}>{t('admin.users.loadMore')}</Button>
        </div>
      ) : null}
    </Panel>
  );
}
