import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { Badge, Button, Input, Notice, Spinner } from '@open-signal/ui';
import { useI18n } from '../i18n.tsx';
import { api, errorText } from '../lib/api.ts';
import { dateTime } from '../lib/format.ts';
import type { UserRow } from './UsersTable.tsx';

export type AccessStatus =
  | 'confirmed' | 'manual' | 'revoked' | 'needs_review' | 'checking' | 'awaiting_deposit' | 'awaiting_trader_id' | 'awaiting_registration';

export const ACCESS_TONE: Record<AccessStatus, 'neutral' | 'info' | 'warning' | 'success' | 'danger' | 'primary'> = {
  confirmed: 'success',
  manual: 'primary',
  revoked: 'neutral',
  needs_review: 'danger',
  checking: 'warning',
  awaiting_deposit: 'warning',
  awaiting_trader_id: 'info',
  awaiting_registration: 'neutral',
};

export interface UserCardData extends UserRow {
  lastName: string | null;
  onboardingCompletedAt: string | null;
  manualAccess: {
    active: boolean;
    grantedAt: string;
    grantedBy: string | null;
    grantReason: string;
    revokedAt: string | null;
    revokedBy: string | null;
    revokeReason: string | null;
  } | null;
  lastManualAction: { action: string; at: string; by: string | null; reason: string | null } | null;
}

/** One admin operation on the user: its own button, confirmation and mandatory reason. */
type ActionId = 'grant' | 'revoke' | 'step_trader_id' | 'step_registration' | 'bind' | 'unbind' | 'recheck';

/**
 * User card with manual actions. Every action is a real server call (permission check,
 * transaction, audit); the card only collects the confirmation and the reason.
 */
