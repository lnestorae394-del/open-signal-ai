import { useEffect, useLayoutEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react';
import {
  ALWAYS_OPEN_MODULES,
  DEFAULT_MARKET_SETTINGS,
  DEFAULT_PARTNER_SETTINGS,
  DEFAULT_TELEGRAM_SETTINGS,
  DEFAULT_THEME,
  MODULES,
  botConfigEditSchema,
  type BotConfigEdit,
  type ModuleId,
  type Theme,
} from '@open-signal/shared';
import { LANGUAGE_LABELS, SUPPORTED_LANGUAGES, type Lang } from '@open-signal/i18n';
import {
  Badge, Button, Field, IconAcademy, IconHistory, IconPairs, IconProfile, IconSignal, Input, LogoMark, Notice,
  Panel, Segmented, Select, Switch, TextArea, applyTheme, contrastRatio,
} from '@open-signal/ui';
import { useI18n } from '../i18n.tsx';

export const EMPTY_CONFIG: BotConfigEdit = {
  name: '',
  description: {},
  shortDescription: {},
  miniAppTitle: 'OPEN SIGNAL AI',
  defaultLanguage: 'ru',
  theme: DEFAULT_THEME,
  supportContact: '',
  modules: Object.fromEntries(MODULES.map((m) => [m, m !== 'account_binding'])) as BotConfigEdit['modules'],
  accountBinding: { traderIdPattern: '^[A-Za-z0-9_-]{3,64}$', gatedModules: ['signals'], recheckCooldownSec: 30, supportHintAfterHours: 24 },
  partner: DEFAULT_PARTNER_SETTINGS,
  telegram: DEFAULT_TELEGRAM_SETTINGS,
  markets: DEFAULT_MARKET_SETTINGS,
};

const COLOR_KEYS: (keyof Theme)[] = ['primary', 'secondary', 'accent', 'background', 'surface', 'card', 'text', 'textMuted', 'buttonFrom', 'buttonTo'];

function Section({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
  return (
    <Panel className="p-5 lg:p-6">
      <h2 className="text-[17px] font-semibold tracking-[-0.01em]">{title}</h2>
      {hint ? <p className="mt-1 text-[14px] text-muted">{hint}</p> : null}
      <div className="mt-5">{children}</div>
    </Panel>
  );
}

export interface BotFormProps {
  initial: BotConfigEdit;
  mode: 'create' | 'edit';
  serverFields?: Record<string, string>;
  busy: boolean;
  onSubmit(config: BotConfigEdit, token: string): void;
  extra?: ReactNode;
  submitLabel: string;
}

export function BotForm({ initial, mode, serverFields = {}, busy, onSubmit, extra, submitLabel }: BotFormProps) {
  const { t } = useI18n();
  const [form, setForm] = useState<BotConfigEdit>(initial);
  const [token, setToken] = useState('');
  const [descLang, setDescLang] = useState<Lang>(initial.defaultLanguage);
  const [showErrors, setShowErrors] = useState(false);

  const set = <K extends keyof BotConfigEdit>(k: K, v: BotConfigEdit[K]) => setForm((f) => ({ ...f, [k]: v }));
  const validation = useMemo(() => botConfigEditSchema.safeParse(form), [form]);
  const errors = useMemo(() => {
    const out: Record<string, string> = { ...serverFields };
    if (!validation.success) for (const i of validation.error.issues) out[i.path.join('.')] ??= i.message;
    if (mode === 'create' && !/^\d{5,16}:[A-Za-z0-9_-]{30,64}$/.test(token.trim())) out['token'] ??= t('admin.editor.tokenFormat');
    return out;
  }, [validation, serverFields, mode, token, t]);
  const err = (k: string) => (showErrors || serverFields[k] ? errors[k] : undefined);
  const canSubmit = Object.keys(errors).length === 0;

  const contrast = useMemo(() => {
    const th = form.theme;
    return Math.min(contrastRatio(th.text, th.background), contrastRatio(th.text, th.card), contrastRatio(th.textMuted, th.card));
  }, [form.theme]);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    setShowErrors(true);
    if (canSubmit) onSubmit(form, token.trim());
  };

  return (
    <form onSubmit={submit} className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_360px]">
      <div className="flex min-w-0 flex-col gap-5">
        {mode === 'create' ? (
          <Section title={t('admin.editor.sectionTelegram')} hint={t('admin.editor.tokenSteps')}>
            <Field label={t('admin.editor.token')} hint={t('admin.editor.tokenHelp')} error={err('token')} htmlFor="f-token">
              <Input id="f-token" type="password" autoComplete="off" spellCheck={false} value={token} invalid={Boolean(err('token'))} onChange={(e) => setToken(e.target.value)} placeholder="1234567890:AA…" />
            </Field>
            <p className="mt-3 text-[13px] text-muted">{t('admin.editor.usernameAuto')}</p>
          </Section>
        ) : null}

        <Section title={t('admin.editor.sectionIdentity')}>
          <div className="grid gap-4 md:grid-cols-2">
            <Field label={t('admin.editor.name')} error={err('name')} htmlFor="f-name">
              <Input id="f-name" value={form.name} maxLength={64} invalid={Boolean(err('name'))} onChange={(e) => set('name', e.target.value)} />
            </Field>
            <Field label={t('admin.editor.miniAppTitle')} error={err('miniAppTitle')} htmlFor="f-title">
              <Input id="f-title" value={form.miniAppTitle} maxLength={64} onChange={(e) => set('miniAppTitle', e.target.value)} />
            </Field>
            <Field label={t('admin.editor.defaultLanguage')} htmlFor="f-lang">
              <Select id="f-lang" value={form.defaultLanguage} onChange={(v) => set('defaultLanguage', v)} options={SUPPORTED_LANGUAGES.map((l) => ({ value: l, label: LANGUAGE_LABELS[l] }))} />
            </Field>
            <Field label={t('admin.editor.support')} htmlFor="f-support" error={err('supportContact')}>
              <Input id="f-support" value={form.supportContact} placeholder="@support" maxLength={128} onChange={(e) => set('supportContact', e.target.value)} />
            </Field>
          </div>
          <div className="mt-6">
            <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
              <span className="text-[13px] font-medium">{t('admin.editor.texts')}</span>
              <Segmented
                ariaLabel={t('admin.editor.texts')}
                value={descLang}
                onChange={setDescLang}
                options={SUPPORTED_LANGUAGES.map((l) => ({ value: l, label: <>{l.toUpperCase()}{form.description[l] ? <span className="text-success">●</span> : null}</> }))}
              />
            </div>
            <div className="grid gap-4">
              <Field label={t('admin.editor.description')} htmlFor="f-desc" aside={<span className="os-num text-[12px] text-muted">{(form.description[descLang] ?? '').length}/512</span>}>
                <TextArea id="f-desc" value={form.description[descLang] ?? ''} maxLength={512} onChange={(v) => set('description', { ...form.description, [descLang]: v })} />
              </Field>
              <Field label={t('admin.editor.shortDescription')} htmlFor="f-short" aside={<span className="os-num text-[12px] text-muted">{(form.shortDescription[descLang] ?? '').length}/120</span>}>
                <Input id="f-short" value={form.shortDescription[descLang] ?? ''} maxLength={120} onChange={(e) => set('shortDescription', { ...form.shortDescription, [descLang]: e.target.value })} />
              </Field>
            </div>
          </div>
        </Section>

        <Section title={t('admin.editor.sectionLook')}>
          <div className="mb-4 flex justify-end">
            <Button size="sm" variant="ghost" onClick={() => set('theme', DEFAULT_THEME)}>{t('admin.editor.resetTheme')}</Button>
          </div>
          <div className="grid gap-2.5 sm:grid-cols-2">
            {COLOR_KEYS.map((k) => (
              <ColorField key={k} label={t(`admin.editor.colors.${k}`)} value={form.theme[k]} onChange={(v) => set('theme', { ...form.theme, [k]: v })} />
            ))}
          </div>
          {contrast < 4.5 ? <Notice tone="warning" className="mt-4">{t('admin.editor.contrastWarning', { ratio: contrast.toFixed(1) })}</Notice> : null}
        </Section>

        <Section title={t('admin.editor.sectionModules')}>
          <ul className="grid gap-2 sm:grid-cols-2">
            {MODULES.map((m) => (
              <li key={m} className="flex items-center justify-between gap-3 rounded-xl bg-white/[0.03] px-4 py-3">
                <span className="text-[14px] font-medium">{t(`admin.modules.${m}`)}</span>
                <Switch label={t(`admin.modules.${m}`)} checked={form.modules[m] ?? false} onChange={(v) => set('modules', { ...form.modules, [m]: v })} />
              </li>
            ))}
          </ul>
        </Section>

        {form.modules.account_binding ? (
          <Section title={t('admin.editor.sectionBinding')} hint={t('admin.editor.alwaysOpen')}>
            <div className="mb-2 text-[13px] font-medium">{t('admin.editor.gated')}</div>
            <div className="mb-5 flex flex-wrap gap-2">
              {MODULES.filter((m) => m !== 'account_binding' && !ALWAYS_OPEN_MODULES.includes(m)).map((m: ModuleId) => {
                const on = form.accountBinding.gatedModules.includes(m);
                return (
                  <button
                    key={m}
                    type="button"
                    aria-pressed={on}
                    onClick={() =>
                      set('accountBinding', {
                        ...form.accountBinding,
                        gatedModules: on ? form.accountBinding.gatedModules.filter((x) => x !== m) : [...form.accountBinding.gatedModules, m],
                      })
                    }
                    className={on ? 'rounded-full bg-primary px-3 py-1.5 text-[13px] font-semibold text-on-primary' : 'rounded-full bg-white/[0.06] px-3 py-1.5 text-[13px] text-muted'}
                  >
                    {t(`admin.modules.${m}`)}
                  </button>
                );
              })}
            </div>
            <div className="grid gap-4 md:grid-cols-2">
              <Field label={t('admin.editor.traderIdPattern')} htmlFor="f-pattern" error={err('accountBinding.traderIdPattern')}>
                <Input id="f-pattern" value={form.accountBinding.traderIdPattern} onChange={(e) => set('accountBinding', { ...form.accountBinding, traderIdPattern: e.target.value })} />
              </Field>
              <Field label={t('admin.editor.recheckCooldown')} htmlFor="f-cool" error={err('accountBinding.recheckCooldownSec')}>
                <Input id="f-cool" type="number" value={String(form.accountBinding.recheckCooldownSec)} onChange={(e) => set('accountBinding', { ...form.accountBinding, recheckCooldownSec: Number(e.target.value) })} />
              </Field>
            </div>
          </Section>
        ) : null}

        {extra}

        <div className="sticky bottom-4 z-10 flex items-center justify-between gap-4 rounded-2xl border border-line bg-surface/90 p-3 pl-5 backdrop-blur-xl">
          <span className="text-[13px] text-muted">{showErrors && !canSubmit ? t('admin.editor.invalid') : ''}</span>
          <Button type="submit" busy={busy}>{submitLabel}</Button>
        </div>
      </div>

      <div className="xl:sticky xl:top-10 xl:self-start">
        <div className="mb-3 text-[13px] text-muted">{t('admin.editor.preview')}</div>
        <ThemePreview theme={form.theme} title={form.miniAppTitle || 'OPEN SIGNAL AI'} />
      </div>
    </form>
  );
}

