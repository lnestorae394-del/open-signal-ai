import { useState } from 'react';
import { Card, EmptyState, IconAcademy, IconChevron, IconHistory, cx } from '@open-signal/ui';
import { Header } from '../components/chrome.tsx';
import { useApp } from '../state.tsx';

export function HistoryScreen() {
  const { t } = useApp();
  return (
    <div className="os-rise">
      <Header title={t('history.title')} subtitle={t('history.subtitle')} />
      <div className="px-4">
        <Card>
          <EmptyState icon={<IconHistory />} text={t('history.empty')} />
        </Card>
      </div>
    </div>
  );
}

/** Template structure of the 10 Smart Money lessons. Content is edited in the admin Academy editor (Stage 5). */
const LESSONS = ['l1', 'l2', 'l3', 'l4', 'l5', 'l6', 'l7', 'l8', 'l9', 'l10'] as const;

export function AcademyScreen() {
  const { t } = useApp();
  const [open, setOpen] = useState<string | null>(null);
  const done = 0; // real progress comes from academy_progress (Stage 5); nothing is invented here

  return (
    <div className="os-rise">
      <Header title={t('academy.title')} subtitle={t('academy.subtitle')} />
      <div className="flex flex-col gap-4 px-4">
        <Card hero>
          <div className="flex items-center justify-between">
            <span className="text-sm font-semibold">{t('academy.progress', { done, total: LESSONS.length })}</span>
            <IconAcademy className="text-primary" />
          </div>
          <div className="mt-3 h-2 overflow-hidden rounded-full bg-white/[0.07]">
            <div className="os-btn-primary h-full rounded-full" style={{ width: `${(done / LESSONS.length) * 100}%` }} />
          </div>
        </Card>

        <ol className="flex flex-col gap-2.5">
          {LESSONS.map((id, idx) => {
            const isOpen = open === id;
            return (
              <li key={id} className="os-card overflow-hidden">
                <button
                  type="button"
                  onClick={() => setOpen(isOpen ? null : id)}
                  aria-expanded={isOpen}
                  className="flex w-full items-center gap-3.5 px-4 py-3.5 text-left"
                >
                  <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl border border-line bg-white/[0.03] text-xs font-extrabold text-muted">
                    {String(idx + 1).padStart(2, '0')}
                  </span>
                  <span className="flex-1 text-[15px] font-semibold tracking-tight">{t(`academy.lessons.${id}`)}</span>
                  <IconChevron size={18} className={cx('text-muted transition-transform duration-300', isOpen && 'rotate-90')} />
                </button>
                {isOpen ? (
                  <div className="border-t border-line px-4 py-3.5 text-[13px] leading-relaxed text-muted">{t('academy.contentPending')}</div>
                ) : null}
              </li>
            );
          })}
        </ol>
      </div>
    </div>
  );
}
