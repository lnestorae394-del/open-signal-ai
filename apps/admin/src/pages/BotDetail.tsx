import { useCallback, useEffect, useState, type ChangeEvent } from 'react';
import { BINDING_STATES, type BotConfigEdit, type ManagerPermission } from '@open-signal/shared';
import { Badge, BarChart, Button, EmptyState, Field, IconLogs, IconUsers, Input, Notice, Panel, Select, Switch, cx } from '@open-signal/ui';
import { useI18n } from '../i18n.tsx';
import { useMe } from '../session.tsx';
import { api, ApiError, copyText, errorText, fileToBase64 } from '../lib/api.ts';
import type { BotDetail, DailyPoint, Me } from '../lib/types.ts';
import { dateTime, dayLabel } from '../lib/format.ts';
import { Loading, PageTitle, navigate } from '../components/layout.tsx';
import { BotForm } from '../components/BotForm.tsx';
import { STATUS_TONE, statusKey } from './Bots.tsx';
import { DeleteBotPanel, PartnerTab, TelegramTab } from './BotTabs.tsx';
import { UsersTable } from '../components/UsersTable.tsx';

type TabId = 'settings' | 'partner' | 'telegram' | 'users' | 'stats' | 'logs' | 'review' | 'danger';
const TABS: { id: TabId; perm: ManagerPermission | 'owner' }[] = [
  { id: 'settings', perm: 'bot.appearance.edit' },
  { id: 'partner', perm: 'bot.partner.edit' },
  { id: 'telegram', perm: 'bot.appearance.edit' },
  { id: 'users', perm: 'users.view' },
  { id: 'stats', perm: 'stats.view' },
  { id: 'logs', perm: 'logs.view' },
  { id: 'review', perm: 'binding.manage' },
  { id: 'danger', perm: 'bot.status.toggle' },
];

const allowed = (me: Me, botId: string, perm: ManagerPermission | 'owner') =>
  me.role === 'owner' || (perm !== 'owner' && Boolean(me.botPermissions[botId]?.includes(perm)));

export function BotDetailPage({ botId, tab }: { botId: string; tab: string | undefined }) {
  const { t } = useI18n();
  const me = useMe();
  const [bot, setBot] = useState<BotDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const tabs = TABS.filter((x) => allowed(me, botId, x.perm));
  const current = (tabs.find((x) => x.id === tab) ?? tabs[0])?.id;

  const load = useCallback(() => {
    api<{ bot: BotDetail }>('GET', `/bots/${botId}`).then((r) => setBot(r.bot), (e: unknown) => setError(errorText(t, e)));
  }, [botId, t]);
  useEffect(load, [load]);

  if (error) return <Notice tone="danger">{error}</Notice>;
  if (!bot) return <Loading />;

  return (
    <div className="os-enter">
      <PageTitle
        back={{ href: '#/bots', label: t('admin.bots.title') }}
        title={bot.name}
        subtitle={
          <span className="flex flex-wrap items-center gap-x-4 gap-y-2">
            <span>@{bot.username}</span>
            <Badge tone={STATUS_TONE[bot.status]} dot>{t(statusKey(bot.status))}</Badge>
            <a href={`https://t.me/${bot.username}`} target="_blank" rel="noreferrer" className="text-[14px] font-semibold text-primary">t.me/{bot.username}</a>
          </span>
        }
      />
      <div className="-mx-4 mb-8 overflow-x-auto px-4">
        <div className="flex w-max gap-1 rounded-2xl bg-white/[0.05] p-1" role="tablist">
          {tabs.map((x) => (
            <a
              key={x.id}
              role="tab"
              aria-selected={x.id === current}
              href={`#/bots/${botId}/${x.id}`}
              className={cx('rounded-xl px-4 py-2 text-[14px] font-semibold transition-colors', x.id === current ? 'bg-fg text-bg' : 'text-muted hover:text-fg')}
            >
              {t(`admin.tabs.${x.id}`)}
            </a>
          ))}
        </div>
      </div>
      {current === 'settings' && <SettingsTab bot={bot} onSaved={setBot} />}
      {current === 'partner' && <PartnerTab bot={bot} onSaved={setBot} />}
      {current === 'telegram' && <TelegramTab bot={bot} onSaved={setBot} />}
      {current === 'users' && <UsersTable botId={botId} />}
      {current === 'stats' && <StatsTab botId={botId} />}
      {current === 'logs' && <LogsTab botId={botId} />}
      {current === 'review' && <ReviewTab botId={botId} />}
      {current === 'danger' && <DangerTab bot={bot} onChanged={setBot} />}
    </div>
  );
}

