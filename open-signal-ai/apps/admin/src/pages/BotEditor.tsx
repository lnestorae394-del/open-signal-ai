import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { DEFAULT_THEME, MODULES, botCreateInputSchema, type BotCreateInput, type ModuleId, type Theme } from '@open-signal/shared';
import { LANGUAGE_LABELS, SUPPORTED_LANGUAGES, type Lang } from '@open-signal/i18n';
import {
  Badge, Button, Card, Field, IconAcademy, IconHistory, IconInfo, IconPairs, IconProfile, IconScan, IconSignal,
  Input, LogoMark, Notice, SectionTitle, Segmented, Switch, applyTheme, contrastRatio,
} from '@open-signal/ui';
import { useI18n } from '../i18n.tsx';
import { PageTitle, navigate } from '../components/layout.tsx';

type FormState = Omit<BotCreateInput, 'accountBinding' | 'shortDescription'>;

const initialModules = Object.fromEntries(MODULES.map((m) => [m, m !== 'account_binding'])) as Record<ModuleId, boolean>;

const INITIAL: FormState = {
  name: '',
  username: '',
  token: '',
  description: {},
  miniAppTitle: 'OPEN SIGNAL AI',
  defaultLanguage: 'ru',
  supportContact: '',
  theme: DEFAULT_THEME,
  modules: initialModules,
};

const COLOR_KEYS: (keyof Theme)[] = ['primary', 'secondary', 'accent', 'background', 'surface', 'card', 'text', 'textMuted', 'buttonFrom', 'buttonTo'];

