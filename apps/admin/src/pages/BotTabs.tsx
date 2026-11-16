import { useEffect, useState, type ReactNode } from 'react';
import type { PartnerSettings, TelegramSettings } from '@open-signal/shared';
import { LANGUAGE_LABELS, SUPPORTED_LANGUAGES } from '@open-signal/i18n';
import { Badge, Button, Field, Input, Notice, Panel, TextArea } from '@open-signal/ui';
import { useI18n } from '../i18n.tsx';
import { ApiError, api, copyText, errorText } from '../lib/api.ts';
import type { BotDetail } from '../lib/types.ts';
import { dateTime } from '../lib/format.ts';
import { navigate } from '../components/layout.tsx';

type Msg = { tone: 'success' | 'danger' | 'warning'; text: string } | null;

function Section({ title, hint, action, children }: { title: string; hint?: string; action?: ReactNode; children: ReactNode }) {
  return (
    <Panel className="p-5 lg:p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-[17px] font-semibold tracking-[-0.01em]">{title}</h2>
          {hint ? <p className="mt-1 max-w-2xl text-[14px] text-muted">{hint}</p> : null}
        </div>
        {action}
      </div>
      <div className="mt-5">{children}</div>
    </Panel>
  );
}

// ───────────────────────── partner link ─────────────────────────

interface LinkCheck {
  valid: boolean;
  https: boolean;
  hasClickId: boolean;
  sample: string | null;
  reachable: boolean | null;
  httpStatus: number | null;
  redirectTo: string | null;
  chain?: { url: string; status: number | null; clickIdInUrl: boolean }[];
  clickIdInFinalUrl?: boolean | null;
  problems: string[];
}

