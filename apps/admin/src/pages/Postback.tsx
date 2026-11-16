import { useCallback, useEffect, useState } from 'react';
import { Badge, Button, EmptyState, Field, IconLogs, Input, Notice, Panel, Segmented, Select, Switch } from '@open-signal/ui';
import { useI18n } from '../i18n.tsx';
import { useMe } from '../session.tsx';
import { api, copyText, errorText } from '../lib/api.ts';
import type { BotSummary } from '../lib/types.ts';
import { dateTime } from '../lib/format.ts';
import { Loading, PageTitle } from '../components/layout.tsx';

interface SourceView {
  id: string;
  scope: 'global' | 'bot';
  botId: string | null;
  name: string;
  enabled: boolean;
  authMethod: string;
  authLocation: string;
  postbackUrl: string;
  mapping: Record<string, string | null>;
  eventTypeMap: Record<string, string>;
}

interface EventRow {
  id: string;
  botId: string;
  botName: string;
  global: boolean;
  eventType: string;
  rawEventType: string;
  traderId: string;
  clickTelegramId: number | null;
  matchStatus: string;
  matchedTelegramId: number | null;
  amount: number | null;
  currency: string | null;
  deliveryCount: number;
  conflictingDelivery: { amount: number | null; currency: string | null; at: string } | null;
  possibleDuplicate?: boolean;
  excluded?: { at: string; reason: string } | null;
  canExclude?: boolean;
  receivedAt: string;
}

interface ErrorRow {
  id: string;
  botId: string;
  global: boolean;
  code: string;
  message: string;
  count: number;
  lastSeenAt: string;
}

type View = 'source' | 'events' | 'errors';

/** One global postback for every bot: source, registrations & deposits history, integration errors. */
export function PostbackPage() {
  const { t } = useI18n();
  const me = useMe();
  const [view, setView] = useState<View>(me.role === 'owner' ? 'source' : 'events');
  return (
    <div className="os-enter">
      <PageTitle title={t('admin.postback.title')} subtitle={t('admin.postback.subtitle')} />
      {me.role === 'owner' ? (
        <div className="mb-6 max-w-lg">
          <Segmented
            block
            ariaLabel={t('admin.postback.title')}
            value={view}
            onChange={setView}
            options={[
              { value: 'source', label: t('admin.postback.source') },
              { value: 'events', label: t('admin.postback.events') },
              { value: 'errors', label: t('admin.postback.errors') },
            ]}
          />
        </div>
      ) : null}
      {view === 'source' ? <SourcePanel /> : view === 'events' ? <EventsPanel /> : <ErrorsPanel />}
    </div>
  );
}

/** Pocket Partners sends one postback per event; the event type is a fixed value we put in each URL. */
const PP_DEFAULT = { name: 'Pocket Partners', authName: 'key', eventType: 'event', traderId: 'trader_id', clickId: 'click_id', amount: 'sumdep', currency: '', eventId: '', occurredAt: '', regName: 'reg', ftdName: 'ftd', redepositName: 'dep' };