export function BotEditorPage() {
  const { t } = useI18n();
  const [form, setForm] = useState<FormState>(INITIAL);
  const [touched, setTouched] = useState<Record<string, boolean>>({});
  const [descLang, setDescLang] = useState<Lang>('ru');

  const set = <K extends keyof FormState>(k: K, v: FormState[K]) => setForm((f) => ({ ...f, [k]: v }));
  const touch = (k: string) => setTouched((x) => ({ ...x, [k]: true }));

  // Same Zod schema the API uses — one source of validation truth.
  const validation = useMemo(() => botCreateInputSchema.safeParse({ ...form, shortDescription: {}, accountBinding: {} }), [form]);
  const errors = useMemo(() => {
    const out: Record<string, string> = {};
    if (!validation.success) for (const i of validation.error.issues) out[String(i.path[0])] ??= i.message;
    return out;
  }, [validation]);
  const err = (k: string) => (touched[k] ? errors[k] : undefined);

  const contrastIssues = useMemo(() => {
    const th = form.theme;
    const checks: [string, string][] = [
      [th.text, th.background],
      [th.text, th.card],
      [th.textMuted, th.card],
    ];
    return checks.map(([a, b]) => contrastRatio(a, b)).filter((r) => r < 4.5);
  }, [form.theme]);

  return (
    <div className="os-rise">
      <PageTitle
        title={t('admin.editor.title')}
        action={
          <div className="flex items-center gap-2">
            <Button variant="ghost" onClick={() => navigate('bots')}>{t('common.cancel')}</Button>
            <Button disabled title={t('admin.editor.saveDisabled')}>{t('common.save')}</Button>
          </div>
        }
      />

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_360px]">
        <div className="flex flex-col gap-5">
          <Notice tone={validation.success ? 'success' : 'neutral'} icon={<IconInfo size={16} />}>
            {validation.success ? t('admin.editor.valid') : t('admin.editor.invalid')} · {t('admin.editor.saveDisabled')}
          </Notice>

          <Card>
            <SectionTitle>{t('admin.editor.sectionIdentity')}</SectionTitle>
            <div className="grid gap-4 md:grid-cols-2">
              <Field label={t('admin.editor.name')} error={err('name')} htmlFor="f-name">
                <Input id="f-name" value={form.name} maxLength={64} invalid={Boolean(err('name'))} onBlur={() => touch('name')} onChange={(e) => set('name', e.target.value)} />
              </Field>
              <Field label={t('admin.editor.miniAppTitle')} error={err('miniAppTitle')} htmlFor="f-title">
                <Input id="f-title" value={form.miniAppTitle} maxLength={64} onBlur={() => touch('miniAppTitle')} onChange={(e) => set('miniAppTitle', e.target.value)} />
              </Field>
              <Field label={t('admin.editor.defaultLanguage')} htmlFor="f-lang">
                <select
                  id="f-lang"
                  value={form.defaultLanguage}
                  onChange={(e) => set('defaultLanguage', e.target.value as Lang)}
                  className="h-11 rounded-xl border border-line-strong bg-black/30 px-3 text-sm text-fg outline-none focus:border-primary/70"
                >
                  {SUPPORTED_LANGUAGES.map((l) => <option key={l} value={l} className="bg-card">{LANGUAGE_LABELS[l]}</option>)}
                </select>
              </Field>
              <Field label={t('admin.editor.support')} htmlFor="f-support">
                <Input id="f-support" value={form.supportContact} placeholder="@support" maxLength={128} onChange={(e) => set('supportContact', e.target.value)} />
              </Field>
            </div>
            <div className="mt-4">
              <div className="mb-2 flex items-center justify-between gap-3">
                <span className="text-xs font-medium text-muted">{t('admin.editor.description')}</span>
                <Segmented ariaLabel="Description language" value={descLang} onChange={setDescLang} options={SUPPORTED_LANGUAGES.map((l) => ({ value: l, label: l.toUpperCase() + (form.description[l] ? ' ✓' : '') }))} />
              </div>
              <textarea
                value={form.description[descLang] ?? ''}
                maxLength={512}
                rows={3}
                onChange={(e) => set('description', { ...form.description, [descLang]: e.target.value })}
                className="w-full rounded-xl border border-line-strong bg-black/30 px-3.5 py-3 text-sm text-fg outline-none focus:border-primary/70"
              />
              <div className="mt-1 text-right text-[11px] text-muted">{(form.description[descLang] ?? '').length}/512</div>
            </div>
          </Card>

          <Card>
            <SectionTitle>{t('admin.editor.sectionTelegram')}</SectionTitle>
            <div className="grid gap-4 md:grid-cols-2">
              <Field label={t('admin.editor.username')} error={err('username')} htmlFor="f-username">
                <Input id="f-username" value={form.username} placeholder="MySignalBot" invalid={Boolean(err('username'))} onBlur={() => touch('username')} onChange={(e) => set('username', e.target.value.replace(/^@/, ''))} />
              </Field>
              <Field label={t('admin.editor.token')} hint={t('admin.editor.tokenHelp')} error={err('token')} htmlFor="f-token">
                <Input
                  id="f-token"
                  type="password"
                  autoComplete="off"
                  spellCheck={false}
                  value={form.token}
                  invalid={Boolean(err('token'))}
                  onBlur={() => touch('token')}
                  onChange={(e) => set('token', e.target.value)}
                />
              </Field>
              <Field label={t('admin.editor.avatar')} hint={t('admin.editor.uploadLater')}>
                <Button variant="secondary" disabled>{t('admin.editor.avatar')}</Button>
              </Field>
              <Field label={t('admin.editor.logo')} hint={t('admin.editor.uploadLater')}>
                <Button variant="secondary" disabled>{t('admin.editor.logo')}</Button>
              </Field>
            </div>
          </Card>

          <Card>
            <SectionTitle action={<Button size="sm" variant="ghost" onClick={() => set('theme', DEFAULT_THEME)}>{t('admin.editor.resetTheme')}</Button>}>
              {t('admin.editor.sectionLook')}
            </SectionTitle>
            <div className="grid gap-3 sm:grid-cols-2">
              {COLOR_KEYS.map((k) => (
                <ColorField key={k} label={t(`admin.editor.colors.${k}`)} value={form.theme[k]} onChange={(v) => set('theme', { ...form.theme, [k]: v })} />
              ))}
            </div>
            {contrastIssues.length ? (
              <div className="mt-4">
                <Notice tone="warning">{t('admin.editor.contrastWarning', { ratio: Math.min(...contrastIssues).toFixed(1) })}</Notice>
              </div>
            ) : null}
          </Card>

          <Card>
            <SectionTitle>{t('admin.editor.sectionModules')}</SectionTitle>
            <ul className="grid gap-2 sm:grid-cols-2">
              {MODULES.map((m) => (
                <li key={m} className="flex items-center justify-between gap-3 rounded-xl border border-line px-3.5 py-3">
                  <span className="text-sm font-medium">{t(`admin.modules.${m}`)}</span>
                  <Switch label={t(`admin.modules.${m}`)} checked={form.modules[m] ?? false} onChange={(v) => set('modules', { ...form.modules, [m]: v })} />
                </li>
              ))}
            </ul>
          </Card>
        </div>

        <div className="xl:sticky xl:top-8 xl:self-start">
          <div className="mb-3 text-xs font-semibold uppercase tracking-[0.14em] text-muted">{t('admin.editor.preview')}</div>
          <ThemePreview theme={form.theme} title={form.miniAppTitle || 'OPEN SIGNAL AI'} lang={form.defaultLanguage} />
        </div>
      </div>
    </div>
  );
}

