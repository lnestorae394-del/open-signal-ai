import { useState } from 'react';
import { EmptyState, IconChevron, IconHistory, Panel, cx } from '@open-signal/ui';
import { Header } from '../components/chrome.tsx';
import { useApp } from '../state.tsx';

export function HistoryScreen() {
  const { t, setTab } = useApp();
  return (
    <div>
      <Header title={t('history.title')} subtitle={t('history.subtitle')} />
      <div className="px-4 pt-3">
        <Panel>
          <EmptyState icon={<IconHistory />} text={t('history.empty')}>
            <button type="button" onClick={() => setTab('pairs')} className="text-[14px] font-semibold text-primary">
              {t('signals.selectPair')}
            </button>
          </EmptyState>
        </Panel>
      </div>
    </div>
  );
}

/** The ten Smart Money lessons are a real sequence, so they are numbered. */
const LESSONS = ['l1', 'l2', 'l3', 'l4', 'l5', 'l6', 'l7', 'l8', 'l9', 'l10'] as const;

export function AcademyScreen() {
  const { t } = useApp();
  const [open, setOpen] = useState<string | null>(null);
  const done = 0; // real progress comes from academy_progress once lessons are published

  return (
    <div>
      <Header title={t('academy.title')} subtitle={t('academy.subtitle')} />
      <section className="os-enter px-5 pb-6 pt-5">
        <div className="flex items-end justify-between gap-4">
          <h1 className="os-display os-num text-[64px]">
            {done}
            <span className="text-muted/50">/{LESSONS.length}</span>
          </h1>
          <p className="max-w-[55%] pb-2 text-right text-[13px] text-muted">{t('academy.progress', { done, total: LESSONS.length })}</p>
        </div>
        <div className="mt-4 grid grid-cols-10 gap-1" aria-hidden>
          {LESSONS.map((id, i) => (
            <span key={id} className={cx('h-1.5 rounded-full', i < done ? 'bg-primary' : 'bg-white/[0.1]')} />
          ))}
        </div>
      </section>

      <div className="px-4">
        <div className="mb-2 px-1 text-[13px] text-muted">{t('academy.lessonsTitle')}</div>
        <ol className="os-panel os-rows overflow-hidden">
          {LESSONS.map((id, idx) => {
            const isOpen = open === id;
            return (
              <li key={id}>
                <button type="button" onClick={() => setOpen(isOpen ? null : id)} aria-expanded={isOpen} className="flex w-full items-center gap-4 px-4 py-3.5 text-left">
                  <span className="os-num w-6 shrink-0 text-[13px] font-semibold text-muted">{idx + 1}</span>
                  <span className="flex-1 text-[15px] font-medium">{t(`academy.lessons.${id}`)}</span>
                  <IconChevron size={18} className={cx('text-muted transition-transform duration-300', isOpen && 'rotate-90')} />
                </button>
                {isOpen ? <p className="px-4 pb-4 pl-14 text-[14px] leading-relaxed text-muted">{t('academy.contentPending')}</p> : null}
              </li>
            );
          })}
        </ol>
      </div>
    </div>
  );
}
