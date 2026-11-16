import { useEffect, useState } from 'react';
import { BarChart, Button, EmptyState, IconBot, IconPlus, Notice, Panel } from '@open-signal/ui';
import { useI18n } from '../i18n.tsx';
import { useMe } from '../session.tsx';
import { api, errorText } from '../lib/api.ts';
import type { Overview } from '../lib/types.ts';
import { Loading, PageTitle, navigate } from '../components/layout.tsx';
import { LOCALE, dayLabel, sum } from '../lib/format.ts';

export function DashboardPage() {
  const { t, lang } = useI18n();
  const me = useMe();
  const [data, setData] = useState<Overview | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api<Overview>('GET', '/overview').then(setData, (e: unknown) => setError(errorText(t, e)));
  }, [t]);

  if (error) return <Notice tone="danger">{error}</Notice>;
  if (!data) return <Loading />;

  const launches = sum(data.days, 'miniapp_launches');
  const starts = sum(data.days, 'tg_start');
  const newUsers = sum(data.days, 'users_new');
  const ix = data.storage.indexes;
  const fmt = new Intl.DateTimeFormat(LOCALE[lang], { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

  return (
    <div className="os-enter">
      <PageTitle title={t('admin.dashboard.title')} subtitle={me.email} />

      {data.bots.total === 0 ? (
        <Panel className="mb-8 p-6">
          <EmptyState icon={<IconBot />} title={t('admin.dashboard.noBots')} text={t('admin.dashboard.noBotsText')}>
            {me.role === 'owner' ? (
              <Button icon={<IconPlus size={18} />} onClick={() => navigate('/bots/new')}>
                {t('admin.bots.create')}
              </Button>
            ) : null}
          </EmptyState>
        </Panel>
      ) : null}

      <div className="grid grid-cols-2 gap-px overflow-hidden rounded-[24px] border border-line bg-[var(--os-line)] sm:grid-cols-3 xl:grid-cols-6">
        {[
          { label: t('admin.dashboard.bots'), value: data.bots.total },
          { label: t('admin.dashboard.activeBots'), value: data.bots.active },
          { label: t('admin.dashboard.users'), value: data.users },
          { label: t('admin.dashboard.newUsers7d'), value: newUsers },
          { label: t('admin.dashboard.launches7d'), value: launches },
          { label: t('admin.dashboard.starts7d'), value: starts },
        ].map((k) => (
          <div key={k.label} className="bg-card p-5">
            <div className="text-[13px] text-muted">{k.label}</div>
            <div className="os-display os-num mt-3 text-[40px]">{k.value}</div>
          </div>
        ))}
      </div>

      <div className="mt-6 grid gap-6 lg:grid-cols-[1.5fr_1fr]">
        <Panel className="p-5">
          <div className="mb-5 text-[15px] font-semibold">{t('admin.dashboard.chartTitle')}</div>
          <BarChart
            label={t('admin.dashboard.chartTitle')}
            points={data.days.map((d) => ({ label: dayLabel(d.day, lang), value: d.metrics['miniapp_launches'] ?? null }))}
          />
        </Panel>

        <div className="flex flex-col gap-4">
          <Panel className="p-5">
            <div className="text-[15px] font-semibold">{t('admin.dashboard.storage')}</div>
            <p className="mt-1 text-[14px] text-muted">{data.storage.driver === 'firestore' ? t('admin.dashboard.persistent') : t('admin.dashboard.local')}</p>
            {data.storage.driver === 'firestore' ? (
              <div className="mt-4 text-[14px]">
                <div className="font-medium">{t('admin.dashboard.indexes')}</div>
                {ix.error ? (
                  <p className="mt-1 text-danger">{t('admin.dashboard.indexesError', { error: ix.error })}</p>
                ) : ix.total !== undefined ? (
                  <>
                    <p className="mt-1 text-muted">{t('admin.dashboard.indexesReady', { ready: ix.ready ?? 0, total: ix.total })}</p>
                    {(ix.building ?? 0) > 0 ? <p className="mt-1 text-warning">{t('admin.dashboard.indexesBuilding', { n: ix.building ?? 0 })}</p> : null}
                  </>
                ) : (
                  <p className="mt-1 text-muted">{t('admin.dashboard.indexesPending')}</p>
                )}
              </div>
            ) : null}
          </Panel>
          {data.telegramIssues.length ? (
            <Notice tone="warning">
              <div className="font-semibold">{t('admin.dashboard.telegramIssues')}</div>
              {data.telegramIssues.map((b) => (
                <a key={b.botId} href={`#/bots/${b.botId}/danger`} className="mt-1 block underline-offset-2 hover:underline">
                  {b.botId}: {b.issues[0]}
                </a>
              ))}
            </Notice>
          ) : null}
          {data.errorGroups > 0 ? <Notice tone="danger">{t('admin.dashboard.errorsNote', { n: data.errorGroups })}</Notice> : null}
        </div>
      </div>

      {me.role === 'owner' ? (
        <Panel className="mt-6 p-5">
          <div className="mb-2 text-[15px] font-semibold">{t('admin.dashboard.events')}</div>
          {data.recentEvents.length ? (
            <ul className="os-rows">
              {data.recentEvents.map((e) => (
                <li key={e.id} className="flex items-center justify-between gap-4 py-2.5 text-[14px]">
                  <span className="min-w-0 truncate">
                    {t(`admin.action.${e.action}`) === `admin.action.${e.action}` ? e.action : t(`admin.action.${e.action}`)}
                    {e.botId ? <span className="text-muted"> — {e.botId}</span> : null}
                  </span>
                  <span className="os-num shrink-0 text-[13px] text-muted">{fmt.format(new Date(e.at))}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-[14px] text-muted">{t('admin.dashboard.noEvents')}</p>
          )}
        </Panel>
      ) : null}
    </div>
  );
}
