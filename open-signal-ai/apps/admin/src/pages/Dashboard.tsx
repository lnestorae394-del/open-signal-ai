import { useEffect, useState } from 'react';
import { Badge, Card, EmptyState, IconLogs, SectionTitle } from '@open-signal/ui';
import { useI18n } from '../i18n.tsx';
import { PageTitle } from '../components/layout.tsx';
import { fetchHealth, type Health } from '../lib/api.ts';

const METRICS = ['bots', 'users', 'activeUsers', 'launches', 'errors'] as const;

export function DashboardPage() {
  const { t } = useI18n();
  const [health, setHealth] = useState<Health | null | 'loading'>('loading');

  useEffect(() => {
    void fetchHealth().then(setHealth);
  }, []);

  return (
    <div className="os-rise">
      <PageTitle title={t('admin.nav.dashboard')} />

      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5">
        {METRICS.map((m) => (
          <Card key={m} className="min-h-[112px]">
            <div className="text-xs font-medium text-muted">{t(`admin.dashboard.${m}`)}</div>
            {/* No numbers until real storage-backed statistics exist (Stage 2). */}
            <div className="mt-3 text-3xl font-bold tracking-tight text-muted/40">—</div>
            <div className="mt-1 text-[11px] text-muted/80">{t('admin.dashboard.noData')}</div>
          </Card>
        ))}
      </div>

      <div className="mt-6 grid gap-4 lg:grid-cols-[1.4fr_1fr]">
        <Card>
          <SectionTitle>{t('admin.dashboard.events')}</SectionTitle>
          <EmptyState icon={<IconLogs />} text={t('admin.dashboard.noData')} />
        </Card>
        <Card hero>
          <SectionTitle>API · /health</SectionTitle>
          {health === 'loading' ? (
            <div className="os-skeleton h-24 rounded-xl" />
          ) : health === null ? (
            <Badge tone="danger" dot>{t('errors.network')}</Badge>
          ) : (
            <ul className="flex flex-col gap-2.5 text-sm">
              <StatusRow label="API" ok={health.status === 'ok'} value={health.status} />
              <StatusRow label="Storage" ok value={health.storage} />
              <StatusRow label="Firebase" ok={health.firebaseConnected} value={health.firebaseConnected ? 'connected' : t('common.notConnected')} />
              <StatusRow label="Telegram" ok={health.telegramConnected} value={health.telegramConnected ? 'connected' : t('common.notConnected')} />
              <StatusRow label="Market data" ok={health.marketDataConnected} value={health.marketDataConnected ? 'connected' : t('common.notConnected')} />
            </ul>
          )}
        </Card>
      </div>
    </div>
  );
}

function StatusRow({ label, ok, value }: { label: string; ok: boolean; value: string }) {
  return (
    <li className="flex items-center justify-between gap-3">
      <span className="text-muted">{label}</span>
      <Badge tone={ok ? 'success' : 'neutral'} dot>{value}</Badge>
    </li>
  );
}
