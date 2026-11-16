import { useEffect, useMemo, useState } from 'react';
import { EmptyState, IconSearch, IconStar, Segmented, Spinner, cx } from '@open-signal/ui';
import { Header } from '../components/chrome.tsx';
import { MarketSwitch, PairDots, SimulatedStrip, fmtPct, fmtPrice, symbolOf } from '../components/market.tsx';
import { ApiError, api, errorKey, type Overview } from '../lib/api.ts';
import { haptic } from '../lib/telegram.ts';
import { useApp } from '../state.tsx';

export function PairsScreen() {
  const { t, config, favorites, toggleFavorite, guest, marketMode: mode, botId, token, selectInstrument, setTab } = useApp();
  const [view, setView] = useState<'all' | 'favorites'>('all');
  const [q, setQ] = useState('');
  const [data, setData] = useState<Overview | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!botId || !token) return;
    let alive = true;
    const load = () =>
      api.overview(botId, token, mode).then(
        (r) => alive && (setData(r), setError(null)),
        (e: unknown) => alive && setError(t(errorKey(e instanceof ApiError ? e.code : 'NETWORK'))),
      );
    setData(null);
    void load();
    const id = setInterval(() => void load(), 10_000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [botId, token, mode, t]);

  const ids = config?.markets[mode].instruments ?? [];
  const list = useMemo(() => {
    const base = view === 'favorites' ? ids.filter((id) => favorites.includes(id)) : ids;
    const needle = q.trim().toUpperCase().replace(/[\s/]/g, '');
    return needle ? base.filter((id) => id.includes(needle)) : base;
  }, [ids, view, q, favorites]);
  const quoteOf = (id: string) => data?.quotes.find((x) => x.instrumentId === id);
  const favCount = ids.filter((id) => favorites.includes(id)).length;

  return (
    <div>
      <Header title={t('pairs.title')} />
      <div className="flex flex-col gap-3 px-4 pt-2">
        <MarketSwitch />
        <SimulatedStrip compact />
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
          value={view}
          onChange={setView}
          options={[
            { value: 'all', label: `${t('pairs.all')} ${ids.length}` },
            { value: 'favorites', label: `${t('pairs.favorites')} ${favCount}` },
          ]}
        />
        {mode === 'otc' ? <p className="px-1 text-[12px] leading-relaxed text-muted">{t('pairs.otcNote')}</p> : null}
        {error ? <p className="px-1 text-[13px] text-danger">{error}</p> : null}

        {guest ? (
          <EmptyState icon={<IconStar />} text={t('profile.guestText')} />
        ) : list.length ? (
          <ul className="os-panel os-rows overflow-hidden">
            {list.map((id) => {
              const fav = favorites.includes(id);
              const quote = quoteOf(id);
              return (
                <li key={id} className="flex items-center gap-1 pr-2">
                  <button
                    type="button"
                    className="flex min-w-0 flex-1 items-center gap-3 px-4 py-3 text-left"
                    onClick={() => {
                      haptic();
                      selectInstrument(mode, id);
                      setTab('signals');
                    }}
                  >
                    <PairDots id={id} />
                    <span className="min-w-0 flex-1">
                      <span className="block text-[16px] font-semibold tracking-[-0.01em]">{symbolOf(id)}</span>
                      <span className="block text-[12px] text-muted">{mode === 'otc' ? 'OTC' : 'Forex'}</span>
                    </span>
                    <span className="text-right">
                      {quote ? (
                        <>
                          <span className="os-num block text-[15px] font-semibold">{fmtPrice(quote.price, quote.decimals)}</span>
                          <span className={cx('os-num block text-[12px] font-semibold', quote.changePct >= 0 ? 'text-success' : 'text-primary')}>{fmtPct(quote.changePct)}</span>
                        </>
                      ) : data ? null : (
                        <Spinner className="h-4 w-4" />
                      )}
                    </span>
                  </button>
                  <button
                    type="button"
                    onClick={() => toggleFavorite(id)}
                    aria-pressed={fav}
                    aria-label={t(fav ? 'pairs.removeFavorite' : 'pairs.addFavorite', { symbol: symbolOf(id) })}
                    className={cx('grid h-10 w-10 shrink-0 place-items-center rounded-full transition-colors', fav ? 'text-accent' : 'text-muted hover:text-fg')}
                  >
                    <IconStar size={20} filled={fav} />
                  </button>
                </li>
              );
            })}
          </ul>
        ) : (
          <EmptyState icon={<IconStar />} text={view === 'favorites' && !q ? t('pairs.favoritesEmpty') : t('pairs.nothingFound')} />
        )}
      </div>
    </div>
  );
}
