import { useEffect, useLayoutEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react';
import {
  DEFAULT_PARTNER_SETTINGS,
  DEFAULT_TELEGRAM_SETTINGS,
  DEFAULT_THEME,
  MODULES,
  botConfigEditSchema,
  type BotConfigEdit,
  type Theme,
} from '@open-signal/shared';
import { LANGUAGE_LABELS, SUPPORTED_LANGUAGES, type Lang } from '@open-signal/i18n';
import {
  Badge, Button, Field, IconAcademy, IconProfile, IconSignal, Input, LogoMark, Notice,
  Panel, Segmented, Select, TextArea, applyTheme, contrastRatio,
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
  // Modules are no longer configured per bot: every bot has the same signals and academy.
  modules: Object.fromEntries(MODULES.map((m) => [m, true])) as BotConfigEdit['modules'],
  accountBinding: { traderIdPattern: '^[A-Za-z0-9_-]{3,64}$', gatedModules: ['signals'], recheckCooldownSec: 30, supportHintAfterHours: 24 },
  partner: DEFAULT_PARTNER_SETTINGS,
  telegram: DEFAULT_TELEGRAM_SETTINGS,
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

        <Section title={t('admin.editor.sectionBinding')} hint={t('admin.editor.bindingHint')}>
          <div className="max-w-md">
            <Field label={t('admin.editor.traderIdPattern')} hint={t('admin.editor.traderIdPatternHint')} htmlFor="f-pattern" error={err('accountBinding.traderIdPattern')}>
              <Input id="f-pattern" value={form.accountBinding.traderIdPattern} onChange={(e) => set('accountBinding', { ...form.accountBinding, traderIdPattern: e.target.value })} />
            </Field>
          </div>
        </Section>

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
        <div className="px-1 text-[11px] text-muted">{t('sig.pair')}</div>
        <div className="os-panel flex items-center gap-2.5 px-3 py-3">
          <span className="relative h-6 w-10 shrink-0" aria-hidden>
            <span className="absolute left-0 top-0 grid h-6 w-6 place-items-center rounded-full bg-white/[0.09] pr-1.5 text-[7px] font-semibold">EUR</span>
            <span className="absolute left-4 top-0 grid h-6 w-6 place-items-center rounded-full border-2 border-card bg-[#26262b] text-[7px] font-semibold">USD</span>
          </span>
          <span className="text-[14px] font-semibold">EUR/USD</span>
        </div>
        <div className="px-1 text-[11px] text-muted">{t('sig.time')}</div>
        <div className="grid grid-cols-3 gap-1.5">
          {['15 s', '1 min', '5 min'].map((p, i) => (
            <span key={p} className={i === 1 ? 'rounded-xl bg-fg py-2 text-center text-[11px] font-semibold text-bg' : 'rounded-xl bg-white/[0.06] py-2 text-center text-[11px] font-semibold'}>{p}</span>
          ))}
        </div>
        <span className="os-btn-primary flex h-10 items-center justify-center rounded-xl text-[12px] font-semibold">{t('sig.get')}</span>
        <div className="grid grid-cols-2 gap-1.5">
          <span className="rounded-xl border border-success/30 bg-success/[0.08] py-2 text-center text-[13px] font-bold text-success">BUY</span>
          <span className="rounded-xl border border-primary/30 bg-primary/[0.08] py-2 text-center text-[13px] font-bold text-primary">SELL</span>
        </div>
      </div>
      <div className="m-2 grid grid-cols-3 rounded-[22px] border border-line bg-surface py-1.5">
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