// ───────── settings ─────────
export function SettingsTab({ bot, onSaved }: { bot: BotDetail; onSaved: (b: BotDetail) => void }) {
  const { t } = useI18n();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: 'success' | 'danger'; text: string } | null>(null);
  const [fields, setFields] = useState<Record<string, string>>({});
  const { botId: _b, updatedAt: _u, username: _n, avatarMediaId: _a, logoMediaId: _l, ...initial } = bot.config;

  const save = async (config: BotConfigEdit) => {
    setBusy(true);
    setMsg(null);
    try {
      await api('PUT', `/bots/${bot.botId}/config`, config);
      const fresh = await api<{ bot: BotDetail }>('GET', `/bots/${bot.botId}`);
      onSaved(fresh.bot);
      setFields({});
      setMsg({ tone: 'success', text: t('admin.editor.saved') });
    } catch (e) {
      if (e instanceof ApiError) setFields(e.fields);
      setMsg({ tone: 'danger', text: errorText(t, e) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      {msg ? <Notice tone={msg.tone} className="mb-5">{msg.text}</Notice> : null}
      <BotForm
        key={bot.config.updatedAt}
        mode="edit"
        initial={initial as BotConfigEdit}
        busy={busy}
        serverFields={fields}
        onSubmit={(c) => void save(c)}
        submitLabel={t('admin.editor.save')}
        extra={<MediaPanel bot={bot} onSaved={onSaved} />}
      />
    </>
  );
}

function MediaPanel({ bot, onSaved }: { bot: BotDetail; onSaved: (b: BotDetail) => void }) {
  const { t } = useI18n();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const upload = async (kind: 'logo' | 'avatar', e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setBusy(kind);
    setError(null);
    try {
      await api('POST', `/bots/${bot.botId}/media`, { kind, mime: file.type, data: await fileToBase64(file) });
      onSaved((await api<{ bot: BotDetail }>('GET', `/bots/${bot.botId}`)).bot);
    } catch (err) {
      setError(errorText(t, err));
    } finally {
      setBusy(null);
    }
  };
  return (
    <Panel className="p-5 lg:p-6">
      <h2 className="text-[17px] font-semibold">{t('admin.editor.media')}</h2>
      <div className="mt-5 grid gap-4 md:grid-cols-2">
        {(['logo', 'avatar'] as const).map((kind) => (
          <label key={kind} className="flex cursor-pointer items-center gap-4 rounded-2xl bg-white/[0.03] p-4 hover:bg-white/[0.05]">
            {kind === 'logo' && bot.logoUrl ? <img src={bot.logoUrl} alt="" className="h-12 w-12 rounded-[30%] object-cover" /> : <span className="grid h-12 w-12 place-items-center rounded-[30%] bg-white/[0.06] text-muted">+</span>}
            <span className="min-w-0">
              <span className="block text-[14px] font-semibold">{t(kind === 'logo' ? 'admin.editor.uploadLogo' : 'admin.editor.uploadAvatar')}</span>
              <span className="block text-[13px] text-muted">{busy === kind ? t('common.loading') : t(kind === 'logo' ? 'admin.editor.logoHint' : 'admin.editor.avatarHint')}</span>
            </span>
            <input type="file" accept={kind === 'logo' ? 'image/png,image/jpeg,image/webp' : 'image/jpeg'} className="sr-only" onChange={(e) => void upload(kind, e)} />
          </label>
        ))}
      </div>
      {error ? <Notice tone="danger" className="mt-4">{error}</Notice> : null}
    </Panel>
  );
}

// ───────── stats ─────────
const METRICS = [
  ['miniapp_launches', 'admin.stats.launches'],
  ['users_new', 'admin.stats.newUsers'],
  ['tg_start', 'admin.stats.starts'],
  ['tg_messages', 'admin.stats.messages'],
  ['signals_issued', 'admin.stats.signalsIssued'],
  ['signals_opened', 'admin.stats.signalsOpened'],
  ['postback_registration', 'admin.stats.registrations'],
  ['postback_ftd', 'admin.stats.ftds'],
] as const;

function StatsTab({ botId }: { botId: string }) {
  const { t, lang } = useI18n();
  const [days, setDays] = useState<DailyPoint[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api<{ days: DailyPoint[] }>('GET', `/bots/${botId}/stats?days=14`).then((r) => setDays(r.days), (e: unknown) => setError(errorText(t, e)));
  }, [botId, t]);
  if (error) return <Notice tone="danger">{error}</Notice>;
  if (!days) return <Loading />;
  const anyData = days.some((d) => Object.keys(d.metrics).length > 0);
  if (!anyData) return <Panel><EmptyState icon={<IconLogs />} text={t('admin.stats.empty')} /></Panel>;
  return (
    <div className="grid gap-4 md:grid-cols-2">
      {METRICS.map(([m, key]) => (
        <Panel key={m} className="p-5">
          <div className="flex items-baseline justify-between">
            <span className="text-[15px] font-semibold">{t(key)}</span>
            <span className="os-display os-num text-[28px]">{days.reduce((n, d) => n + (d.metrics[m] ?? 0), 0)}</span>
          </div>
          <div className="mt-4">
            <BarChart height={90} label={t(key)} points={days.map((d) => ({ label: dayLabel(d.day, lang), value: d.metrics[m] ?? null }))} />
          </div>
        </Panel>
      ))}
    </div>
  );
}

// ───────── logs ─────────
function LogsTab({ botId }: { botId: string }) {
  const { t, lang } = useI18n();
  const [type, setType] = useState<'errors' | 'audit'>('errors');
  const [items, setItems] = useState<Record<string, unknown>[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setItems(null);
    api<{ items: Record<string, unknown>[] }>('GET', `/bots/${botId}/logs?type=${type}`).then((r) => setItems(r.items), (e: unknown) => setError(errorText(t, e)));
  }, [botId, type, t]);
  return (
    <Panel className="overflow-hidden">
      <div className="flex gap-1 p-4">
        {(['errors', 'audit'] as const).map((k) => (
          <Button key={k} size="sm" variant={k === type ? 'primary' : 'secondary'} onClick={() => setType(k)}>{t(`admin.logsPage.${k}`)}</Button>
        ))}
      </div>
      {error ? <Notice tone="danger" className="m-4">{error}</Notice> : null}
      {!items ? <Loading /> : items.length === 0 ? (
        <EmptyState icon={<IconLogs />} text={t(type === 'errors' ? 'admin.logsPage.emptyErrors' : 'admin.logsPage.emptyAudit')} />
      ) : (
        <ul className="os-rows border-t border-line">
          {items.map((it) => (
            <li key={String(it['id'])} className="flex items-start justify-between gap-4 px-4 py-3 text-[14px]">
              <div className="min-w-0">
                <div className="font-medium">{type === 'errors' ? `${String(it['module'])} · ${String(it['code'])}` : String(it['action'])}</div>
                <div className="truncate text-[13px] text-muted">{type === 'errors' ? String(it['message']) : `${String((it['actor'] as { id?: string } | undefined)?.id ?? '')}${it['reason'] ? ` — ${String(it['reason'])}` : ''}`}</div>
              </div>
              <div className="shrink-0 text-right text-[12px] text-muted">
                {type === 'errors' ? <div className="os-num font-semibold text-fg">×{String(it['count'])}</div> : null}
                <div>{dateTime(String(type === 'errors' ? it['lastSeenAt'] : it['at']), lang)}</div>
              </div>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

// ───────── review ─────────
interface ReviewItem {
  telegramId: number;
  username: string | null;
  firstName: string;
  state: string;
  since: string;
  claims: { traderId: string; status: string; updatedAt: string }[];
}

function ReviewTab({ botId }: { botId: string }) {
  const { t, lang } = useI18n();
  const [items, setItems] = useState<ReviewItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => {
    api<{ items: ReviewItem[] }>('GET', `/bots/${botId}/review`).then((r) => setItems(r.items), (e: unknown) => setError(errorText(t, e)));
  }, [botId, t]);
  useEffect(load, [load]);
  if (error) return <Notice tone="danger">{error}</Notice>;
  if (!items) return <Loading />;
  if (!items.length) return <Panel><EmptyState icon={<IconUsers />} text={t('admin.review.empty')} /></Panel>;
  return (
    <div className="flex flex-col gap-4">
      {items.map((it) => (
        <ReviewCard key={it.telegramId} botId={botId} item={it} onDone={load} lang={lang} />
      ))}
    </div>
  );
}

function ReviewCard({ botId, item, onDone, lang }: { botId: string; item: ReviewItem; onDone: () => void; lang: 'ru' | 'uk' | 'en' }) {
  const { t } = useI18n();
  const [traderId, setTraderId] = useState(item.claims[0]?.traderId ?? '');
  const [reason, setReason] = useState('');
  const [release, setRelease] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const act = async (path: 'bind' | 'reset') => {
    setBusy(true);
    setError(null);
    try {
      await api('POST', `/bots/${botId}/binding/${path}`, { telegramId: item.telegramId, traderId, reason, releaseFromOther: release });
      onDone();
    } catch (e) {
      setError(errorText(t, e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Panel className="p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="text-[16px] font-semibold">{item.firstName}{item.username ? <span className="text-muted"> @{item.username}</span> : null}</div>
          <div className="os-num text-[13px] text-muted">{item.telegramId} · {dateTime(item.since, lang)}</div>
        </div>
        <Badge tone={item.state === 'manual_review' ? 'warning' : 'danger'} dot>{t(`binding.state.${item.state}`)}</Badge>
      </div>
      {item.claims.length ? (
        <ul className="mt-3 flex flex-wrap gap-2">
          {item.claims.map((c) => (
            <li key={c.traderId}><Badge>{c.traderId} — {c.status}</Badge></li>
          ))}
        </ul>
      ) : null}
      <div className="mt-5 grid gap-4 md:grid-cols-2">
        <Field label={t('binding.traderIdLabel')} htmlFor={`r-t-${item.telegramId}`}>
          <Input id={`r-t-${item.telegramId}`} value={traderId} onChange={(e) => setTraderId(e.target.value)} />
        </Field>
        <Field label={t('admin.review.reason')} htmlFor={`r-r-${item.telegramId}`}>
          <Input id={`r-r-${item.telegramId}`} value={reason} onChange={(e) => setReason(e.target.value)} />
        </Field>
      </div>
      <label className="mt-4 flex items-center gap-3 text-[14px]">
        <Switch checked={release} onChange={setRelease} label={t('admin.review.releaseOther')} />
        {t('admin.review.releaseOther')}
      </label>
      {error ? <Notice tone="danger" className="mt-4">{error}</Notice> : null}
      <div className="mt-5 flex flex-wrap gap-2">
        <Button busy={busy} disabled={!traderId || reason.trim().length < 5} onClick={() => void act('bind')}>{t('admin.review.bind')}</Button>
        <Button variant="secondary" disabled={busy || reason.trim().length < 5} onClick={() => void act('reset')}>{t('admin.review.reset')}</Button>
      </div>
    </Panel>
  );
}

// ───────── status & token ─────────
function DangerTab({ bot, onChanged }: { bot: BotDetail; onChanged: (b: BotDetail) => void }) {
  const { t, lang } = useI18n();
  const me = useMe();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [token, setToken] = useState('');
  const refresh = async () => onChanged((await api<{ bot: BotDetail }>('GET', `/bots/${bot.botId}`)).bot);
  const run = async (key: string, fn: () => Promise<unknown>) => {
    setBusy(key);
    setError(null);
    try {
      await fn();
      await refresh();
    } catch (e) {
      setError(errorText(t, e));
    } finally {
      setBusy(null);
    }
  };
  const tg = bot.telegram;
  return (
    <div className="flex flex-col gap-5">
      {error ? <Notice tone="danger">{error}</Notice> : null}
      <Panel className="p-5 lg:p-6">
        <h2 className="text-[17px] font-semibold">{t('admin.danger.statusTitle')}</h2>
        <p className="mt-1 text-[14px] text-muted">{t('admin.danger.statusText')}</p>
        <div className="mt-5 flex flex-wrap gap-2">
          {bot.status !== 'active' ? <Button busy={busy === 'active'} onClick={() => void run('active', () => api('POST', `/bots/${bot.botId}/status`, { status: 'active' }))}>{t('admin.danger.activate')}</Button> : null}
          {bot.status === 'active' ? <Button variant="secondary" busy={busy === 'disabled'} onClick={() => void run('disabled', () => api('POST', `/bots/${bot.botId}/status`, { status: 'disabled' }))}>{t('admin.danger.disable')}</Button> : null}
          {me.role === 'owner' && bot.status !== 'archived' ? <Button variant="danger" busy={busy === 'archived'} onClick={() => void run('archived', () => api('POST', `/bots/${bot.botId}/status`, { status: 'archived' }))}>{t('admin.danger.archive')}</Button> : null}
        </div>
      </Panel>

      <Panel className="p-5 lg:p-6">
        <h2 className="text-[17px] font-semibold">Telegram</h2>
        <dl className="mt-4 grid gap-3 text-[14px] md:grid-cols-2">
          <div><dt className="text-[13px] text-muted">Webhook</dt><dd className="mt-0.5 break-all">{tg?.webhookUrl ?? '—'}</dd></div>
          <div><dt className="text-[13px] text-muted">{t('admin.danger.syncedAt')}</dt><dd className="mt-0.5">{dateTime(tg?.syncedAt, lang)}</dd></div>
          <div><dt className="text-[13px] text-muted">Mini App</dt><dd className="mt-0.5 break-all">{bot.miniAppUrl}</dd></div>
          <div><dt className="text-[13px] text-muted">{t('admin.editor.token')}</dt><dd className="os-num mt-0.5">{bot.tokenMasked ?? '—'}</dd></div>
        </dl>
        {tg?.issues.length ? (
          <Notice tone="warning" className="mt-4">
            <div className="font-semibold">{t('admin.danger.issues')}</div>
            <ul className="mt-1 list-disc pl-5">{tg.issues.map((i) => <li key={i}>{i}</li>)}</ul>
          </Notice>
        ) : null}
        <Button className="mt-5" variant="secondary" busy={busy === 'sync'} onClick={() => void run('sync', () => api('POST', `/bots/${bot.botId}/telegram-sync`))}>{t('admin.danger.resync')}</Button>
      </Panel>

      {me.role === 'owner' ? (
        <Panel className="p-5 lg:p-6">
          <h2 className="text-[17px] font-semibold">{t('admin.danger.tokenTitle')}</h2>
          <p className="mt-1 text-[14px] text-muted">{t('admin.danger.tokenText')}</p>
          <div className="mt-4 flex flex-col gap-3 md:flex-row">
            <Input type="password" autoComplete="off" value={token} onChange={(e) => setToken(e.target.value)} placeholder="1234567890:AA…" />
            <Button busy={busy === 'token'} disabled={!token} onClick={() => void run('token', async () => { await api('POST', `/bots/${bot.botId}/token`, { token: token.trim() }); setToken(''); })}>
              {t('admin.danger.replace')}
            </Button>
          </div>
        </Panel>
      ) : null}
      {me.role === 'owner' ? <DeleteBotPanel bot={bot} /> : null}
      <div>
        <Button variant="ghost" onClick={() => navigate('/bots')}>{t('common.back')}</Button>
      </div>
    </div>
  );
}
