import { useCallback, useEffect, useState } from 'react';
import { MANAGER_PERMISSIONS, type ManagerPermission } from '@open-signal/shared';
import { Badge, Button, EmptyState, Field, IconShield, Input, Notice, Panel, Switch } from '@open-signal/ui';
import { useI18n } from '../i18n.tsx';
import { api, copyText, errorText } from '../lib/api.ts';
import type { BotSummary } from '../lib/types.ts';
import { dateTime } from '../lib/format.ts';
import { Loading, PageTitle } from '../components/layout.tsx';

interface Manager {
  uid: string;
  email: string;
  active: boolean;
  invitePending: boolean;
  botPermissions: Record<string, ManagerPermission[]>;
  lastLoginAt: string | null;
}

type Perms = Record<string, ManagerPermission[]>;

function PermissionMatrix({ bots, value, onChange }: { bots: BotSummary[]; value: Perms; onChange: (p: Perms) => void }) {
  const { t } = useI18n();
  const toggle = (botId: string, p: ManagerPermission) => {
    const cur = value[botId] ?? [];
    const next = cur.includes(p) ? cur.filter((x) => x !== p) : [...cur, p];
    const out = { ...value, [botId]: next };
    if (!next.length) delete out[botId];
    onChange(out);
  };
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[640px] text-[13px]">
        <thead>
          <tr className="text-left text-muted">
            <th className="py-2 pr-3 font-medium">{t('admin.nav.bots')}</th>
            {MANAGER_PERMISSIONS.map((p) => <th key={p} className="px-1 py-2 text-center font-medium">{t(`admin.permissions.${p}`)}</th>)}
          </tr>
        </thead>
        <tbody>
          {bots.map((b) => (
            <tr key={b.botId} className="border-t border-line">
              <td className="py-2.5 pr-3 font-medium">{b.name}</td>
              {MANAGER_PERMISSIONS.map((p) => (
                <td key={p} className="px-1 py-2.5 text-center">
                  <input type="checkbox" className="h-4 w-4 accent-[var(--os-primary)]" checked={(value[b.botId] ?? []).includes(p)} onChange={() => toggle(b.botId, p)} aria-label={`${b.name}: ${t(`admin.permissions.${p}`)}`} />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function ManagersPage() {
  const { t, lang } = useI18n();
  const [managers, setManagers] = useState<Manager[] | null>(null);
  const [bots, setBots] = useState<BotSummary[]>([]);
  const [email, setEmail] = useState('');
  const [perms, setPerms] = useState<Perms>({});
  const [invite, setInvite] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);

  const load = useCallback(() => {
    Promise.all([api<{ managers: Manager[] }>('GET', '/managers'), api<{ bots: BotSummary[] }>('GET', '/bots')]).then(
      ([m, b]) => {
        setManagers(m.managers);
        setBots(b.bots);
      },
      (e: unknown) => setError(errorText(t, e)),
    );
  }, [t]);
  useEffect(load, [load]);

  const create = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ inviteUrl: string }>('POST', '/managers', { email, botPermissions: perms });
      setInvite(r.inviteUrl);
      setEmail('');
      setPerms({});
      load();
    } catch (e) {
      setError(errorText(t, e));
    } finally {
      setBusy(false);
    }
  };
  const update = async (uid: string, body: Record<string, unknown>) => {
    try {
      await api('PUT', `/managers/${uid}`, body);
      load();
    } catch (e) {
      setError(errorText(t, e));
    }
  };
  const reissue = async (uid: string) => {
    try {
      setInvite((await api<{ inviteUrl: string }>('POST', `/managers/${uid}/invite`)).inviteUrl);
    } catch (e) {
      setError(errorText(t, e));
    }
  };

  return (
    <div className="os-enter">
      <PageTitle title={t('admin.managers.title')} subtitle={t('admin.managersPage.text')} />
      {invite ? (
        <Notice tone="success" className="mb-5">
          <div className="font-semibold">{t('admin.managers.inviteLink')}</div>
          <div className="mt-2 break-all rounded-lg bg-black/40 px-3 py-2 text-fg">{invite}</div>
          <Button size="sm" variant="secondary" className="mt-2" onClick={() => void copyText(invite).then(setCopied)}>{copied ? t('admin.copied') : t('admin.copy')}</Button>
        </Notice>
      ) : null}
      {error ? <Notice tone="danger" className="mb-5">{error}</Notice> : null}
      {!managers ? <Loading /> : (
        <div className="flex flex-col gap-5">
          {managers.length === 0 ? <Panel><EmptyState icon={<IconShield />} text={t('admin.managers.empty')} /></Panel> : null}
          {managers.map((m) => (
            <ManagerCard key={m.uid} m={m} bots={bots} lang={lang} onSave={(p) => void update(m.uid, { botPermissions: p })} onActive={(v) => void update(m.uid, { active: v })} onInvite={() => void reissue(m.uid)} />
          ))}
          <Panel className="p-5 lg:p-6">
            <h2 className="text-[17px] font-semibold">{t('admin.managers.create')}</h2>
            {bots.length === 0 ? <p className="mt-2 text-[14px] text-muted">{t('admin.managers.noBots')}</p> : (
              <>
                <div className="mt-5 max-w-md">
                  <Field label={t('admin.auth.email')} htmlFor="m-email">
                    <Input id="m-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
                  </Field>
                </div>
                <div className="mt-5"><PermissionMatrix bots={bots} value={perms} onChange={setPerms} /></div>
                <Button className="mt-5" busy={busy} disabled={!email || Object.keys(perms).length === 0} onClick={() => void create()}>{t('admin.managers.create')}</Button>
              </>
            )}
          </Panel>
        </div>
      )}
    </div>
  );
}

function ManagerCard({ m, bots, lang, onSave, onActive, onInvite }: { m: Manager; bots: BotSummary[]; lang: 'ru' | 'uk' | 'en'; onSave: (p: Perms) => void; onActive: (v: boolean) => void; onInvite: () => void }) {
  const { t } = useI18n();
  const [perms, setPerms] = useState<Perms>(m.botPermissions);
  const dirty = JSON.stringify(perms) !== JSON.stringify(m.botPermissions);
  return (
    <Panel className="p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="text-[16px] font-semibold">{m.email}</div>
          <div className="text-[13px] text-muted">{m.invitePending ? t('admin.managers.pending') : `${t('admin.managers.lastLogin')}: ${dateTime(m.lastLoginAt, lang)}`}</div>
        </div>
        <div className="flex items-center gap-3">
          {m.invitePending ? <Button size="sm" variant="secondary" onClick={onInvite}>{t('admin.managers.reissue')}</Button> : null}
          <Badge tone={m.active ? 'success' : 'neutral'} dot>{m.active ? t('admin.managers.active') : t('admin.managers.inactive')}</Badge>
          <Switch checked={m.active} onChange={onActive} label={t('admin.managers.active')} />
        </div>
      </div>
      <div className="mt-4"><PermissionMatrix bots={bots} value={perms} onChange={setPerms} /></div>
      {dirty ? <Button className="mt-4" size="sm" onClick={() => onSave(perms)}>{t('admin.editor.save')}</Button> : null}
    </Panel>
  );
}

export function AccountPage() {
  const { t } = useI18n();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [msg, setMsg] = useState<{ tone: 'success' | 'danger'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    setBusy(true);
    setMsg(null);
    try {
      await api('POST', '/password', { current, next });
      setCurrent('');
      setNext('');
      setMsg({ tone: 'success', text: t('admin.account.changed') });
    } catch (e) {
      setMsg({ tone: 'danger', text: errorText(t, e) });
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="os-enter">
      <PageTitle title={t('admin.account.title')} />
      <Panel className="max-w-lg p-5 lg:p-6">
        <h2 className="text-[17px] font-semibold">{t('admin.account.changePassword')}</h2>
        <div className="mt-5 flex flex-col gap-4">
          <Field label={t('admin.account.current')} htmlFor="a-cur"><Input id="a-cur" type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} /></Field>
          <Field label={t('admin.account.next')} hint={t('admin.auth.passwordHint')} htmlFor="a-next"><Input id="a-next" type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} /></Field>
          {msg ? <Notice tone={msg.tone}>{msg.text}</Notice> : null}
          <Button busy={busy} disabled={!current || next.length < 10} onClick={() => void submit()}>{t('admin.account.changePassword')}</Button>
        </div>
      </Panel>
    </div>
  );
}
