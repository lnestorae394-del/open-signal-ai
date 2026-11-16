import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { Badge, Button, Input, LogoMark, Notice, Panel, cx } from '@open-signal/ui';
import { LanguageSwitcher, LOCALE } from '../components/chrome.tsx';
import { ApiError, api, errorKey, type DepositView, type OnboardingView } from '../lib/api.ts';
import { haptic, openExternal, openSupport } from '../lib/telegram.ts';
import { useApp } from '../state.tsx';

const STEP_OF: Record<OnboardingView['status'], 1 | 2 | 3> = {
  registration: 1,
  registration_started: 1,
  trader_id: 2,
  deposit: 3,
  needs_support: 2,
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
            <div className={cx('h-1 rounded-full transition-colors duration-500', state === 'next' ? 'bg-white/[0.1]' : 'bg-primary')} />
            <div className={cx('mt-2 text-[12px] leading-tight', state === 'next' ? 'text-muted' : 'text-fg')}>
              <span className="os-num font-semibold">{n}</span> {label}
            </div>
          </li>
        );
      })}
    </ol>
  );
}

/** Mandatory onboarding. There is no way around it: the app opens only when the server says "completed". */
export function OnboardingScreen() {
  const { me, config } = useApp();
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
        <main key={ob.status} className="os-enter flex flex-1 flex-col pb-10 pt-8">
          {ob.status === 'needs_support' ? <SupportStep /> : step === 1 ? <RegisterStep /> : step === 2 ? <TraderIdStep /> : <DepositStep />}
        </main>
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
      setError(t(errorKey(e instanceof ApiError ? e.code : 'NETWORK')));
      haptic('error');
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, run };
}

function Title({ children }: { children: ReactNode }) {
  return <h1 className="os-display text-[38px] leading-[1.05]">{children}</h1>;
}

/** Step 1 — registration through THIS bot's partner link with the user's personal click_id. */
function RegisterStep() {
  const { t, lang, me, botId, token, config, setOnboarding } = useApp();
  const { busy, error, run } = useRun();
  const [link, setLink] = useState<string | null>(null);
  const ob = me!.onboarding;
  const started = ob.status === 'registration_started' || link !== null;
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
      <Title>{t('onb.registerTitle')}</Title>
      <p className="mt-4 text-[16px] leading-relaxed text-fg/85">{t('onb.registerText')}</p>
      {ob.lastError ? <Notice tone="warning" className="mt-6">{t(`onb.failure.${ob.lastError}`)}</Notice> : null}
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
        {started ? (
          <Button size="lg" variant="secondary" block disabled={busy} onClick={() => void returned()}>{t('onb.registered')}</Button>
        ) : null}
        {error ? <p className="text-[13px] text-danger">{error}</p> : null}
      </div>
      <p className="mt-6 text-[13px] leading-relaxed text-muted">{t('onb.registerNote')}</p>
    </div>
  );
}

/** Step 2 — Trader ID, verified on the server against the partner's registration postback. */
function TraderIdStep() {
  const { t, botId, token, setOnboarding } = useApp();
  const { busy, error, run } = useRun();
  const [value, setValue] = useState('');
  const [failure, setFailure] = useState<string | null>(null);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!value.trim()) return;
    setFailure(null);
    void run(async () => {
      try {
        const r = await api.submitTraderId(botId!, token!, value.trim());
        setOnboarding(r.onboarding);
        haptic('success');
      } catch (err) {
        // A failed check is a normal outcome: show its reason and offer to start over.
        const body = err instanceof ApiError ? (err.payload as { onboarding?: OnboardingView } | null) : null;
        if (err instanceof ApiError && body?.onboarding && err.status === 409) {
          setOnboarding(body.onboarding);
          setFailure(err.code);
          haptic('error');
          return;
        }
        throw err;
      }
    });
  };
  const again = () =>
    run(async () => {
      setOnboarding((await api.restart(botId!, token!)).onboarding);
    });

  return (
    <form onSubmit={submit} className="flex flex-col">
      <Title>{t('onb.traderTitle')}</Title>
      <p className="mt-4 text-[16px] leading-relaxed text-fg/85">{t('onb.traderText')}</p>
      <div className="mt-8 flex flex-col gap-3">
        <Input
          value={value}
          onChange={(e) => {
            setValue(e.target.value);
            setFailure(null);
          }}
          placeholder="Trader ID"
          aria-label="Trader ID"
          autoComplete="off"
          inputMode="text"
          maxLength={64}
          className="os-num h-14 text-[18px]"
        />
        <Button type="submit" size="lg" block busy={busy} disabled={!value.trim()}>{t('onb.link')}</Button>
        {failure ? (
          <div className="os-enter flex flex-col gap-3">
            <Notice tone="danger">{t(`onb.failure.${failure}`)}</Notice>
            <Button type="button" variant="secondary" block disabled={busy} onClick={() => void again()}>{t('onb.tryAgain')}</Button>
          </div>
        ) : null}
        {error ? <p className="text-[13px] text-danger">{error}</p> : null}
      </div>
      <p className="mt-6 text-[13px] leading-relaxed text-muted">{t('onb.traderHint')}</p>
    </form>
  );
}

