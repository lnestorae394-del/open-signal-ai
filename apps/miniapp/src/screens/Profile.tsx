import type { ReactNode } from 'react';
import { LANGUAGE_LABELS, SUPPORTED_LANGUAGES } from '@open-signal/i18n';
import { Badge, Button, Panel, Segmented } from '@open-signal/ui';
import { Header, LOCALE } from '../components/chrome.tsx';
import { openSupport } from '../lib/telegram.ts';
import { useApp } from '../state.tsx';

const CHECK_TONE = { awaiting: 'neutral', checking: 'warning', confirmed: 'success', error: 'danger' } as const;

/** The user's own data. No tokens, click_ids or internal ids are shown. */
export function ProfileScreen() {
  const { t, lang, setLang, me, config, setTab } = useApp();
  const u = me!.user;
  const ob = me!.onboarding;
  const d = ob.deposit;
  const money = d.ftdAmount !== null && d.check !== 'awaiting' ? new Intl.NumberFormat(LOCALE[lang], { style: 'currency', currency: d.ftdCurrency ?? 'USD' }).format(d.ftdAmount) : '—';
  const rows: { label: string; value: ReactNode }[] = [
    { label: t('profile.telegramId'), value: <span className="os-num">{u.telegramId}</span> },
    { label: t('profile.bot'), value: u.botName },
    { label: 'Trader ID', value: <span className="os-num">{u.traderId ?? '—'}</span> },
    { label: t('profile.registration'), value: <Badge tone={u.traderId ? 'success' : 'neutral'} dot>{u.traderId ? t('profile.registrationConfirmed') : t('profile.registrationNot')}</Badge> },
    { label: t('profile.ftd'), value: <Badge tone={CHECK_TONE[d.check]} dot>{t(`onb.check.${d.check}`)}</Badge> },
    { label: t('profile.amount'), value: <span className="os-num">{money}</span> },
  ];
  const { done, total } = me!.academy;

  return (
    <div>
      <Header title={t('profile.title')} />
      <div className="flex flex-col gap-5 px-4 pt-3">
        <section className="os-enter px-1 pb-1 pt-2">
          <div className="flex items-center gap-4">
            <div className="os-btn-primary grid h-16 w-16 place-items-center rounded-[22px] text-2xl font-bold">{u.firstName.slice(0, 1).toUpperCase()}</div>
            <div className="min-w-0">
              <h1 className="os-display truncate text-[30px]">{u.firstName}</h1>
              <div className="truncate text-[14px] text-muted">{u.username ? `@${u.username}` : t('profile.noUsername')}</div>
            </div>
          </div>
        </section>

        <Panel className="os-rows overflow-hidden">
          {rows.map((r) => (
            <div key={r.label} className="flex items-center justify-between gap-4 px-4 py-3.5 text-[14px]">
              <span className="text-muted">{r.label}</span>
              <span className="min-w-0 truncate text-right font-medium">{r.value}</span>
            </div>
          ))}
        </Panel>

        <button type="button" onClick={() => setTab('academy')} className="os-panel block w-full px-4 py-4 text-left">
          <div className="flex items-center justify-between text-[14px]">
            <span className="text-muted">{t('profile.learning')}</span>
            <span className="os-num font-semibold">{done} / {total}</span>
          </div>
          <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-white/[0.08]" aria-hidden>
            <div className="h-full rounded-full bg-primary" style={{ width: `${total ? (done / total) * 100 : 0}%` }} />
          </div>
        </button>

        <div>
          <div className="mb-2 px-1 text-[13px] text-muted">{t('common.language')}</div>
          <Segmented block ariaLabel={t('common.language')} value={lang} onChange={setLang} options={SUPPORTED_LANGUAGES.map((l) => ({ value: l, label: LANGUAGE_LABELS[l] }))} />
        </div>

        {config?.supportContact ? (
          <Button variant="secondary" block onClick={() => openSupport(config.supportContact)}>
            {t('profile.support')}
          </Button>
        ) : null}
        <p className="px-1 pb-2 text-[12px] leading-relaxed text-muted/80">{t('profile.riskNote')}</p>
      </div>
    </div>
  );
}
