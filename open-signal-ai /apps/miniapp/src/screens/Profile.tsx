import { LANGUAGE_LABELS, SUPPORTED_LANGUAGES } from '@open-signal/i18n';
import { Button, Panel, SectionTitle, Segmented, IconShield, IconInfo } from '@open-signal/ui';
import { Header, LOCALE } from '../components/chrome.tsx';
import { errorKey } from '../lib/api.ts';
import { openSupport } from '../lib/telegram.ts';
import { StatusPanel } from './Onboarding.tsx';
import { useApp } from '../state.tsx';

export function ProfileScreen() {
  const { t, lang, setLang, me, guest, authError, config, setTab } = useApp();
  const fmt = new Intl.DateTimeFormat(LOCALE[lang], { dateStyle: 'long' });

  return (
    <div className="os-rise">
      <Header title={t('profile.title')} />
      <div className="flex flex-col gap-5 px-4 pt-3">
        {guest ? (
          <Panel className="p-5">
            <div className="flex items-start gap-3">
              <IconShield className="mt-0.5 shrink-0 text-primary" />
              <div>
                <div className="text-[15px] font-semibold">{t('profile.guestTitle')}</div>
                <p className="mt-1 text-[14px] leading-relaxed text-muted">{t('profile.guestText')}</p>
                {authError ? <p className="mt-2 text-[14px] text-danger">{t(errorKey(authError))}</p> : null}
              </div>
            </div>
          </Panel>
        ) : (
          <section className="os-enter px-1 pb-2 pt-2">
            <div className="flex items-center gap-4">
              <div className="os-btn-primary grid h-16 w-16 place-items-center rounded-[22px] text-2xl font-bold">{me!.user.firstName.slice(0, 1).toUpperCase()}</div>
              <div className="min-w-0">
                <h1 className="os-display truncate text-[30px]">{me!.user.firstName}</h1>
                <div className="truncate text-[14px] text-muted">{me!.user.username ? `@${me!.user.username}` : t('profile.noUsername')}</div>
              </div>
            </div>
            <dl className="mt-5 grid grid-cols-2 gap-4 text-[14px]">
              <div>
                <dt className="text-[13px] text-muted">{t('profile.telegramId')}</dt>
                <dd className="os-num mt-0.5 font-semibold">{me!.user.telegramId}</dd>
              </div>
              <div>
                <dt className="text-[13px] text-muted">{t('profile.registered')}</dt>
                <dd className="mt-0.5 font-semibold">{fmt.format(new Date(me!.user.registeredAt))}</dd>
              </div>
            </dl>
          </section>
        )}

        <div>
          <div className="mb-2 px-1 text-[13px] text-muted">{t('common.language')}</div>
          <Segmented block ariaLabel={t('common.language')} value={lang} onChange={setLang} options={SUPPORTED_LANGUAGES.map((l) => ({ value: l, label: LANGUAGE_LABELS[l] }))} />
        </div>

        {me?.binding.enabled ? <AccountCard /> : null}

        <Panel className="os-rows overflow-hidden">
          <div className="flex items-center justify-between px-4 py-3.5 text-[14px]">
            <span>{t('profile.learning')}</span>
            <span className="os-num text-muted">0 / 10</span>
          </div>
          <button type="button" onClick={() => setTab('history')} className="flex w-full items-center justify-between px-4 py-3.5 text-left text-[14px]">
            <span>{t('profile.simulations')}</span>
            <span className="text-primary">{t('nav.history')}</span>
          </button>
        </Panel>

        {config?.supportContact ? (
          <Button variant="secondary" block onClick={() => openSupport(config.supportContact)}>
            {t('profile.support')} · {config.supportContact}
          </Button>
        ) : null}
      </div>
    </div>
  );
}

function AccountCard() {
  const { t, me, setBrowsing } = useApp();
  const ob = me!.onboarding;
  const done = ob.status === 'completed';
  return (
    <div>
      <SectionTitle>{t('profile.accountTitle')}</SectionTitle>
      <StatusPanel onboarding={ob} />
      {!done ? (
        <Button className="mt-3" block onClick={() => setBrowsing(false)}>
          {ob.status === 'pending_review' || ob.status === 'needs_support' ? t('onb.openStatus') : t('onb.continue')}
        </Button>
      ) : null}
      <p className="mt-3 flex items-start gap-2 px-1 text-[12px] leading-relaxed text-muted">
        <IconInfo size={14} className="mt-0.5 shrink-0" />
        {t('binding.openOnlyNote')}
      </p>
    </div>
  );
}
