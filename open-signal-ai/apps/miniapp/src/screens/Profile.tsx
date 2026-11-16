import { useState, type FormEvent } from 'react';
import { LANGUAGE_LABELS, SUPPORTED_LANGUAGES } from '@open-signal/i18n';
import { Badge, Button, Input, Notice, Panel, SectionTitle, Segmented, IconShield, IconInfo } from '@open-signal/ui';
import { Header, LOCALE } from '../components/chrome.tsx';
import { ApiError, api, errorKey, type BindingView } from '../lib/api.ts';
import { haptic, openSupport } from '../lib/telegram.ts';
import { useApp } from '../state.tsx';

const STATE_TONE: Record<BindingView['state'], 'neutral' | 'primary' | 'success' | 'warning' | 'danger' | 'info'> = {
  telegram_created: 'neutral',
  waiting_for_trader_id: 'info',
  registration_pending: 'warning',
  registration_verified: 'primary',
  account_bound: 'success',
  binding_conflict: 'danger',
  manual_review: 'warning',
};

export function ProfileScreen() {
  const { t, lang, setLang, me, guest, authError, config } = useApp();
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

        {me?.binding.enabled ? <BindingCard /> : null}

        <Panel className="os-rows overflow-hidden">
          <div className="flex items-center justify-between px-4 py-3.5 text-[14px]">
            <span>{t('profile.learning')}</span>
            <span className="os-num text-muted">0 / 10</span>
          </div>
          <div className="flex items-center justify-between px-4 py-3.5 text-[14px]">
            <span>{t('profile.simulations')}</span>
            <span className="text-muted">{t('common.notConnected')}</span>
          </div>
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

function BindingCard() {
  const { t, me, botId, token, setBinding } = useApp();
  const binding = me!.binding;
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async (fn: () => Promise<{ binding: BindingView }>) => {
    setBusy(true);
    setError(null);
    try {
      const r = await fn();
      setBinding(r.binding);
      haptic(r.binding.state === 'account_bound' ? 'success' : 'select');
    } catch (e) {
      const code = e instanceof ApiError ? e.code : 'INTERNAL';
      const payload = e instanceof ApiError ? (e.payload as { binding?: BindingView; error?: { retryAfterSec?: number } } | null) : null;
      if (payload?.binding) setBinding(payload.binding);
      setError(t(errorKey(code), { seconds: payload?.error?.retryAfterSec ?? 30 }));
      haptic('error');
    } finally {
      setBusy(false);
    }
  };

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (!value.trim() || !botId || !token) return;
    void run(() => api.submitTraderId(botId, token, value.trim()));
  };

  const canEnter = ['waiting_for_trader_id', 'registration_verified', 'binding_conflict'].includes(binding.state);

  return (
    <Panel className="p-4">
      <SectionTitle action={<Badge tone={STATE_TONE[binding.state]} dot>{t(`binding.state.${binding.state}`)}</Badge>}>
        {t('profile.accountTitle')}
      </SectionTitle>
      <p className="text-[14px] leading-relaxed text-muted">{t(`binding.hint.${binding.state}`)}</p>
      {binding.traderIdMasked ? (
        <div className="os-num mt-3 rounded-xl bg-white/[0.05] px-3.5 py-2.5 text-[15px] font-semibold tracking-wide">{binding.traderIdMasked}</div>
      ) : null}

      {canEnter ? (
        <form onSubmit={onSubmit} className="mt-4 flex flex-col gap-2.5">
          <Input
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder={t('binding.traderIdLabel')}
            aria-label={t('binding.traderIdLabel')}
            autoComplete="off"
            inputMode="text"
            maxLength={64}
          />
          <Button type="submit" block disabled={busy || !value.trim()}>
            {t('binding.submit')}
          </Button>
        </form>
      ) : null}

      {binding.state === 'registration_pending' ? (
        <Button className="mt-4" variant="secondary" block disabled={busy} onClick={() => botId && token && void run(() => api.recheck(botId, token))}>
          {t('binding.recheck')}
        </Button>
      ) : null}

      {error ? <p className="mt-3 text-[13px] text-danger">{error}</p> : null}

      {binding.showSupport && binding.supportContact ? (
        <Button className="mt-3" variant="ghost" block onClick={() => openSupport(binding.supportContact)}>
          {t('binding.contactSupport')}
        </Button>
      ) : null}

      <div className="mt-4">
        <Notice tone="neutral" icon={<IconInfo size={15} />}>{t('binding.openOnlyNote')}</Notice>
      </div>
    </Panel>
  );
}
