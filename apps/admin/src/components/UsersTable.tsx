import { Fragment, useCallback, useEffect, useState } from 'react';
import { BINDING_STATES, type DepositStatus, type OnboardingStatus } from '@open-signal/shared';
import { Badge, Button, EmptyState, IconUsers, Input, Notice, Panel, Select, cx } from '@open-signal/ui';
import { useI18n } from '../i18n.tsx';
import { api, errorText } from '../lib/api.ts';
import type { BotSummary } from '../lib/types.ts';
import { Loading } from './layout.tsx';
import { ACCESS_TONE, UserCard, type AccessStatus, type UserCardData } from './UserCard.tsx';

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
  deposit: { status: DepositStatus; ftdAmount: number | null; ftdCurrency: string | null; ftdAt: string | null; depositsCount: number; totalAmount?: number | null } | null;
  /** Latest click_id issued to the user (null if they never opened the partner link). */
  clickId: string | null;
  /** Partner registration: Trader ID linked · link opened · not started. */
  registrationStatus: 'confirmed' | 'started' | 'not_started';
  /** Overall status: normal access, manual access, revoked, or the onboarding step. */
  accessStatus: AccessStatus;
  access: { signals: boolean; via: 'onboarding' | 'manual' | null };
  manualAccessActive: boolean;
  /** The admin may run manual actions on this user (binding.manage for the bot). */
  canManage: boolean;
}

/**
 * Users list. With `botId` it shows one bot (bot page); without it, every bot
 * the admin may see, with a bot filter (Users section).
 */