export function UserCard({ row, onChanged }: { row: UserRow; onChanged: (u: UserCardData) => void }) {
  const { t, lang } = useI18n();
  const [card, setCard] = useState<UserCardData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<ActionId | null>(null);
  const [reason, setReason] = useState('');
  const [traderId, setTraderId] = useState('');
  const [release, setRelease] = useState(false);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  const base = `/bots/${row.botId}/users/${row.telegramId}`;

  const load = useCallback(async () => {
    try {
      setCard((await api<{ user: UserCardData }>('GET', base)).user);
      setError(null);
    } catch (e) {
      setError(errorText(t, e));
    }
  }, [base, t]);
  useEffect(() => {
    void load();
  }, [load]);

  if (!card) return <div className="grid h-24 place-items-center">{error ? <Notice tone="danger">{error}</Notice> : <Spinner />}</div>;

  const linked = card.verification === 'confirmed';
  const actions: { id: ActionId; show: boolean; variant: 'secondary' | 'danger' | 'primary' }[] = [
    { id: 'grant', show: !card.manualAccessActive, variant: 'primary' },
    { id: 'revoke', show: card.manualAccessActive, variant: 'danger' },
    { id: 'step_trader_id', show: !linked, variant: 'secondary' },
    { id: 'step_registration', show: !linked, variant: 'secondary' },
    { id: 'bind', show: true, variant: 'secondary' },
    { id: 'unbind', show: linked, variant: 'danger' },
    { id: 'recheck', show: linked, variant: 'secondary' },
  ];

  const run = async () => {
    if (!open) return;
    setBusy(true);
    try {
      let updated: UserCardData;
      if (open === 'grant' || open === 'revoke') {
        updated = (await api<{ user: UserCardData }>('POST', `${base}/manual-access`, { grant: open === 'grant', reason })).user;
      } else if (open === 'step_trader_id' || open === 'step_registration') {
        updated = (await api<{ user: UserCardData }>('POST', `${base}/onboarding-step`, { step: open === 'step_trader_id' ? 'trader_id' : 'registration', reason })).user;
      } else if (open === 'recheck') {
        updated = (await api<{ user: UserCardData }>('POST', `${base}/deposit-recheck`, { reason })).user;
      } else {
        // Existing binding actions (unchanged endpoints).
        if (open === 'bind') await api('POST', `/bots/${row.botId}/binding/bind`, { telegramId: row.telegramId, traderId, reason, releaseFromOther: release });
        else await api('POST', `/bots/${row.botId}/binding/reset`, { telegramId: row.telegramId, reason });
        updated = (await api<{ user: UserCardData }>('GET', base)).user;
      }
      setCard(updated);
      onChanged(updated);
      setDone(t(`admin.userCard.done.${open}`));
      setOpen(null);
      setReason('');
      setTraderId('');
      setRelease(false);
      setError(null);
    } catch (e) {
      setError(errorText(t, e));
    } finally {
      setBusy(false);
    }
  };

  const m = card.manualAccess;
  const money = card.deposit?.ftdAmount != null ? new Intl.NumberFormat(lang, { style: 'currency', currency: card.deposit.ftdCurrency ?? 'USD' }).format(card.deposit.ftdAmount) : null;
  const facts: [string, ReactNode][] = [
    ['Telegram ID', <span className="os-num">{card.telegramId}</span>],
    [t('admin.userCard.name'), <>{[card.firstName, card.lastName].filter(Boolean).join(' ')}{card.username ? <span className="text-muted"> @{card.username}</span> : null}</>],
    [t('admin.users.bot'), card.botName],
    ['Trader ID', <span className="os-num">{card.traderId ?? '—'}</span>],
    [t('admin.userCard.registration'), card.registrationStartedAt ? dateTime(card.registrationStartedAt, lang) : t('admin.userCard.registrationNotStarted')],
    [t('admin.users.binding'), t(`binding.state.${card.bindingState}`)],
    [t('admin.users.verification'), <>{t(`admin.verification.${card.verification}`)}{card.lastBindingError ? <span className="text-muted"> · {t(`admin.bindingFailure.${card.lastBindingError}`)}</span> : null}</>],
    [t('admin.users.deposit'), t(`onb.check.${card.depositCheck}`)],
    [t('admin.userCard.amount'), money ? <span className="os-num">{money}{card.deposit && card.deposit.depositsCount > 1 ? ` (+${card.deposit.depositsCount - 1})` : ''}</span> : '—'],
    [t('admin.userCard.access'), card.access.via ? t(`admin.userCard.via.${card.access.via}`) : t('admin.userCard.via.none')],
  ];

  return (
    <div className="grid gap-5 p-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
      <div>
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <Badge tone={ACCESS_TONE[card.accessStatus as AccessStatus] ?? 'neutral'} dot>{t(`admin.access.${card.accessStatus}`)}</Badge>
          {card.manualAccessActive && card.accessStatus === 'confirmed' ? <Badge tone="primary">{t('admin.access.manual')}</Badge> : null}
        </div>
        <dl className="grid grid-cols-[150px_minmax(0,1fr)] gap-x-4 gap-y-2 text-[14px]">
          {facts.map(([k, v]) => (
            <div key={k} className="contents">
              <dt className="text-muted">{k}</dt>
              <dd className="min-w-0 break-words">{v}</dd>
            </div>
          ))}
        </dl>
        {m ? (
          <div className="mt-4 rounded-xl bg-white/[0.04] p-3 text-[13px]">
            <div className="font-medium">{t('admin.userCard.manualTitle')}</div>
            <div className="mt-1 text-muted">
              {t('admin.userCard.grantedBy', { by: m.grantedBy ?? '—', at: dateTime(m.grantedAt, lang) })}
            </div>
            <div className="mt-0.5">{m.grantReason}</div>
            {m.revokedAt ? (
              <>
                <div className="mt-2 text-muted">{t('admin.userCard.revokedBy', { by: m.revokedBy ?? '—', at: dateTime(m.revokedAt, lang) })}</div>
                <div className="mt-0.5">{m.revokeReason}</div>
              </>
            ) : null}
          </div>
        ) : null}
        {card.lastManualAction ? (
          <div className="mt-3 text-[13px] text-muted">
            {t('admin.userCard.lastAction', { action: t(`admin.userCard.audit.${card.lastManualAction.action}`), by: card.lastManualAction.by ?? '—', at: dateTime(card.lastManualAction.at, lang) })}
            {card.lastManualAction.reason ? <div className="mt-0.5 text-fg/90">{card.lastManualAction.reason}</div> : null}
          </div>
        ) : null}
      </div>

      <div>
        <div className="mb-2 text-[13px] font-medium text-fg/90">{t('admin.userCard.actions')}</div>
        {!card.canManage ? (
          <Notice tone="info">{t('admin.userCard.noPermission')}</Notice>
        ) : (
          <div className="flex flex-col gap-2">
            {actions.filter((a) => a.show).map((a) => (
              <div key={a.id} className="rounded-xl bg-white/[0.03] p-3">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="text-[14px] font-medium">{t(`admin.userCard.action.${a.id}`)}</div>
                    <div className="mt-0.5 text-[12.5px] text-muted">{t(`admin.userCard.hint.${a.id}`)}</div>
                  </div>
                  {open !== a.id ? (
                    <Button size="sm" variant={a.variant === 'primary' ? 'secondary' : a.variant} onClick={() => { setOpen(a.id); setDone(null); setError(null); }}>
                      {t(`admin.userCard.action.${a.id}`)}
                    </Button>
                  ) : null}
                </div>
                {open === a.id ? (
                  <div className="mt-3 flex flex-col gap-2">
                    {a.id === 'bind' ? (
                      <>
                        <Input aria-label="Trader ID" placeholder="Trader ID" value={traderId} onChange={(ev) => setTraderId(ev.target.value)} />
                        <label className="flex items-center gap-2 text-[13px] text-muted">
                          <input type="checkbox" checked={release} onChange={(ev) => setRelease(ev.target.checked)} />
                          {t('admin.userCard.releaseFromOther')}
                        </label>
                      </>
                    ) : null}
                    <Input aria-label={t('admin.userCard.reason')} placeholder={t('admin.userCard.reasonPlaceholder')} value={reason} onChange={(ev) => setReason(ev.target.value)} />
                    <div className="text-[12.5px] text-muted">{t('admin.userCard.confirm')}</div>
                    <div className="flex gap-2">
                      <Button size="sm" variant={a.variant === 'danger' ? 'danger' : 'primary'} busy={busy} disabled={reason.trim().length < 5 || (a.id === 'bind' && !traderId.trim())} onClick={() => void run()}>
                        {t('admin.userCard.confirmButton')}
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => { setOpen(null); setReason(''); }}>{t('common.cancel')}</Button>
                    </div>
                  </div>
                ) : null}
              </div>
            ))}
          </div>
        )}
        {done ? <Notice tone="success" className="mt-3">{done}</Notice> : null}
        {error ? <Notice tone="danger" className="mt-3">{error}</Notice> : null}
      </div>
    </div>
  );
}