function ColorField({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  const [text, setText] = useState(value);
  useEffect(() => setText(value), [value]);
  const valid = /^#[0-9a-fA-F]{6}$/.test(text);
  return (
    <label className="flex items-center gap-3 rounded-xl bg-white/[0.03] px-3 py-2">
      <input
        type="color"
        value={value}
        onChange={(e) => onChange(e.target.value.toUpperCase())}
        className="h-8 w-8 shrink-0 cursor-pointer rounded-lg border-0 bg-transparent p-0"
        aria-label={label}
      />
      <span className="min-w-0 flex-1 truncate text-[14px]">{label}</span>
      <input
        value={text}
        onChange={(e) => {
          const v = e.target.value.trim();
          setText(v);
          if (/^#[0-9a-fA-F]{6}$/.test(v)) onChange(v.toUpperCase());
        }}
        aria-invalid={!valid || undefined}
        className={valid ? 'os-num w-[84px] rounded-lg bg-black/40 px-2 py-1.5 text-[12px] outline-none' : 'os-num w-[84px] rounded-lg bg-danger/15 px-2 py-1.5 text-[12px] outline-none'}
      />
    </label>
  );
}

/** Live preview: the Mini App's own classes, rendered with the edited theme's CSS variables. */
export function ThemePreview({ theme, title }: { theme: Theme; title: string }) {
  const { t } = useI18n();
  const frame = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (frame.current) applyTheme(frame.current, theme);
  }, [theme]);
  const tabs: [ReactNode, string][] = [
    [<IconSignal size={18} key="s" />, 'nav.signals'],
    [<IconPairs size={18} key="p" />, 'nav.pairs'],
    [<IconHistory size={18} key="h" />, 'nav.history'],
    [<IconAcademy size={18} key="a" />, 'nav.academy'],
    [<IconProfile size={18} key="u" />, 'nav.profile'],
  ];
  return (
    <div ref={frame} className="os-canvas mx-auto w-full max-w-[340px] overflow-hidden rounded-[36px] border border-line-strong p-1 text-fg shadow-[0_40px_80px_-40px_rgb(0_0_0/0.9)]">
      <div className="flex items-center gap-2.5 px-4 pb-1 pt-5">
        <LogoMark size={28} />
        <div className="min-w-0 truncate text-[13px] font-semibold">{title}</div>
      </div>
      <div className="flex flex-col gap-3 px-3 pb-3 pt-3">
        <div className="grid grid-cols-2 rounded-xl bg-white/[0.06] p-0.5 text-center text-[11px] font-semibold">
          <span className="rounded-[10px] bg-fg py-1.5 text-bg">Forex</span>
          <span className="py-1.5 text-muted">OTC</span>
        </div>
        <div className="flex items-center gap-2 rounded-xl border border-warning/35 bg-warning/[0.09] px-2.5 py-1.5">
          <span className="rounded bg-warning px-1 py-0.5 text-[9px] font-bold text-black">DEMO / SIMULATED</span>
        </div>
        <div className="px-1">
          <div className="text-[12px] font-semibold">EUR/USD</div>
          <div className="mt-1 flex items-end gap-2">
            <span className="os-display os-num text-[30px] leading-none">1.08319</span>
            <span className="os-num mb-0.5 text-[11px] font-semibold text-success">+0.12%</span>
          </div>
        </div>
        <div className="os-panel flex h-24 items-end gap-[5px] overflow-hidden px-3 pb-3 pt-2" aria-hidden>
          <span className="bg-success w-full rounded-[2px]" style={{ height: 29, marginBottom: 21 }} />
          <span className="bg-primary w-full rounded-[2px]" style={{ height: 22, marginBottom: 15 }} />
          <span className="bg-success w-full rounded-[2px]" style={{ height: 25, marginBottom: 20 }} />
          <span className="bg-success w-full rounded-[2px]" style={{ height: 19, marginBottom: 17 }} />
          <span className="bg-primary w-full rounded-[2px]" style={{ height: 32, marginBottom: 14 }} />
          <span className="bg-success w-full rounded-[2px]" style={{ height: 24, marginBottom: 18 }} />
          <span className="bg-success w-full rounded-[2px]" style={{ height: 34, marginBottom: 13 }} />
          <span className="bg-primary w-full rounded-[2px]" style={{ height: 28, marginBottom: 21 }} />
          <span className="bg-success w-full rounded-[2px]" style={{ height: 36, marginBottom: 15 }} />
          <span className="bg-primary w-full rounded-[2px]" style={{ height: 31, marginBottom: 18 }} />
          <span className="bg-success w-full rounded-[2px]" style={{ height: 38, marginBottom: 13 }} />
          <span className="bg-success w-full rounded-[2px]" style={{ height: 35, marginBottom: 17 }} />
        </div>
        <span className="os-btn-primary flex h-10 items-center justify-center rounded-xl text-[12px] font-semibold">{t('demo.get')}</span>
        <div className="flex items-center gap-2 px-1 text-[12px]">
          <span className="h-2 w-2 rounded-full bg-accent" />
          <span className="text-secondary">{t('admin.editor.colors.accent')} / {t('admin.editor.colors.secondary')}</span>
        </div>
      </div>
      <div className="m-2 grid grid-cols-5 rounded-[22px] border border-line bg-surface py-1.5">
        {tabs.map(([icon, key], i) => (
          <div key={key} className={i === 0 ? 'flex flex-col items-center gap-0.5 text-[9px] font-medium text-fg' : 'flex flex-col items-center gap-0.5 text-[9px] font-medium text-muted'}>
            <span className={i === 0 ? 'text-primary' : ''}>{icon}</span>
            <span className="max-w-full truncate">{t(key)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
