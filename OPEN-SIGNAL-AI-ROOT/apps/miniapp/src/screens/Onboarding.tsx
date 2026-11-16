import { useState, type FormEvent, type ReactNode } from 'react';
import { FTD_THRESHOLD_USD } from '@open-signal/shared';
import { Badge, Button, Input, LogoMark, Notice, Panel, cx } from '@open-signal/ui';
import { LanguageSwitcher, LOCALE } from '../components/chrome.tsx';
import { ApiError, api, errorKey, type OnboardingView } from '../lib/api.ts';
import { haptic, openExternal, openSupport } from '../lib/telegram.ts';
import { useApp } from '../state.tsx';

const STEP_OF: Record<OnboardingView['status'], 1 | 2 | 3> = {
  registration: 1,
  registration_started: 1,
  trader_id: 2,
  pending_review: 3,
  needs_support: 3,
  completed: 3,
};

/** Three real steps in order, so they are numbered. */
function Stepper({ step }: { step: 1 | 2 | 3 }) {
  const { t } = useApp();
  const labels = [t('onb.step1'), t('onb.step2'), t('onb.step3')];
  return (
    <ol className="grid grid-cols-3 gap-2" aria-label={t('onb.progress')}>
      {labels.map((label, i) => {
        const n = i + 1;
        const state = n < step ? 'done' : n === step ? 'current' : 'next';
        return (
          <li key={label} aria-current={state === 'current' ? 'step' : undefined}>
            <div className={cx('h-1 rounded-full', state === 'next' ? 'bg-white/[0.1]' : 'bg-primary')} />
            <div className={cx('mt-2 text-[12px] leading-tight', state === 'next' ? 'text-muted' : 'text-fg')}>
              <span className="os-num font-semibold">{n}</span> {label}
            </div>
          </li>
        );
      })}
    </ol>
  );
}

export function OnboardingScreen() {
  const { t, me, config, setBrowsing } = useApp();
  const ob = me!.onboarding;
  const step = STEP_OF[ob.status];

  return (
    <div className="os-canvas min-h-dvh">
      <div className="app-shell-onb mx-auto flex min-h-dvh max-w-lg flex-col px-5">
        <header className="flex items-center justify-between gap-3 pb-6 pt-4">
          <div className="flex min-w-0 items-center gap-3">
            <LogoMark size={34} src={config?.logoUrl ?? null} />
            <span className="truncate text-[15px] font-semibold">{config?.miniAppTitle}</span>
          </div>
          <LanguageSwitcher />
        </header>
        <Stepper step={step} />
        <main className="os-enter flex flex-1 flex-col pt-8">
          {step === 1 ? <RegisterStep /> : step === 2 ? <TraderIdStep /> : <WaitingStep />}
        </main>
        <footer className="pb-6 pt-8 text-center">
          <button type="button" onClick={() => setBrowsing(true)} className="text-[14px] font-semibold text-muted underline decoration-white/20 underline-offset-4">
            {t('onb.browse')}
          </button>
          <p className="mx-auto mt-2 max-w-xs text-[12px] leading-relaxed text-muted/80">{t('onb.browseNote')}</p>
        </footer>
      </div>
    </div>
  );
}

function useRun() {
  const { t } = useApp();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      const code = e instanceof ApiError ? e.code : 'NETWORK';
      const wait = e instanceof ApiError ? (e.payload as { error?: { retryAfterSec?: number } } | null)?.error?.retryAfterSec : undefined;
      setError(t(errorKey(code), { seconds: wait ?? 30 }));
      haptic('error');
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, run };
}

/** Step 1 — registration with the broker through THIS bot's partner link (with a personal click_id). */
function RegisterStep() {
  const { t, lang, me, botId, token, config, setOnboarding } = useApp();
  const { busy, error, run } = useRun();
  const [link, setLink] = useState<string | null>(null);
  const ob = me!.onboarding;
  const started = ob.status === 'registration_started';
  const label = config?.partner.buttonText[lang]?.trim() || t('onb.registerButton');

  const register = () =>
    run(async () => {
      const r = await api.register(botId!, token!);
      setLink(r.link);
      setOnboarding(r.onboarding);
      haptic('success');
      openExternal(r.link);
    });
  const returned = () =>
    run(async () => {
      setOnboarding((await api.returned(botId!, token!)).onboarding);
      haptic();
    });

  return (
    <div className="flex flex-col">
      <h1 className="os-display text-[38px] leading-[1.05]">{started ? t('onb.registerAgainTitle') : t('onb.registerTitle')}</h1>
      <p className="mt-4 text-[16px] leading-relaxed text-fg/85">{started ? t('onb.registerAgainText') : t('onb.registerText')}</p>
      <ul className="mt-6 flex flex-col gap-3 text-[14px] text-muted">
        {['onb.point1', 'onb.point2', 'onb.point3'].map((k) => (
          <li key={k} className="flex gap-3">
            <span className="mt-[7px] h-1.5 w-1.5 shrink-0 rounded-full bg-primary" />
            {t(k)}
          </li>
        ))}
      </ul>
      <div className="mt-8 flex flex-col gap-3">
        {ob.partner.configured ? (
          <Button size="lg" block busy={busy} onClick={() => void register()}>{label}</Button>
        ) : (
          <Notice tone="warning">{t('errors.partnerLinkMissing')}</Notice>
        )}
        {link ? (
          <a href={link} target="_blank" rel="noopener noreferrer" className="text-center text-[13px] text-muted underline underline-offset-4">
            {t('onb.linkFallback')}
          </a>
        ) : null}
        {started || link ? (
          <Button size="lg" variant="secondary" block disabled={busy} onClick={() => void returned()}>{t('onb.registered')}</Button>
        ) : null}
        {error ? <p className="text-[13px] text-danger">{error}</p> : null}
      </div>
      {ob.registrationStartedAt ? (
        <p className="mt-4 text-[12px] text-muted">{t('onb.startedAt', { date: new Intl.DateTimeFormat(LOCALE[lang], { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(ob.registrationStartedAt)) })}</p>
      ) : null}
    </div>
  );
}

/** Step 2 — Trader ID: format check on the server, saved, then waits for confirmation. */
function TraderIdStep() {
  const { t, botId, token, setOnboarding, setBinding } = useApp();
  const { busy, error, run } = useRun();
  const [value, setValue] = useState('');
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!value.trim()) return;
    void run(async () => {
      const r = await api.submitTraderId(botId!, token!, value.trim());
      setBinding(r.binding);
      setOnboarding((await api.onboarding(botId!, token!)).onboarding);
      haptic('success');
    });
  };
  return (
    <form onSubmit={submit} className="flex flex-col">
      <h1 className="os-display text-[38px] leading-[1.05]">{t('onb.traderTitle')}</h1>
      <p className="mt-4 text-[16px] leading-relaxed text-fg/85">{t('onb.traderText')}</p>
      <div className="mt-8 flex flex-col gap-3">
        <Input
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder={t('binding.traderIdLabel')}
          aria-label={t('binding.traderIdLabel')}
          autoComplete="off"
          maxLength={64}
          className="h-14 text-[18px]"
        />
        <Button type="submit" size="lg" block busy={busy} disabled={!value.trim()}>{t('binding.submit')}</Button>
        {error ? <p className="text-[13px] text-danger">{error}</p> : null}
      </div>
      <p className="mt-4 text-[13px] leading-relaxed text-muted">{t('onb.traderHint')}</p>
    </form>
  );
}