function SourcePanel() {
  const { t } = useI18n();
  const [list, setList] = useState<SourceView[] | null>(null);
  const [secret, setSecret] = useState<{ id: string; value: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState(PP_DEFAULT);
  const load = useCallback(() => {
    api<{ sources: SourceView[] }>('GET', '/postback/sources').then((r) => setList(r.sources), (e: unknown) => setError(errorText(t, e)));
  }, [t]);
  useEffect(load, [load]);

  const create = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ source: SourceView; secret: string }>('POST', '/postback/sources', {
        name: form.name,
        authMethod: 'secret_query',
        authName: form.authName,
        mapping: { eventType: form.eventType, traderId: form.traderId, clickId: form.clickId, amount: form.amount, currency: form.currency, eventId: form.eventId, occurredAt: form.occurredAt },
        eventTypeMap: { [form.regName]: 'registration', [form.ftdName]: 'ftd', [form.redepositName]: 'redeposit' },
      });
      setSecret({ id: r.source.id, value: r.secret });
      load();
    } catch (e) {
      setError(errorText(t, e));
    } finally {
      setBusy(false);
    }
  };
  const update = async (id: string, body: Record<string, unknown>) => {
    try {
      const r = await api<{ secret: string | null }>('PUT', `/postback/sources/${id}`, body);
      if (r.secret) setSecret({ id, value: r.secret });
      load();
    } catch (e) {
      setError(errorText(t, e));
    }
  };
  const f = (k: keyof typeof PP_DEFAULT, label: string, hint?: string) => (
    <Field label={label} hint={hint} htmlFor={`s-${k}`}>
      <Input id={`s-${k}`} value={form[k]} onChange={(e) => setForm({ ...form, [k]: e.target.value })} />
    </Field>
  );
  const global = list?.find((s) => s.scope === 'global') ?? null;

  return (
    <div className="flex flex-col gap-5">
      {error ? <Notice tone="danger">{error}</Notice> : null}
      {!list ? <Loading /> : null}
      {list?.map((s) => (
        <Panel key={s.id} className="p-5 lg:p-6">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex flex-wrap items-center gap-2 text-[16px] font-semibold">
              {s.name}
              <Badge tone={s.scope === 'global' ? 'success' : 'neutral'}>{s.scope === 'global' ? t('admin.postback.scopeGlobal') : t('admin.postback.scopeBot', { bot: s.botId ?? '' })}</Badge>
            </div>
            <label className="flex items-center gap-2 text-[14px]">
              <Switch checked={s.enabled} onChange={(v) => void update(s.id, { enabled: v })} label={t('admin.sources.enabled')} />
              {t('admin.sources.enabled')}
            </label>
          </div>
          {secret?.id === s.id ? (
            <Notice tone="warning" className="mt-4">
              <div className="font-semibold">{t('admin.sources.secretOnce')}</div>
              <div className="os-num mt-2 break-all rounded-lg bg-black/40 px-3 py-2 text-fg">{secret.value}</div>
              <Button size="sm" variant="secondary" className="mt-2" onClick={() => void copyText(secret.value)}>{t('admin.copy')}</Button>
            </Notice>
          ) : null}
          {s.scope === 'global' ? <PocketTemplates source={s} secret={secret?.id === s.id ? secret.value : null} /> : (
            <>
              <div className="mt-4 text-[13px] text-muted">{t('admin.sources.url')}</div>
              <div className="os-num mt-1 break-all rounded-lg bg-white/[0.04] px-3 py-2 text-[13px]">{s.postbackUrl}</div>
              <p className="mt-2 text-[13px] text-muted">{t('admin.postback.legacyNote')}</p>
            </>
          )}
          <div className="mt-4">
            <Button size="sm" variant="ghost" onClick={() => void update(s.id, { rotateSecret: true })}>{t('admin.sources.rotate')}</Button>
          </div>
        </Panel>
      ))}

      {list && !global ? (
        <Panel className="p-5 lg:p-6">
          <h2 className="text-[17px] font-semibold">{t('admin.postback.createGlobal')}</h2>
          <p className="mt-1 max-w-2xl text-[14px] text-muted">{t('admin.postback.createHint')}</p>
          <div className="mt-5 grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            {f('name', t('admin.sources.name'))}
            {f('authName', t('admin.postback.fKey'))}
            {f('eventType', t('admin.sources.mEventType'))}
            {f('traderId', t('admin.sources.mTraderId'))}
            {f('clickId', t('admin.sources.mClickId'))}
            {f('amount', t('admin.postback.fAmount'))}
            {f('regName', t('admin.postback.fReg'))}
            {f('ftdName', t('admin.postback.fFtd'))}
            {f('redepositName', t('admin.postback.fDep'))}
            {f('currency', t('admin.postback.fCurrency'), t('admin.postback.optional'))}
            {f('eventId', t('admin.sources.mEventId'), t('admin.postback.optional'))}
            {f('occurredAt', t('admin.sources.mOccurredAt'), t('admin.postback.optional'))}
          </div>
          <Notice tone="info" className="mt-5">{t('admin.postback.dedupNote')}</Notice>
          <Button className="mt-5" busy={busy} disabled={!form.name || !form.eventType || !form.traderId || !form.clickId || !form.regName || !form.ftdName} onClick={() => void create()}>
            {t('admin.postback.createGlobal')}
          </Button>
        </Panel>
      ) : null}
    </div>
  );
}

/** Ready-to-paste postback URLs for the three Pocket Partners events. */
function PocketTemplates({ source: s, secret }: { source: SourceView; secret: string | null }) {
  const { t } = useI18n();
  const raw = (type: string) => Object.entries(s.eventTypeMap).find(([, v]) => v === type)?.[0] ?? type;
  const m = s.mapping;
  // authLocation is "query:<param>" for a secret in the URL.
  const keyParam = s.authLocation.startsWith('query:') ? s.authLocation.slice(6) : 'key';
  const head = `${s.postbackUrl}?${keyParam}=${secret ?? 'SECRET'}`;
  const line = (type: 'registration' | 'ftd' | 'redeposit') =>
    `${head}&${m['eventType']}=${raw(type)}&${m['clickId']}={click_id}&${m['traderId']}={trader_id}${type !== 'registration' && m['amount'] ? `&${m['amount']}={sumdep}` : ''}`;
  const rows: { label: string; url: string }[] = [
    { label: t('admin.postback.pbReg'), url: line('registration') },
    { label: t('admin.postback.pbFtd'), url: line('ftd') },
    { label: t('admin.postback.pbDep'), url: line('redeposit') },
  ];
  return (
    <div className="mt-4 flex flex-col gap-3">
      <p className="text-[13px] text-muted">{t('admin.postback.templatesHint')}</p>
      {rows.map((r) => (
        <div key={r.label}>
          <div className="text-[13px] font-medium">{r.label}</div>
          <div className="mt-1 flex items-start gap-2">
            <div className="os-num min-w-0 flex-1 break-all rounded-lg bg-white/[0.04] px-3 py-2 text-[12.5px]">{r.url}</div>
            <Button size="sm" variant="secondary" onClick={() => void copyText(r.url)}>{t('admin.copy')}</Button>
          </div>
        </div>
      ))}
      {!secret ? <p className="text-[12px] text-muted">{t('admin.postback.secretPlaceholder')}</p> : null}
    </div>
  );
}

