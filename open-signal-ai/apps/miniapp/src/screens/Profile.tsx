import { useState, type FormEvent } from 'react';
import { LANGUAGE_LABELS, SUPPORTED_LANGUAGES, type Lang } from '@open-signal/i18n';
import { Badge, Button, Card, Input, Notice, SectionTitle, IconShield, IconInfo } from '@open-signal/ui';
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
      <div className="flex flex-col gap-4 px-4">
        {guest ? (
          <Card hero>
            <div className="flex items-start gap-3">
              <IconShield className="mt-0.5 shrink-0 text-primary" />
              <div>
                <div className="font-semibold">{t('profile.guestTitle')}</div>
                <p className="mt-1 text-[13px] leading-relaxed text-muted">{t('profile.guestText')}</p>
                {authError ? <p className="mt-2 text-[13px] text-danger">{t(errorKey(authError))}</p> : null}
              </div>
            </div>
          </Card>
        ) : (
          <Card hero>
            <div className="flex items-center gap-3.5">
              <div className="grid h-14 w-14 place-items-center rounded-2xl os-btn-primary text-xl font-extrabold">
                {me!.user.firstName.slice(0, 1).toUpperCase()}
              </div>
              <div className="min-w-0">
                <div className="truncate text-lg font-bold tracking-tight">{me!.user.firstName}</div>
                <div className="truncate text-sm text-muted">{me!.user.username ? `@${me!.user.username}` : t('profile.noUsername')}</div>
              </div>
            </div>
            <dl className="mt-4 grid grid-cols-2 gap-3 border-t border-line pt-4 text-sm">
              <div>
                <dt className="text-xs text-muted">{t('profile.telegramId')}</dt>
                <dd className="mt-0.5 font-mono font-semibold">{me!.user.telegramId}</dd>
              </div>
              <div>
                <dt className="text-xs text-muted">{t('profile.registered')}</dt>
                <dd className="mt-0.5 font-semibold">{fmt.format(new Date(me!.user.registeredAt))}</dd>
              </div>
            </dl>
          </Card>
        )}

        <Card>
          <SectionTitle>{t('common.language')}</SectionTitle>
          <div className="grid grid-cols-3 gap-2">
            {SUPPORTED_LANGUAGES.map((l: Lang) => (
              <Button key={l} size="md" variant={l === lang ? 'primary' : 'secondary'} onClick={() => setLang(l)} aria-pressed={l === lang}>
                {LANGUAGE_LABELS[l]}
              </Button>
            ))}
          </div>
        </Card>

        {me?.binding.enabled ? <BindingCard /> : null}

        <Card>
          <SectionTitle>{t('profile.learning')}</SectionTitle>
          <p className="text-sm text-muted">{t('academy.progress', { done: 0, total: 10 })}</p>
          <div className="mt-4 border-t border-line pt-4">
            <SectionTitle>{t('profile.simulations')}</SectionTitle>
            <p className="text-sm text-muted">{t('common.stageNote', { stage: 4 })}</p>
          </div>
        </Card>

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
    <Card>
      <SectionTitle action={<Badge tone={STATE_TONE[binding.state]} dot>{t(`binding.state.${binding.state}`)}</Badge>}>
        {t('profile.accountTitle')}
      </SectionTitle>
      <p className="text-[13px] leading-relaxed text-muted">{t(`binding.hint.${binding.state}`)}</p>
      {binding.traderIdMasked ? (
        <div className="mt-3 rounded-xl border border-line bg-black/20 px-3.5 py-2.5 font-mono text-sm">{binding.traderIdMasked}</div>
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
    </Card>
  );
}
