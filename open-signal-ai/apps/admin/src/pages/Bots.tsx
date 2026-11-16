import { Button, Card, EmptyState, IconBot, IconPlus } from '@open-signal/ui';
import { useI18n } from '../i18n.tsx';
import { PageTitle, navigate } from '../components/layout.tsx';

export function BotsPage() {
  const { t } = useI18n();
  return (
    <div className="os-rise">
      <PageTitle
        title={t('admin.nav.bots')}
        action={
          <Button icon={<IconPlus size={18} />} onClick={() => navigate('bots/new')}>
            {t('admin.bots.create')}
          </Button>
        }
      />
      <Card>
        {/* The list is loaded from the admin API in Stage 2; nothing is faked here. */}
        <EmptyState icon={<IconBot />} text={t('admin.bots.empty')} />
      </Card>
    </div>
  );
}