/** Step 3 — waiting for the partner's confirmation; deposit status only from real events. */
function WaitingStep() {
  const { t, me, botId, token, setBinding } = useApp();
  const { busy, error, run } = useRun();
  const ob = me!.onboarding;
  const binding = me!.binding;
  const support = ob.status === 'needs_support';
  return (
    <div className="flex flex-col">
      <h1 className="os-display text-[38px] leading-[1.05]">{support ? t('onb.supportTitle') : t('onb.waitTitle')}</h1>
      <p className="mt-4 text-[16px] leading-relaxed text-fg/85">{support ? t(`binding.hint.${binding.state}`) : t('onb.waitText')}</p>
      <div className="mt-6">
        <StatusPanel onboarding={ob} />
      </div>
      <div className="mt-6 flex flex-col gap-3">
        {binding.state === 'registration_pending' ? (
          <Button size="lg" variant="secondary" block busy={busy} onClick={() => void run(async () => setBinding((await api.recheck(botId!, token!)).binding))}>
            {t('binding.recheck')}
          </Button>
        ) : null}
        {error ? <p className="text-[13px] text-danger">{error}</p> : null}
        {(support || binding.showSupport) && binding.supportContact ? (
          <Button variant="ghost" block onClick={() => openSupport(binding.supportContact)}>{t('binding.contactSupport')}</Button>
        ) : null}
      </div>
    </div>
  );
}

const VERIFY_TONE: Record<OnboardingView['verification'], 'neutral' | 'warning' | 'success' | 'danger'> = {
  not_submitted: 'neutral',
  pending: 'warning',
  confirmed: 'success',
  review: 'danger',
};

/** Registration, Trader ID, verification and deposit as reported by the server. */
export function StatusPanel({ onboarding: ob }: { onboarding: OnboardingView }) {
  const { t, lang } = useApp();
  const date = (v: string | null) => (v ? new Intl.DateTimeFormat(LOCALE[lang], { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(v)) : '—');
  const d = ob.deposit;
  const money = d.ftdAmount !== null ? new Intl.NumberFormat(LOCALE[lang], { style: 'currency', currency: d.ftdCurrency ?? 'USD' }).format(d.ftdAmount) : null;
  const rows: { label: string; value: ReactNode }[] = [
    { label: t('onb.row.registration'), value: ob.registrationStartedAt ? t('onb.registrationOpened', { date: date(ob.registrationStartedAt) }) : t('onb.notStarted') },
    { label: t('onb.row.traderId'), value: ob.traderIdMasked ? <span className="os-num">{ob.traderIdMasked}</span> : '—' },
    { label: t('onb.row.verification'), value: <Badge tone={VERIFY_TONE[ob.verification]} dot>{t(`onb.verification.${ob.verification}`)}</Badge> },
    {
      label: t('onb.row.deposit'),
      value: (
        <span className="flex flex-wrap items-center justify-end gap-2">
          <span>{t(`onb.deposit.${d.status}`)}</span>
          {d.ftdThresholdMet ? <Badge tone="success">{t('onb.ftdMark', { amount: FTD_THRESHOLD_USD })}</Badge> : null}
        </span>
      ),
    },
  ];
  if (money) rows.push({ label: t('onb.row.amount'), value: <span className="os-num">{money}</span> });
  if (d.ftdAt) rows.push({ label: t('onb.row.date'), value: date(d.ftdAt) });
  return (
    <Panel className="os-rows overflow-hidden">
      {rows.map((r) => (
        <div key={r.label} className="flex items-center justify-between gap-4 px-4 py-3 text-[14px]">
          <span className="text-muted">{r.label}</span>
          <span className="text-right font-medium">{r.value}</span>
        </div>
      ))}
      {d.status === 'unknown' ? <p className="px-4 py-3 text-[12px] leading-relaxed text-muted">{d.sourceConnected ? t('onb.depositAfterVerify') : t('onb.depositNoSource')}</p> : null}
    </Panel>
  );
}