export function UsersTable({ botId, bots }: { botId?: string; bots?: BotSummary[] }) {
  const { t, lang } = useI18n();
  const [bot, setBot] = useState(botId ?? '');
  const [state, setState] = useState('');
  const [access, setAccess] = useState('');
  const [expanded, setExpanded] = useState<string | null>(null);
  const [flash, setFlash] = useState<{ tone: 'success' | 'danger'; text: string } | null>(null);
  // A manual action returns the fresh user card: the row is updated in place, no reload.
  const mergeRow = (c: UserCardData) => setRows((prev) => prev?.map((r) => (r.botId === c.botId && r.telegramId === c.telegramId ? { ...r, ...c } : r)) ?? prev);
  const [rows, setRows] = useState<UserRow[] | null>(null);
  const [next, setNext] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    async (before: string | null) => {
      try {
        const q = new URLSearchParams({ ...(state ? { state } : {}), ...(access ? { access } : {}), ...(before ? { before } : {}), ...(!botId && bot ? { botId: bot } : {}) });
        const path = botId ? `/bots/${botId}/users?${q}` : `/users?${q}`;
        const r = await api<{ users: UserRow[]; nextBefore: string | null }>('GET', path);
        setRows((prev) => (before && prev ? [...prev, ...r.users] : r.users));
        setNext(r.nextBefore);
        setError(null);
      } catch (e) {
        setError(errorText(t, e));
      }
    },
    [botId, bot, state, access, t],
  );
  useEffect(() => {
    setRows(null);
    void load(null);
  }, [load]);

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
        <div className="w-full max-w-[240px]">
          <Select
            ariaLabel={t('admin.users.accessFilter')}
            value={access}
            onChange={setAccess}
            options={[{ value: '', label: t('admin.users.accessAll') }, { value: 'manual', label: t('admin.users.accessManual') }]}
          />
        </div>
      </div>
      {error ? <Notice tone="danger" className="m-4">{error}</Notice> : null}
      {flash ? <Notice tone={flash.tone} className="m-4">{flash.text}</Notice> : null}
      {!rows ? <Loading /> : rows.length === 0 ? (
        <EmptyState icon={<IconUsers />} text={t('admin.users.empty')} />
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[1080px] text-left text-[14px]">
            <thead className="text-[13px] text-muted">
              <tr className="border-y border-line">
                <th className="px-4 py-2.5 font-medium">{t('admin.users.user')}</th>
                <th className="px-4 py-2.5 font-medium">Trader ID</th>
                <th className="px-4 py-2.5 font-medium">Click ID</th>
                <th className="px-4 py-2.5 font-medium">{t('admin.users.depositsTotal')}</th>
                <th className="px-4 py-2.5 font-medium">{t('admin.users.registration')}</th>
                <th className="px-4 py-2.5 font-medium">{t('admin.users.access')}</th>
                <th className="px-4 py-2.5 font-medium">{t('admin.users.accessSource')}</th>
                <th className="px-4 py-2.5 font-medium">{t('admin.users.actions')}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((u) => {
                const key = `${u.botId}_${u.telegramId}`;
                const isOpen = expanded === key;
                const total = u.deposit?.totalAmount ?? (u.deposit && u.depositCheck === 'confirmed' ? u.deposit.ftdAmount : null);
                return (
                <Fragment key={key}>
                <tr className={cx('border-b border-line align-top', isOpen ? 'bg-white/[0.03]' : 'last:border-0')}>
                  <td className="px-4 py-3">
                    <div className="font-medium">{u.firstName}{u.username ? <span className="text-muted"> @{u.username}</span> : null}</div>
                    <div className="os-num text-[12px] text-muted">{u.telegramId}</div>
                    {!botId ? <a href={`#/bots/${u.botId}/users`} className="mt-0.5 block text-[12px] text-muted hover:text-primary">{u.botName}</a> : null}
                  </td>
                  <td className="os-num px-4 py-3">{u.traderId ?? '—'}</td>
                  <td className="os-num px-4 py-3 text-[13px] text-muted" title={u.clickId ?? undefined}>{u.clickId ? `${u.clickId.slice(0, 10)}…` : '—'}</td>
                  <td className="px-4 py-3">
                    {total != null ? <div className="os-num">{new Intl.NumberFormat(lang, { style: 'currency', currency: 'USD' }).format(total)}</div> : <div className="text-muted">—</div>}
                    <div className="mt-1 text-[12px] text-muted">{t(`onb.check.${u.depositCheck}`)}{u.deposit && u.deposit.depositsCount > 0 ? ` · ${u.deposit.depositsCount}` : ''}</div>
                  </td>
                  <td className="px-4 py-3"><Badge tone={REG_TONE[u.registrationStatus]}>{t(`admin.users.reg.${u.registrationStatus}`)}</Badge></td>
                  <td className="px-4 py-3"><Badge tone={ACCESS_TONE[u.accessStatus] ?? 'neutral'} dot>{t(`admin.access.${u.accessStatus}`)}</Badge></td>
                  <td className="px-4 py-3 text-[13px]">{t(`admin.users.source.${accessSource(u)}`)}</td>
                  <td className="px-4 py-3">
                    <div className="flex flex-col items-start gap-2">
                      {u.canManage ? <AccessToggle row={u} onDone={(c, text) => { mergeRow(c); setFlash({ tone: 'success', text }); }} onError={(text) => setFlash({ tone: 'danger', text })} /> : null}
                      <Button size="sm" variant="ghost" aria-expanded={isOpen} onClick={() => setExpanded(isOpen ? null : key)}>
                        {isOpen ? t('admin.users.close') : t('admin.users.manage')}
                      </Button>
                    </div>
                  </td>
                </tr>
                {isOpen ? (
                  <tr className="border-b border-line bg-white/[0.03]">
                    <td colSpan={8}>
                      <UserCard row={u} onChanged={mergeRow} />
                    </td>
                  </tr>
                ) : null}
                </Fragment>
                );
              })}
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

const REG_TONE: Record<UserRow['registrationStatus'], 'success' | 'info' | 'neutral'> = { confirmed: 'success', started: 'info', not_started: 'neutral' };

/** Where access comes from: confirmed deposit (normal onboarding), manual grant, both, or none. */
function accessSource(u: UserRow): 'deposit' | 'manual' | 'both' | 'none' {
  const normal = u.access.via === 'onboarding';
  if (normal && u.manualAccessActive) return 'both';
  if (normal) return 'deposit';
  return u.manualAccessActive ? 'manual' : 'none';
}

/**
 * "Grant access" / "Revoke access" in the row. The server checks the permission, writes the
 * audit log and returns the fresh user; the reason is required and stored with the action.
 */
function AccessToggle({ row, onDone, onError }: { row: UserRow; onDone: (u: UserCardData, text: string) => void; onError: (text: string) => void }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const grant = !row.manualAccessActive;
  const label = grant ? t('admin.users.grantAccess') : t('admin.users.revokeAccess');
  if (!open) {
    return <Button size="sm" variant={grant ? 'primary' : 'danger'} onClick={() => setOpen(true)}>{label}</Button>;
  }
  const submit = async () => {
    setBusy(true);
    try {
      const r = await api<{ user: UserCardData }>('POST', `/bots/${row.botId}/users/${row.telegramId}/manual-access`, { grant, reason });
      onDone(r.user, grant ? t('admin.userCard.done.grant') : t('admin.userCard.done.revoke'));
      setOpen(false);
      setReason('');
    } catch (e) {
      onError(errorText(t, e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="flex w-[230px] flex-col gap-2">
      <div className="text-[12.5px] text-muted">{grant ? t('admin.users.grantConfirm') : t('admin.users.revokeConfirm')}</div>
      <Input aria-label={t('admin.userCard.reason')} placeholder={t('admin.userCard.reasonPlaceholder')} value={reason} onChange={(ev) => setReason(ev.target.value)} />
      <div className="flex gap-2">
        <Button size="sm" variant={grant ? 'primary' : 'danger'} busy={busy} disabled={reason.trim().length < 5} onClick={() => void submit()}>{label}</Button>
        <Button size="sm" variant="ghost" onClick={() => { setOpen(false); setReason(''); }}>{t('common.cancel')}</Button>
      </div>
    </div>
  );
}
