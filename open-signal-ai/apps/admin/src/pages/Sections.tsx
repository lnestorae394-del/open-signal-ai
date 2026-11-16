import { MANAGER_PERMISSIONS } from '@open-signal/shared';
import { Badge, Card, EmptyState, IconLogs, IconShield, IconUsers, SectionTitle } from '@open-signal/ui';
import { useI18n } from '../i18n.tsx';
import { PageTitle } from '../components/layout.tsx';

const LESSONS = ['l1', 'l2', 'l3', 'l4', 'l5', 'l6', 'l7', 'l8', 'l9', 'l10'];

export function AcademyPage() {
  const { t } = useI18n();
  return (
    <div className="os-rise">
      <PageTitle title={t('admin.nav.academy')} subtitle={t('common.stageNote', { stage: 5 })} />
      <Card>
        <p className="mb-4 text-sm leading-relaxed text-muted">{t('admin.academyPage.text')}</p>
        <ol className="grid gap-2 sm:grid-cols-2">
          {LESSONS.map((l, i) => (
            <li key={l} className="flex items-center gap-3 rounded-xl border border-line bg-white/[0.02] px-3.5 py-3">
              <span className="font-mono text-xs text-muted">{String(i + 1).padStart(2, '0')}</span>
              <span className="text-sm font-medium">{t(`academy.lessons.${l}`)}</span>
              <span className="ml-auto flex gap-1">
                {['RU', 'UK', 'EN'].map((x) => (
                  <Badge key={x}>{x}</Badge>
                ))}
              </span>
            </li>
          ))}
        </ol>
      </Card>
    </div>
  );
}

export function UsersPage() {
  const { t } = useI18n();
  return (
    <div className="os-rise">
      <PageTitle title={t('admin.nav.users')} subtitle={t('common.stageNote', { stage: 2 })} />
      <Card>
        <EmptyState icon={<IconUsers />} text={t('admin.usersPage.text')} />
      </Card>
    </div>
  );
}

export function LogsPage() {
  const { t } = useI18n();
  return (
    <div className="os-rise">
      <PageTitle title={t('admin.nav.logs')} subtitle={t('common.stageNote', { stage: 2 })} />
      <div className="grid gap-4 md:grid-cols-3">
        {(['errors', 'audit', 'activity'] as const).map((k) => (
          <Card key={k}>
            <SectionTitle>{t(`admin.logsPage.${k}`)}</SectionTitle>
            <EmptyState icon={<IconLogs />} text={t('admin.dashboard.noData')} />
          </Card>
        ))}
      </div>
      <p className="mt-4 text-sm text-muted">{t('admin.logsPage.text')}</p>
    </div>
  );
}

export function ManagersPage() {
  const { t } = useI18n();
  return (
    <div className="os-rise">
      <PageTitle title={t('admin.nav.managers')} subtitle={t('common.stageNote', { stage: 2 })} />
      <div className="grid gap-4 lg:grid-cols-2">
        <Card hero>
          <div className="flex items-start gap-3">
            <IconShield className="mt-0.5 shrink-0 text-primary" />
            <p className="text-sm leading-relaxed text-muted">{t('admin.managersPage.text')}</p>
          </div>
        </Card>
        <Card>
          <SectionTitle>{t('admin.managersPage.permissions')}</SectionTitle>
          <ul className="flex flex-col gap-2">
            {MANAGER_PERMISSIONS.map((p) => (
              <li key={p} className="flex items-center justify-between gap-3 rounded-lg border border-line px-3 py-2 text-sm">
                <span>{t(`admin.permissions.${p}`)}</span>
                <code className="font-mono text-[11px] text-muted">{p}</code>
              </li>
            ))}
          </ul>
        </Card>
      </div>
    </div>
  );
}
