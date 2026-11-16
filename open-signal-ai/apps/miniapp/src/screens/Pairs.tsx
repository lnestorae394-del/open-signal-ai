import { useMemo, useState } from 'react';
import { FOREX_INSTRUMENTS, OTC_INSTRUMENTS, forexSessionState, type Instrument } from '@open-signal/shared';
import { DataStatusBadge, EmptyState, IconSearch, IconStar, Notice, Segmented, cx } from '@open-signal/ui';
import { Header } from '../components/chrome.tsx';
import { useApp } from '../state.tsx';

type Category = 'forex' | 'otc' | 'favorites';

function Count({ n, active }: { n: number; active?: boolean }) {
  return <span className={cx('os-num rounded-full px-1.5 text-[11px]', active ? 'bg-bg/15' : 'bg-white/[0.08]')}>{n}</span>;
}

export function PairsScreen() {
  const { t, favorites, toggleFavorite, guest } = useApp();
  const [category, setCategory] = useState<Category>('forex');
  const [q, setQ] = useState('');
  const marketOpen = forexSessionState().open;

  const list = useMemo(() => {
    const base: readonly Instrument[] =
      category === 'forex' ? FOREX_INSTRUMENTS : category === 'otc' ? OTC_INSTRUMENTS : [...FOREX_INSTRUMENTS, ...OTC_INSTRUMENTS].filter((i) => favorites.includes(i.id));
    const needle = q.trim().toUpperCase().replace(/[\s/]/g, '');
    return needle ? base.filter((i) => i.id.includes(needle)) : base;
  }, [category, q, favorites]);

  return (
    <div>
      <Header title={t('pairs.title')} />
      <div className="flex flex-col gap-3 px-4 pt-3">
        <label className="relative block">
          <span className="sr-only">{t('common.search')}</span>
          <IconSearch size={18} className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-muted" />
          <input
            type="search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={t('pairs.searchPlaceholder')}
            className="h-12 w-full rounded-2xl bg-white/[0.06] pl-11 pr-4 text-[15px] text-fg outline-none placeholder:text-muted/70 focus:bg-white/[0.09]"
          />
        </label>

        <Segmented
          block
          ariaLabel={t('pairs.title')}
          value={category}
          onChange={setCategory}
          options={[
            { value: 'forex', label: <>{t('pairs.forex')} <Count n={FOREX_INSTRUMENTS.length} active={category === 'forex'} /></> },
            { value: 'otc', label: <>{t('pairs.otc')} <Count n={OTC_INSTRUMENTS.length} active={category === 'otc'} /></> },
            { value: 'favorites', label: <>{t('pairs.favorites')} <Count n={favorites.length} active={category === 'favorites'} /></> },
          ]}
        />

        {category === 'otc' ? <Notice tone="danger">{t('pairs.otcNote')}</Notice> : null}
        {category === 'favorites' && guest ? <p className="px-1 text-[12px] text-muted">{t('pairs.favoritesLocal')}</p> : null}

        {list.length ? (
          <ul className="os-panel os-rows overflow-hidden">
            {list.map((i) => {
              const fav = favorites.includes(i.id);
              const status = i.market === 'otc' ? 'NO_VERIFIED_SOURCE' : marketOpen ? 'UNAVAILABLE' : 'MARKET_CLOSED';
              return (
                <li key={i.id} className="flex items-center gap-3 px-4 py-3">
                  <div className="relative h-8 w-[52px] shrink-0" aria-hidden>
                    <span className="absolute left-0 top-0 grid h-8 w-8 place-items-center pr-2.5 rounded-full bg-white/[0.08] text-[9.5px] font-semibold tracking-tight">{i.base}</span>
                    <span className="absolute left-5 top-0 grid h-8 w-8 place-items-center rounded-full border-2 border-card bg-white/[0.14] text-[9.5px] font-semibold tracking-tight">{i.quote}</span>
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-baseline gap-2">
                      <span className="text-[16px] font-semibold tracking-[-0.01em]">{i.symbol.replace(' OTC', '')}</span>
                      {i.market === 'otc' ? <span className="text-[11px] font-semibold text-warning">OTC</span> : null}
                    </div>
                    <div className="mt-1">
                      <DataStatusBadge status={status} label={status === 'UNAVAILABLE' ? t('pairs.noPrice') : t(`status.${status}`)} />
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => toggleFavorite(i.id)}
                    aria-pressed={fav}
                    aria-label={t(fav ? 'pairs.removeFavorite' : 'pairs.addFavorite', { symbol: i.symbol })}
                    className={cx('grid h-10 w-10 place-items-center rounded-full transition-colors', fav ? 'text-accent' : 'text-muted hover:text-fg')}
                  >
                    <IconStar size={20} filled={fav} />
                  </button>
                </li>
              );
            })}
          </ul>
        ) : (
          <EmptyState icon={<IconStar />} text={category === 'favorites' && !q ? t('pairs.favoritesEmpty') : t('pairs.nothingFound')} />
        )}
      </div>
    </div>
  );
}
