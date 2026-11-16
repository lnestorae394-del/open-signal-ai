import { useMemo, useState } from 'react';
import { FOREX_INSTRUMENTS, OTC_INSTRUMENTS, forexSessionState, type Instrument } from '@open-signal/shared';
import { Badge, DataStatusBadge, EmptyState, IconSearch, IconStar, Notice, Segmented, cx } from '@open-signal/ui';
import { Header } from '../components/chrome.tsx';
import { useApp } from '../state.tsx';

type Category = 'forex' | 'otc' | 'favorites';

export function PairsScreen() {
  const { t, favorites, toggleFavorite, guest } = useApp();
  const [category, setCategory] = useState<Category>('forex');
  const [q, setQ] = useState('');
  const marketOpen = forexSessionState().open;

  const list = useMemo(() => {
    const base: readonly Instrument[] =
      category === 'forex'
        ? FOREX_INSTRUMENTS
        : category === 'otc'
          ? OTC_INSTRUMENTS
          : [...FOREX_INSTRUMENTS, ...OTC_INSTRUMENTS].filter((i) => favorites.includes(i.id));
    const needle = q.trim().toUpperCase().replace(/[\s/]/g, '');
    return needle ? base.filter((i) => i.id.includes(needle) || i.symbol.replace('/', '').toUpperCase().includes(needle)) : base;
  }, [category, q, favorites]);

  return (
    <div className="os-rise">
      <Header title={t('pairs.title')} />
      <div className="flex flex-col gap-3 px-4">
        <div className="relative">
          <IconSearch size={18} className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-muted" />
          <input
            type="search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={t('pairs.searchPlaceholder')}
            aria-label={t('common.search')}
            className="h-12 w-full rounded-2xl border border-line-strong bg-white/[0.035] pl-10 pr-4 text-sm text-fg outline-none placeholder:text-muted/60 focus:border-primary/60"
          />
        </div>

        <Segmented
          block
          ariaLabel="Category"
          value={category}
          onChange={setCategory}
          options={[
            { value: 'forex', label: `${t('pairs.forex')} · ${FOREX_INSTRUMENTS.length}` },
            { value: 'otc', label: `${t('pairs.otc')} · ${OTC_INSTRUMENTS.length}` },
            { value: 'favorites', label: `${t('pairs.favorites')} · ${favorites.length}` },
          ]}
        />

        {category === 'otc' ? <Notice tone="danger">{t('pairs.otcNote')}</Notice> : null}
        {category === 'favorites' && guest ? <p className="px-1 text-[11px] text-muted">{t('pairs.favoritesLocal')}</p> : null}

        <ul className="os-card divide-y divide-[var(--os-line)] overflow-hidden p-0">
          {list.map((i) => {
            const fav = favorites.includes(i.id);
            const status = i.market === 'otc' ? 'NO_VERIFIED_SOURCE' : marketOpen ? 'UNAVAILABLE' : 'MARKET_CLOSED';
            return (
              <li key={i.id} className="flex items-center gap-3 px-4 py-3.5">
                <div className="grid h-10 w-10 shrink-0 place-items-center rounded-xl border border-line bg-white/[0.03] text-[10px] font-extrabold tracking-wide text-muted">
                  {i.base}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="font-semibold tracking-tight">{i.symbol}</span>
                    {i.market === 'otc' ? <Badge tone="warning">OTC</Badge> : null}
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
                  className={cx('grid h-10 w-10 place-items-center rounded-full transition-colors', fav ? 'text-primary' : 'text-muted hover:text-fg')}
                >
                  <IconStar size={20} filled={fav} />
                </button>
              </li>
            );
          })}
        </ul>
        {list.length === 0 ? (
          <EmptyState icon={<IconStar />} text={category === 'favorites' && !q ? t('pairs.favoritesEmpty') : t('pairs.nothingFound')} />
        ) : null}
      </div>
    </div>
  );
}