const CHECK_TONE: Record<DepositView['check'], 'neutral' | 'warning' | 'success' | 'danger'> = {
  awaiting: 'neutral',
  checking: 'warning',
  confirmed: 'success',
  error: 'danger',
};

/** Step 3 — first deposit, confirmed only by the partner's postback. Refreshes itself. */
function DepositStep() {
  const { t, me, refreshMe } = useApp();
  const { busy, run } = useRun();
  const d = me!.onboarding.deposit;
  useEffect(() => {
    const id = setInterval(() => void refreshMe(), 20_000);
    return () => clearInterval(id);
  }, [refreshMe]);
  return (
    <div className="flex flex-col">
      <Title>{t('onb.depositTitle')}</Title>
      <p className="mt-4 text-[16px] leading-relaxed text-fg/85">{t('onb.depositText', { amount: d.thresholdUsd })}</p>
      <div className="mt-6">
        <DepositPanel deposit={d} traderId={me!.user.traderId} />
      </div>
      {d.check === 'error' && d.checkReason ? <Notice tone="danger" className="mt-4">{t(`onb.checkReason.${d.checkReason}`, { amount: d.thresholdUsd })}</Notice> : null}
      {d.check === 'checking' && d.checkReason ? <Notice tone="warning" className="mt-4">{t(`onb.checkReason.${d.checkReason}`)}</Notice> : null}
      <Button className="mt-6" size="lg" variant="secondary" block busy={busy} onClick={() => void run(refreshMe)}>{t('onb.refresh')}</Button>
      <p className="mt-4 text-[13px] leading-relaxed text-muted">{t('onb.depositNote')}</p>
    </div>
  );
}

/** Deposit status rows (also used in Profile). */
export function DepositPanel({ deposit: d, traderId }: { deposit: DepositView; traderId: string | null }) {
  const { t, lang } = useApp();
  const money = d.ftdAmount !== null ? new Intl.NumberFormat(LOCALE[lang], { style: 'currency', currency: d.ftdCurrency ?? 'USD' }).format(d.ftdAmount) : '—';
  const date = d.ftdAt ? new Intl.DateTimeFormat(LOCALE[lang], { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(d.ftdAt)) : null;
  const rows: { label: string; value: ReactNode }[] = [
    ...(traderId ? [{ label: 'Trader ID', value: <span className="os-num">{traderId}</span> }] : []),
    { label: t('onb.row.ftd'), value: <Badge tone={CHECK_TONE[d.check]} dot>{t(`onb.check.${d.check}`)}</Badge> },
    { label: t('onb.row.amount'), value: <span className="os-num">{d.check === 'confirmed' || d.check === 'checking' || d.check === 'error' ? money : '—'}</span> },
    { label: t('onb.row.threshold'), value: <span className="os-num">${d.thresholdUsd}</span> },
  ];
  if (date) rows.push({ label: t('onb.row.date'), value: date });
  return (
    <Panel className="os-rows overflow-hidden">
      {rows.map((r) => (
        <div key={r.label} className="flex items-center justify-between gap-4 px-4 py-3 text-[14px]">
          <span className="text-muted">{r.label}</span>
          <span className="text-right font-medium">{r.value}</span>
        </div>
      ))}
      {!d.sourceConnected ? <p className="px-4 py-3 text-[12px] leading-relaxed text-muted">{t('onb.noSource')}</p> : null}
    </Panel>
  );
}

function SupportStep() {
  const { t, me } = useApp();
  const contact = me!.binding.supportContact;
  return (
    <div className="flex flex-col">
      <Title>{t('onb.supportTitle')}</Title>
      <p className="mt-4 text-[16px] leading-relaxed text-fg/85">{t('onb.supportText')}</p>
      {contact ? <Button className="mt-8" size="lg" block onClick={() => openSupport(contact)}>{t('binding.contactSupport')}</Button> : null}
    </div>
  );
}