const MATCH_TONE: Record<string, 'neutral' | 'success' | 'warning' | 'danger' | 'info'> = {
  matched: 'success',
  awaiting_confirmation: 'info',
  unmatched: 'neutral',
  conflict: 'danger',
  review: 'warning',
};

function EventsPanel() {
  const { t, lang } = useI18n();
  const [bots, setBots] = useState<BotSummary[]>([]);
  const [bot, setBot] = useState('');
  const [type, setType] = useState('');
  const [rows, setRows] = useState<EventRow[] | null>(null);
  const [next, setNext] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    void api<{ bots: BotSummary[] }>('GET', '/bots').then((r) => setBots(r.bots), () => undefined);
  }, []);
  const load = useCallback(
    async (before: string | null) => {
      try {
        const q = new URLSearchParams({ ...(bot ? { botId: bot } : {}), ...(type ? { type } : {}), ...(before ? { before } : {}) });
        const r = await api<{ events: EventRow[]; nextBefore: string | null }>('GET', `/postback/events?${q}`);
        setRows((prev) => (before && prev ? [...prev, ...r.events] : r.events));
        setNext(r.nextBefore);
        setError(null);
      } catch (e) {
        setError(errorText(t, e));
      }
    },
    [bot, type, t],
  );
  useEffect(() => {
    setRows(null);
    void load(null);
  }, [load]);
  const money = (a: number | null, c: string | null) => (a === null ? '—' : new Intl.NumberFormat(lang, { style: 'currency', currency: c ?? 'USD' }).format(a));

  return (
    <Panel className="overflow-hidden">
      <div className="flex flex-wrap items-center gap-3 p-4">
        <div className="w-full max-w-[240px]">
          <Select ariaLabel={t('admin.users.bot')} value={bot} onChange={setBot} options={[{ value: '', label: t('admin.users.allBots') }, ...bots.map((b) => ({ value: b.botId, label: b.name }))]} />
        </div>
        <div className="w-full max-w-[240px]">
          <Select
            ariaLabel={t('admin.postback.type')}
            value={type}
            onChange={setType}
            options={[{ value: '', label: t('admin.postback.allTypes') }, ...['registration', 'ftd', 'redeposit'].map((v) => ({ value: v, label: t(`admin.postback.eventType.${v}`) }))]}
          />
        </div>
      </div>
      {error ? <Notice tone="danger" className="m-4">{error}</Notice> : null}
      {!rows ? <Loading /> : rows.length === 0 ? (
        <EmptyState icon={<IconLogs />} text={t('admin.postback.noEvents')} />
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[1000px] text-left text-[14px]">
            <thead className="text-[13px] text-muted">
              <tr className="border-y border-line">
                <th className="px-4 py-2.5 font-medium">{t('admin.postback.received')}</th>
                <th className="px-4 py-2.5 font-medium">{t('admin.users.bot')}</th>
                <th className="px-4 py-2.5 font-medium">{t('admin.postback.type')}</th>
                <th className="px-4 py-2.5 font-medium">Trader ID</th>
                <th className="px-4 py-2.5 font-medium">{t('admin.postback.user')}</th>
                <th className="px-4 py-2.5 font-medium">{t('admin.postback.amount')}</th>
                <th className="px-4 py-2.5 font-medium">{t('admin.postback.status')}</th>
                <th className="px-4 py-2.5 font-medium">{t('admin.postback.deliveries')}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((e) => (
                <tr key={e.id} className="border-b border-line align-top last:border-0">
                  <td className="px-4 py-3 text-muted">{dateTime(e.receivedAt, lang)}</td>
                  <td className="px-4 py-3">{e.botName}</td>
                  <td className="px-4 py-3">
                    {t(`admin.postback.eventType.${e.eventType}`)}
                    <div className="os-num text-[12px] text-muted">{e.rawEventType}</div>
                  </td>
                  <td className="os-num px-4 py-3">{e.traderId}</td>
                  <td className="os-num px-4 py-3">
                    {e.matchedTelegramId ?? e.clickTelegramId ?? '—'}
                  </td>
                  <td className="os-num px-4 py-3">
                    {money(e.amount, e.currency)}
                    {e.conflictingDelivery ? <div className="text-[12px] text-danger">{t('admin.postback.conflict', { amount: money(e.conflictingDelivery.amount, e.conflictingDelivery.currency) })}</div> : null}
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex flex-col items-start gap-1.5">
                      <Badge tone={MATCH_TONE[e.matchStatus] ?? 'neutral'}>{t(`admin.postback.match.${e.matchStatus}`)}</Badge>
                      {e.possibleDuplicate && !e.excluded ? <Badge tone="warning">{t('admin.postback.possibleDuplicate')}</Badge> : null}
                      {e.excluded ? (
                        <div className="text-[12px] text-muted">
                          <Badge tone="neutral">{t('admin.postback.excluded')}</Badge>
                          <div className="mt-1 max-w-[220px]">{e.excluded.reason}</div>
                        </div>
                      ) : null}
                      {e.canExclude ? <ExcludeControl row={e} onDone={(x) => setRows((prev) => prev?.map((r) => (r.id === e.id ? { ...r, excluded: x } : r)) ?? prev)} /> : null}
                    </div>
                  </td>
                  <td className="os-num px-4 py-3">{e.deliveryCount}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {next ? (
        <div className="p-4">
          <Button variant="secondary" onClick={() => void load(next)}>{t('admin.users.loadMore')}</Button>
        </div>
      ) : null}
    </Panel>
  );
}

/** Exclude a deposit event from the totals (or restore it). A reason is required; the action is audited. */
function ExcludeControl({ row, onDone }: { row: EventRow; onDone: (excluded: EventRow['excluded']) => void }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const exclude = !row.excluded;
  if (!open) {
    return (
      <Button size="sm" variant="ghost" onClick={() => setOpen(true)}>
        {exclude ? t('admin.postback.exclude') : t('admin.postback.restore')}
      </Button>
    );
  }
  const submit = async () => {
    setBusy(true);
    try {
      const r = await api<{ excluded: EventRow['excluded'] }>('POST', `/postback/events/${encodeURIComponent(row.id)}/excluded`, { excluded: exclude, reason });
      onDone(r.excluded ? { at: r.excluded.at, reason: r.excluded.reason } : null);
      setOpen(false);
      setReason('');
      setError(null);
    } catch (e) {
      setError(errorText(t, e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="flex w-[240px] flex-col gap-2">
      <Input aria-label={t('admin.postback.reason')} placeholder={t('admin.postback.reasonPlaceholder')} value={reason} onChange={(ev) => setReason(ev.target.value)} />
      <div className="flex gap-2">
        <Button size="sm" variant={exclude ? 'danger' : 'secondary'} disabled={busy || reason.trim().length < 5} onClick={() => void submit()}>
          {exclude ? t('admin.postback.exclude') : t('admin.postback.restore')}
        </Button>
        <Button size="sm" variant="ghost" onClick={() => setOpen(false)}>{t('common.cancel')}</Button>
      </div>
      {error ? <div className="text-[12px] text-danger">{error}</div> : null}
    </div>
  );
}

function ErrorsPanel() {
  const { t, lang } = useI18n();
  const [rows, setRows] = useState<ErrorRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api<{ items: ErrorRow[] }>('GET', '/postback/errors').then((r) => setRows(r.items), (e: unknown) => setError(errorText(t, e)));
  }, [t]);
  if (error) return <Notice tone="danger">{error}</Notice>;
  if (!rows) return <Loading />;
  if (!rows.length) return <Panel><EmptyState icon={<IconLogs />} text={t('admin.postback.noErrors')} /></Panel>;
  return (
    <Panel className="os-rows overflow-hidden">
      {rows.map((r) => (
        <div key={r.id} className="flex flex-wrap items-start justify-between gap-3 px-5 py-4">
          <div className="min-w-0">
            <div className="flex items-center gap-2 text-[14px] font-semibold">
              {t(`admin.postback.errCode.${r.code}`) === `admin.postback.errCode.${r.code}` ? r.code : t(`admin.postback.errCode.${r.code}`)}
              <Badge>{r.global ? t('admin.postback.scopeGlobal') : r.botId}</Badge>
            </div>
            <div className="mt-1 break-all text-[13px] text-muted">{r.message}</div>
          </div>
          <div className="text-right text-[13px] text-muted">
            <div className="os-num">×{r.count}</div>
            <div>{dateTime(r.lastSeenAt, lang)}</div>
          </div>
        </div>
      ))}
    </Panel>
  );
}