export function PartnerTab({ bot, onSaved }: { bot: BotDetail; onSaved: (b: BotDetail) => void }) {
  const { t } = useI18n();
  const cur = bot.config.partner;
  const [link, setLink] = useState(cur.linkTemplate ?? '');
  const [partnerId, setPartnerId] = useState(cur.partnerId ?? '');
  const [buttonText, setButtonText] = useState<PartnerSettings['buttonText']>(cur.buttonText);
  const [busy, setBusy] = useState<'save' | 'check' | null>(null);
  const [msg, setMsg] = useState<Msg>(null);
  const [fields, setFields] = useState<Record<string, string>>({});
  const [check, setCheck] = useState<LinkCheck | null>(null);
  const configured = Boolean(cur.linkTemplate);
  const dirty = link !== (cur.linkTemplate ?? '') || partnerId !== (cur.partnerId ?? '') || JSON.stringify(buttonText) !== JSON.stringify(cur.buttonText);

  const save = async () => {
    setBusy('save');
    setMsg(null);
    try {
      const r = await api<{ bot: BotDetail }>('PUT', `/bots/${bot.botId}/partner`, { linkTemplate: link.trim(), partnerId: partnerId.trim(), buttonText });
      onSaved(r.bot);
      setFields({});
      setMsg({ tone: 'success', text: link.trim() ? t('admin.partner.saved') : t('admin.partner.cleared') });
    } catch (e) {
      if (e instanceof ApiError) setFields(e.fields);
      setMsg({ tone: 'danger', text: errorText(t, e) });
    } finally {
      setBusy(null);
    }
  };
  const runCheck = async () => {
    setBusy('check');
    setCheck(null);
    try {
      setCheck((await api<{ check: LinkCheck }>('POST', `/bots/${bot.botId}/partner/check`, { linkTemplate: link.trim(), partnerId: partnerId.trim() })).check);
    } catch (e) {
      setMsg({ tone: 'danger', text: errorText(t, e) });
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="flex flex-col gap-5">
      <Section
        title={t('admin.partner.title')}
        hint={t('admin.partner.hint')}
        action={<Badge tone={configured ? 'success' : 'warning'} dot>{configured ? t('admin.partner.configured') : t('admin.partner.notConfigured')}</Badge>}
      >
        <div className="grid gap-4">
          <Field label={t('admin.partner.link')} hint={t('admin.partner.linkHint')} error={fields['linkTemplate']} htmlFor="p-link">
            <Input id="p-link" value={link} invalid={Boolean(fields['linkTemplate'])} placeholder="https://broker.example/register?sub_id={click_id}" onChange={(e) => setLink(e.target.value)} />
          </Field>
          <div className="grid gap-4 md:grid-cols-3">
            {SUPPORTED_LANGUAGES.map((l) => (
              <Field key={l} label={t('admin.partner.buttonText', { lang: LANGUAGE_LABELS[l] })} htmlFor={`p-btn-${l}`}>
                <Input id={`p-btn-${l}`} maxLength={40} value={buttonText[l] ?? ''} placeholder={t('onb.registerButton')} onChange={(e) => setButtonText({ ...buttonText, [l]: e.target.value })} />
              </Field>
            ))}
          </div>
          <div className="max-w-sm">
            <Field label={t('admin.partner.partnerId')} hint={t('admin.partner.partnerIdHint')} error={fields['partnerId']} htmlFor="p-pid">
              <Input id="p-pid" value={partnerId} maxLength={64} onChange={(e) => setPartnerId(e.target.value)} />
            </Field>
          </div>
        </div>
        {msg ? <Notice tone={msg.tone} className="mt-5">{msg.text}</Notice> : null}
        <div className="mt-5 flex flex-wrap gap-2">
          <Button busy={busy === 'save'} disabled={!dirty} onClick={() => void save()}>{t('admin.partner.save')}</Button>
          <Button variant="secondary" busy={busy === 'check'} disabled={!link.trim()} onClick={() => void runCheck()}>{t('admin.partner.check')}</Button>
        </div>
        {check ? <CheckResult check={check} /> : null}
      </Section>
      <Notice tone="info">{t('admin.partner.howItWorks')}</Notice>
    </div>
  );
}

function CheckResult({ check }: { check: LinkCheck }) {
  const { t } = useI18n();
  const ok = check.valid && check.problems.length === 0 && check.reachable !== false;
  return (
    <div className="mt-5 rounded-2xl border border-line bg-white/[0.03] p-4 text-[14px]">
      <div className="flex items-center gap-2 font-semibold">
        <Badge tone={ok ? 'success' : 'warning'} dot>{ok ? t('admin.partner.checkOk') : t('admin.partner.checkProblems')}</Badge>
      </div>
      {check.problems.length ? (
        <ul className="mt-3 list-disc pl-5 text-warning">
          {check.problems.map((p) => <li key={p}>{t(`admin.partner.problem.${p}`) === `admin.partner.problem.${p}` ? p : t(`admin.partner.problem.${p}`)}</li>)}
        </ul>
      ) : null}
      <dl className="mt-3 grid gap-2">
        {check.sample ? <div><dt className="text-[12px] text-muted">{t('admin.partner.sample')}</dt><dd className="break-all">{check.sample}</dd></div> : null}
        {check.chain && check.chain.length ? (
          <div>
            <dt className="text-[12px] text-muted">{t('admin.partner.chain')}</dt>
            <dd>
              <ol className="mt-1 flex flex-col gap-1.5">
                {check.chain.map((h, i) => (
                  <li key={i} className="flex items-start gap-2">
                    <span className="os-num w-12 shrink-0 text-muted">{h.status ?? '—'}</span>
                    <span className="min-w-0 flex-1 break-all text-[13px]">{h.url}</span>
                    <Badge tone={h.clickIdInUrl ? 'success' : 'neutral'}>{h.clickIdInUrl ? t('admin.partner.clickInUrl') : t('admin.partner.clickNotInUrl')}</Badge>
                  </li>
                ))}
              </ol>
              <p className="mt-2 text-[12.5px] text-muted">{t('admin.partner.chainHint')}</p>
            </dd>
          </div>
        ) : check.reachable !== null ? (
          <div>
            <dt className="text-[12px] text-muted">{t('admin.partner.response')}</dt>
            <dd>{check.reachable ? `HTTP ${check.httpStatus}` : t('admin.partner.unreachable')}{check.redirectTo ? ` → ${check.redirectTo}` : ''}</dd>
          </div>
        ) : null}
      </dl>
    </div>
  );
}

// ───────────────────────── Telegram ─────────────────────────

interface WebhookInfo {
  url: string;
  expectedUrl: string;
  matches: boolean;
  pendingUpdates: number;
  lastErrorAt: string | null;
  lastErrorMessage: string | null;
}

export function TelegramTab({ bot, onSaved }: { bot: BotDetail; onSaved: (b: BotDetail) => void }) {
  const { t, lang } = useI18n();
  const [form, setForm] = useState<TelegramSettings>(bot.config.telegram);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<Msg>(null);
  const [webhook, setWebhook] = useState<WebhookInfo | null>(null);
  const [whError, setWhError] = useState<string | null>(null);
  const tg = bot.telegram;

  const loadWebhook = () =>
    api<{ webhook: WebhookInfo }>('GET', `/bots/${bot.botId}/webhook`).then(
      (r) => (setWebhook(r.webhook), setWhError(null)),
      (e: unknown) => setWhError(errorText(t, e)),
    );
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => void loadWebhook(), [bot.botId]);

  const save = async () => {
    setBusy('save');
    setMsg(null);
    try {
      const r = await api<{ bot: BotDetail }>('PUT', `/bots/${bot.botId}/telegram`, form);
      onSaved(r.bot);
      const failed = r.bot.telegram?.steps?.filter((s) => !s.ok) ?? [];
      setMsg(failed.length ? { tone: 'warning', text: t('admin.telegram.partial') } : { tone: 'success', text: t('admin.telegram.saved') });
    } catch (e) {
      setMsg({ tone: 'danger', text: errorText(t, e) });
    } finally {
      setBusy(null);
    }
  };
  const resync = async () => {
    setBusy('sync');
    setMsg(null);
    try {
      await api('POST', `/bots/${bot.botId}/telegram-sync`);
      onSaved((await api<{ bot: BotDetail }>('GET', `/bots/${bot.botId}`)).bot);
      await loadWebhook();
    } catch (e) {
      setMsg({ tone: 'danger', text: errorText(t, e) });
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="flex flex-col gap-5">
      <Section title={t('admin.telegram.title')} hint={t('admin.telegram.hint')}>
        <div className="grid gap-4">
          <div className="max-w-sm">
            <Field label={t('admin.telegram.menuButton')} hint={t('admin.telegram.menuButtonHint')} htmlFor="tg-menu">
              <Input id="tg-menu" maxLength={32} value={form.menuButtonText} onChange={(e) => setForm({ ...form, menuButtonText: e.target.value })} />
            </Field>
          </div>
          <div className="grid gap-4 lg:grid-cols-3">
            {SUPPORTED_LANGUAGES.map((l) => (
              <Field key={l} label={t('admin.telegram.welcome', { lang: LANGUAGE_LABELS[l] })} htmlFor={`tg-w-${l}`}>
                <TextArea id={`tg-w-${l}`} rows={4} maxLength={1000} value={form.welcomeText[l] ?? ''} placeholder={t('admin.telegram.welcomeDefault')} onChange={(v) => setForm({ ...form, welcomeText: { ...form.welcomeText, [l]: v } })} />
              </Field>
            ))}
          </div>
          <p className="text-[13px] text-muted">{t('admin.telegram.welcomeNote')}</p>
        </div>
        {msg ? <Notice tone={msg.tone} className="mt-5">{msg.text}</Notice> : null}
        <div className="mt-5 flex flex-wrap gap-2">
          <Button busy={busy === 'save'} disabled={!form.menuButtonText.trim()} onClick={() => void save()}>{t('admin.telegram.save')}</Button>
          <Button variant="secondary" busy={busy === 'sync'} onClick={() => void resync()}>{t('admin.danger.resync')}</Button>
        </div>
      </Section>

      <Section title={t('admin.telegram.stepsTitle')} hint={tg?.syncedAt ? `${t('admin.danger.syncedAt')}: ${dateTime(tg.syncedAt, lang)}` : undefined}>
        {tg?.steps?.length ? (
          <ul className="os-rows">
            {tg.steps.map((s, i) => (
              <li key={`${s.name}-${i}`} className="flex items-start justify-between gap-4 py-2.5 text-[14px]">
                <span>
                  <span className="font-medium">{t(`admin.telegram.step.${s.name}`) === `admin.telegram.step.${s.name}` ? s.name : t(`admin.telegram.step.${s.name}`)}</span>
                  {s.error ? <span className="mt-0.5 block text-[13px] text-danger">{s.error}</span> : null}
                </span>
                <Badge tone={s.ok ? 'success' : 'danger'} dot>{s.ok ? t('admin.telegram.confirmed') : t('admin.telegram.failed')}</Badge>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-[14px] text-muted">{t('admin.telegram.noSteps')}</p>
        )}
      </Section>

      <Section title={t('admin.telegram.webhookTitle')} action={webhook ? <Badge tone={webhook.matches ? 'success' : 'danger'} dot>{webhook.matches ? t('admin.telegram.webhookOk') : t('admin.telegram.webhookWrong')}</Badge> : null}>
        {whError ? <Notice tone="danger">{whError}</Notice> : !webhook ? <p className="text-[14px] text-muted">…</p> : (
          <dl className="grid gap-3 text-[14px] md:grid-cols-2">
            <div><dt className="text-[13px] text-muted">{t('admin.telegram.webhookCurrent')}</dt><dd className="mt-0.5 break-all">{webhook.url || '—'}</dd></div>
            <div><dt className="text-[13px] text-muted">{t('admin.telegram.webhookExpected')}</dt><dd className="mt-0.5 break-all">{webhook.expectedUrl}</dd></div>
            <div><dt className="text-[13px] text-muted">{t('admin.telegram.pending')}</dt><dd className="os-num mt-0.5">{webhook.pendingUpdates}</dd></div>
            <div><dt className="text-[13px] text-muted">{t('admin.telegram.lastError')}</dt><dd className="mt-0.5">{webhook.lastErrorMessage ? `${webhook.lastErrorMessage} (${dateTime(webhook.lastErrorAt, lang)})` : '—'}</dd></div>
            <div className="md:col-span-2"><dt className="text-[13px] text-muted">Mini App</dt><dd className="mt-0.5 break-all">{bot.miniAppUrl}</dd></div>
          </dl>
        )}
      </Section>
    </div>
  );
}

// ───────────────────────── delete ─────────────────────────

export function DeleteBotPanel({ bot }: { bot: BotDetail }) {
  const { t } = useI18n();
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const remove = async () => {
    setBusy(true);
    setError(null);
    try {
      await api('DELETE', `/bots/${bot.botId}`, { confirm: confirm.trim() });
      navigate('/bots');
    } catch (e) {
      setError(errorText(t, e));
      setBusy(false);
    }
  };
  return (
    <Panel className="border-danger/40 p-5 lg:p-6">
      <h2 className="text-[17px] font-semibold text-danger">{t('admin.delete.title')}</h2>
      <p className="mt-1 max-w-2xl text-[14px] text-muted">{t('admin.delete.text')}</p>
      <div className="mt-4 max-w-md">
        <Field label={t('admin.delete.confirm', { username: `@${bot.username}` })} htmlFor="del-confirm">
          <Input id="del-confirm" autoComplete="off" value={confirm} onChange={(e) => setConfirm(e.target.value)} placeholder={`@${bot.username}`} />
        </Field>
        <button type="button" className="mt-1 text-[12px] text-muted underline" onClick={() => void copyText(`@${bot.username}`).then(setCopied)}>{copied ? t('admin.copied') : t('admin.copy')}</button>
      </div>
      {error ? <Notice tone="danger" className="mt-4">{error}</Notice> : null}
      <Button className="mt-4" variant="danger" busy={busy} disabled={confirm.trim().replace(/^@/, '').toLowerCase() !== bot.username.toLowerCase()} onClick={() => void remove()}>
        {t('admin.delete.button')}
      </Button>
    </Panel>
  );
}