function ColorField({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  const [text, setText] = useState(value);
  const valid = /^#[0-9a-fA-F]{6}$/.test(text);
  useEffect(() => setText(value), [value]); // external changes (e.g. "reset theme")
  return (
    <label className="flex items-center gap-3 rounded-xl border border-line bg-white/[0.02] px-3 py-2.5">
      <input
        type="color"
        value={value}
        onChange={(e) => {
          setText(e.target.value.toUpperCase());
          onChange(e.target.value.toUpperCase());
        }}
        className="h-9 w-9 shrink-0 cursor-pointer rounded-lg border border-line-strong bg-transparent p-0.5"
        aria-label={label}
      />
      <span className="min-w-0 flex-1 truncate text-sm">{label}</span>
      <input
        value={text}
        onChange={(e) => {
          const v = e.target.value.trim();
          setText(v);
          if (/^#[0-9a-fA-F]{6}$/.test(v)) onChange(v.toUpperCase());
        }}
        aria-invalid={!valid || undefined}
        className={`w-[86px] rounded-lg border bg-black/30 px-2 py-1.5 font-mono text-xs outline-none ${valid ? 'border-line-strong' : 'border-danger/60'}`}
      />
    </label>
  );
}

/** Live preview: the same design-system classes rendered with the edited theme's CSS variables. */
function ThemePreview({ theme, title, lang }: { theme: Theme; title: string; lang: Lang }) {
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
    <div ref={frame} className="phone-frame os-ambient mx-auto w-full max-w-[340px] overflow-hidden text-fg" lang={lang}>
      <div className="flex items-center gap-2.5 px-4 pb-3 pt-5">
        <LogoMark size={30} />
        <div className="min-w-0 leading-tight">
          <div className="truncate text-[13px] font-extrabold tracking-[0.14em]">{title}</div>
          <div className="text-[10px] text-muted">{t('signals.subtitle')}</div>
        </div>
      </div>
      <div className="flex flex-col gap-3 px-4">
        <div className="os-card os-card-hero p-3.5">
          <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted">{t('signals.marketTitle')}</div>
          <div className="mt-1.5 flex items-center gap-2">
            <span className="os-glow-dot h-2 w-2 rounded-full bg-primary" />
            <span className="text-[15px] font-bold">{t('signals.forexOpen')}</span>
          </div>
          <div className="mt-2.5"><Badge tone="danger" dot>{t('status.UNAVAILABLE')}</Badge></div>
        </div>
        <div className="grid grid-cols-2 gap-2">
          <span className="os-btn-primary flex h-11 items-center justify-center gap-1.5 rounded-xl text-xs font-semibold"><IconScan size={16} />{t('signals.autoScan')}</span>
          <span className="flex h-11 items-center justify-center rounded-xl border border-line-strong bg-white/[0.04] text-xs font-semibold">{t('signals.selectPair')}</span>
        </div>
        <div className="os-card p-3.5">
          <div className="text-[10px] font-semibold uppercase tracking-[0.12em] text-muted">{t('signals.recent')}</div>
          <div className="mt-2 h-2 w-3/4 rounded bg-white/[0.06]" />
          <div className="mt-1.5 h-2 w-1/2 rounded bg-white/[0.06]" />
          <div className="mt-3 flex items-center gap-2 text-[11px]"><span className="text-accent">●</span><span className="text-secondary">{t('admin.editor.colors.accent')}</span></div>
        </div>
      </div>
      <div className="mt-4 grid grid-cols-5 border-t border-line px-1 pb-4 pt-2">
        {tabs.map(([icon, key], i) => (
          <div key={key} className={`flex flex-col items-center gap-1 text-[9px] font-semibold ${i === 0 ? 'text-fg' : 'text-muted'}`}>
            <span className={`grid h-7 w-10 place-items-center rounded-full ${i === 0 ? 'bg-primary/18 text-primary' : ''}`}>{icon}</span>
            <span className="truncate">{t(key)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
