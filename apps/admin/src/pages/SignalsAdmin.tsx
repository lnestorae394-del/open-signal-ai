import { useEffect, useState } from 'react';
import { FOREX_INSTRUMENTS, OTC_INSTRUMENTS, SIGNAL_PERIODS_SEC, type SignalSettings } from '@open-signal/shared';
import { Badge, Button, Field, Input, Notice, Panel, Select, Switch, cx } from '@open-signal/ui';
import { useI18n } from '../i18n.tsx';
import { useMe } from '../session.tsx';
import { ApiError, api, errorText } from '../lib/api.ts';
import { Loading, PageTitle } from '../components/layout.tsx';

/** One signal system for every bot: instruments, trade durations, limits, access rule. */
export function SignalsAdminPage() {
  const { t, lang } = useI18n();
  const me = useMe();
  const [form, setForm] = useState<SignalSettings | null>(null);
  const [msg, setMsg] = useState<{ tone: 'success' | 'danger'; text: string } | null>(null);
  const [fields, setFields] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    api<{ settings: SignalSettings }>('GET', '/settings/signals').then((r) => setForm(r.settings), (e: unknown) => setMsg({ tone: 'danger', text: errorText(t, e) }));
  }, [t]);
  if (!form) return msg ? <Notice tone="danger">{msg.text}</Notice> : <Loading />;
  const owner = me.role === 'owner';
  const set = <K extends keyof SignalSettings>(k: K, v: SignalSettings[K]) => setForm({ ...form, [k]: v });
  const unit = (sec: number) => new Intl.NumberFormat(lang, { style: 'unit', unit: sec < 60 ? 'second' : 'minute', unitDisplay: 'short' }).format(sec < 60 ? sec : sec / 60);
  const save = async () => {
    setBusy(true);
    setMsg(null);
    try {
      const periods = [...form.periods].sort((a, b) => a - b);
      const r = await api<{ settings: SignalSettings }>('PUT', '/settings/signals', { ...form, periods, defaultPeriod: periods.includes(form.defaultPeriod) ? form.defaultPeriod : periods[0] });
      setForm(r.settings);
      setFields({});
      setMsg({ tone: 'success', text: t('admin.signals.saved') });
    } catch (e) {
      if (e instanceof ApiError) setFields(e.fields);
      setMsg({ tone: 'danger', text: errorText(t, e) });
    } finally {
      setBusy(false);
    }
  };
  const chips = (catalog: readonly { id: string; symbol: string }[], key: 'forexInstruments' | 'otcInstruments') => (
    <div className="mt-3 flex flex-wrap gap-2">
      {catalog.map((i) => {
        const on = form[key].includes(i.id);
        return (
          <button key={i.id} type="button" disabled={!owner} aria-pressed={on} onClick={() => set(key, on ? form[key].filter((x) => x !== i.id) : [...form[key], i.id])}
            className={cx('rounded-full border px-3 py-1.5 text-[13px] font-medium transition-colors', on ? 'border-transparent bg-fg text-bg' : 'border-line text-muted hover:text-fg')}>
            {i.symbol.replace(' OTC', '')}
          </button>
        );
      })}
    </div>
  );

  return (
    <div className="os-enter">
      <PageTitle title={t('admin.signals.title')} subtitle={t('admin.signals.subtitle')} />
      <div className="flex max-w-4xl flex-col gap-5">
        <Notice tone="warning">{t('admin.signals.engineNote')}</Notice>
        <Panel className="p-5 lg:p-6">
          <div className="flex items-center justify-between gap-3">
            <h2 className="text-[17px] font-semibold">Forex</h2>
            <Badge>{form.forexInstruments.length}/{FOREX_INSTRUMENTS.length}</Badge>
          </div>
          {chips(FOREX_INSTRUMENTS, 'forexInstruments')}
          <div className="mt-6 flex items-center justify-between gap-3">
            <h2 className="text-[17px] font-semibold">OTC</h2>
            <Badge>{form.otcInstruments.length}/{OTC_INSTRUMENTS.length}</Badge>
          </div>
          {chips(OTC_INSTRUMENTS, 'otcInstruments')}
          {fields['forexInstruments'] || fields['otcInstruments'] ? <p className="mt-2 text-[13px] text-danger">{fields['forexInstruments'] ?? fields['otcInstruments']}</p> : null}
        </Panel>
        <Panel className="p-5 lg:p-6">
          <h2 className="text-[17px] font-semibold">{t('admin.signals.periods')}</h2>
          <div className="mt-3 flex flex-wrap gap-2">
            {SIGNAL_PERIODS_SEC.map((p) => {
              const on = form.periods.includes(p);
              return (
                <button key={p} type="button" disabled={!owner} aria-pressed={on} onClick={() => set('periods', on ? form.periods.filter((x) => x !== p) : [...form.periods, p])}
                  className={cx('rounded-full border px-3 py-1.5 text-[13px] font-medium', on ? 'border-transparent bg-fg text-bg' : 'border-line text-muted hover:text-fg')}>
                  {unit(p)}
                </button>
              );
            })}
          </div>
          <div className="mt-6 grid gap-4 md:grid-cols-3">
            <Field label={t('admin.signals.defaultPeriod')} htmlFor="sg-dp" error={fields['defaultPeriod']}>
              <Select id="sg-dp" value={String(form.defaultPeriod)} onChange={(v) => set('defaultPeriod', Number(v))} options={[...form.periods].sort((a, b) => a - b).map((p) => ({ value: String(p), label: unit(p) }))} />
            </Field>
            <Field label={t('admin.signals.cooldown')} htmlFor="sg-cd" error={fields['cooldownSec']}>
              <Input id="sg-cd" type="number" disabled={!owner} value={String(form.cooldownSec)} onChange={(e) => set('cooldownSec', Number(e.target.value))} />
            </Field>
            <Field label={t('admin.signals.maxPerDay')} htmlFor="sg-max" error={fields['maxPerDay']}>
              <Input id="sg-max" type="number" disabled={!owner} value={String(form.maxPerDay)} onChange={(e) => set('maxPerDay', Number(e.target.value))} />
            </Field>
          </div>
          <label className="mt-6 flex items-start gap-3 text-[14px]">
            <Switch checked={form.requireFtd} disabled={!owner} onChange={(v) => set('requireFtd', v)} label={t('admin.signals.requireFtd')} />
            <span>
              <span className="block font-medium">{t('admin.signals.requireFtd')}</span>
              <span className="mt-0.5 block text-muted">{t('admin.signals.requireFtdHint')}</span>
            </span>
          </label>
        </Panel>
        {msg ? <Notice tone={msg.tone}>{msg.text}</Notice> : null}
        {owner ? (
          <div>
            <Button busy={busy} disabled={!form.periods.length} onClick={() => void save()}>{t('admin.editor.save')}</Button>
          </div>
        ) : null}
      </div>
    </div>
  );
}
