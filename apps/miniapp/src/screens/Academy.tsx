import { useEffect, useMemo, useState } from 'react';
import { parseLessonText, videoEmbed } from '@open-signal/shared';
import { Button, IconCheck, IconChevron, IconFile, IconPlay, Spinner, cx } from '@open-signal/ui';
import type { Lang } from '@open-signal/i18n';
import { Header } from '../components/chrome.tsx';
import { ApiError, api, errorKey, type Catalog, type Lesson, type Localized } from '../lib/api.ts';
import { getWebApp, haptic, openExternal } from '../lib/telegram.ts';
import { useApp } from '../state.tsx';

/** Text in the interface language; another language only if this one was not written. */
export const pick = (v: Localized, lang: Lang) => v[lang]?.trim() || v.en?.trim() || v.ru?.trim() || v.uk?.trim() || '';

export function AcademyScreen() {
  const { t, lang, botId, token, refreshMe } = useApp();
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [progress, setProgress] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);

  useEffect(() => {
    if (!botId || !token) return;
    api.academy(botId, token).then(
      (r) => (setCatalog(r.catalog), setProgress(r.progress)),
      (e: unknown) => setError(t(errorKey(e instanceof ApiError ? e.code : 'NETWORK'))),
    );
  }, [botId, token, t]);

  const order = useMemo(() => catalog?.categories.flatMap((c) => c.lessons.map((l) => l.id)) ?? [], [catalog]);
  const total = order.length;
  const done = order.filter((id) => progress[id]).length;

  // Telegram BackButton inside a lesson returns to the catalogue.
  useEffect(() => {
    const bb = getWebApp()?.BackButton;
    if (!bb || !openId) return;
    const back = () => setOpenId(null);
    bb.show();
    bb.onClick(back);
    return () => bb.offClick(back);
  }, [openId]);

  if (openId && catalog) {
    const idx = order.indexOf(openId);
    return (
      <LessonView
        id={openId}
        done={Boolean(progress[openId])}
        nextId={order[idx + 1] ?? null}
        onBack={() => setOpenId(null)}
        onNext={(id) => setOpenId(id)}
        onProgress={(p) => {
          setProgress(p);
          void refreshMe();
        }}
      />
    );
  }

  return (
    <div>
      <Header title={t('nav.academy')} />
      <section className="os-enter px-5 pb-6 pt-4">
        <div className="flex items-end justify-between gap-4">
          <h1 className="os-display os-num text-[60px] leading-none">
            {done}
            <span className="text-muted/50">/{total}</span>
          </h1>
          <p className="max-w-[55%] pb-1 text-right text-[13px] text-muted">{t('academy.progress', { done, total })}</p>
        </div>
        <div className="mt-4 h-1.5 overflow-hidden rounded-full bg-white/[0.08]" aria-hidden>
          <div className="h-full rounded-full bg-primary transition-[width] duration-700" style={{ width: `${total ? (done / total) * 100 : 0}%` }} />
        </div>
      </section>

      <div className="flex flex-col gap-6 px-4 pb-4">
        {error ? <p className="px-1 text-[14px] text-danger">{error}</p> : null}
        {!catalog && !error ? <div className="grid h-40 place-items-center"><Spinner /></div> : null}
        {catalog && total === 0 ? <p className="px-1 text-[14px] text-muted">{t('academy.empty')}</p> : null}
        {catalog?.categories.map((c) =>
          c.lessons.length ? (
            <section key={c.id} aria-labelledby={`cat-${c.id}`}>
              <h2 id={`cat-${c.id}`} className="mb-2 flex items-center justify-between px-1 text-[13px] text-muted">
                <span>{pick(c.title, lang)}</span>
                <span className="os-num">{c.lessons.filter((l) => progress[l.id]).length}/{c.lessons.length}</span>
              </h2>
              <ol className="os-panel os-rows overflow-hidden">
                {c.lessons.map((l) => {
                  const isDone = Boolean(progress[l.id]);
                  return (
                    <li key={l.id}>
                      <button type="button" onClick={() => (haptic(), setOpenId(l.id))} className="flex w-full items-center gap-3 px-4 py-3.5 text-left active:bg-white/[0.04]">
                        <span className={cx('grid h-8 w-8 shrink-0 place-items-center rounded-full text-[12px] font-semibold', isDone ? 'bg-success/15 text-success' : 'bg-white/[0.07] text-muted')}>
                          {isDone ? <IconCheck size={16} /> : <span className="os-num">{order.indexOf(l.id) + 1}</span>}
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="block text-[15px] font-medium leading-snug">{pick(l.title, lang)}</span>
                          <span className="mt-0.5 flex items-center gap-2 text-[12px] text-muted">
                            {l.durationMin ? <span>{t('academy.minutes', { n: l.durationMin })}</span> : null}
                            {l.hasVideo ? <span className="inline-flex items-center gap-1"><IconPlay size={12} />{t('academy.video')}</span> : null}
                            {l.hasPdf ? <span className="inline-flex items-center gap-1"><IconFile size={12} />PDF</span> : null}
                          </span>
                        </span>
                        <IconChevron size={18} className="shrink-0 text-muted" />
                      </button>
                    </li>
                  );
                })}
              </ol>
            </section>
          ) : null,
        )}
      </div>
    </div>
  );
}

function LessonBody({ text }: { text: string }) {
  return (
    <div className="flex flex-col gap-4">
      {parseLessonText(text).map((b, i) =>
        b.kind === 'h' ? (
          <h2 key={i} className="pt-2 text-[19px] font-semibold tracking-[-0.01em]">{b.text}</h2>
        ) : (
          <p key={i} className="whitespace-pre-line text-[16px] leading-[1.65] text-fg/85">{b.text}</p>
        ),
      )}
    </div>
  );
}

function LessonView({ id, done, nextId, onBack, onNext, onProgress }: { id: string; done: boolean; nextId: string | null; onBack: () => void; onNext: (id: string) => void; onProgress: (p: Record<string, string>) => void }) {
  const { t, lang, botId, token } = useApp();
  const [lesson, setLesson] = useState<Lesson | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setLesson(null);
    window.scrollTo({ top: 0 });
    if (!botId || !token) return;
    api.lesson(botId, token, id).then(
      (r) => setLesson(r.lesson),
      (e: unknown) => setError(t(errorKey(e instanceof ApiError ? e.code : 'NETWORK'))),
    );
  }, [botId, token, id, t]);

  const toggle = async () => {
    if (!botId || !token) return;
    setBusy(true);
    try {
      onProgress((await api.setLessonDone(botId, token, id, !done)).progress);
      haptic('success');
    } catch (e) {
      setError(t(errorKey(e instanceof ApiError ? e.code : 'NETWORK')));
    } finally {
      setBusy(false);
    }
  };

  const video = lesson?.videoUrl ? videoEmbed(lesson.videoUrl) : null;
  return (
    <div className="os-enter">
      <div className="px-4 pt-4">
        <button type="button" onClick={onBack} className="inline-flex h-9 items-center gap-1 rounded-full bg-white/[0.07] px-3 text-[13px] font-medium text-fg/85">
          <IconChevron size={16} className="rotate-180" /> {t('academy.back')}
        </button>
      </div>
      {error ? <p className="px-5 pt-6 text-[14px] text-danger">{error}</p> : !lesson ? (
        <div className="grid h-64 place-items-center"><Spinner /></div>
      ) : (
        <article className="px-5 pb-6 pt-5">
          <h1 className="os-display text-[32px] leading-[1.08]">{pick(lesson.title, lang)}</h1>
          {pick(lesson.summary, lang) ? <p className="mt-3 text-[15px] leading-relaxed text-muted">{pick(lesson.summary, lang)}</p> : null}
          {video ? (
            <div className="mt-6 overflow-hidden rounded-2xl border border-line bg-black">
              {video.kind === 'iframe' ? (
                <div className="relative w-full pt-[56.25%]">
                  <iframe
                    src={video.src}
                    title={pick(lesson.title, lang)}
                    className="absolute inset-0 h-full w-full"
                    allow="accelerometer; encrypted-media; gyroscope; picture-in-picture; fullscreen"
                    allowFullScreen
                    loading="lazy"
                    referrerPolicy="strict-origin-when-cross-origin"
                  />
                </div>
              ) : (
                <video src={video.src} controls playsInline preload="metadata" className="block w-full" />
              )}
            </div>
          ) : null}
          <div className="mt-6">
            <LessonBody text={pick(lesson.body, lang)} />
          </div>
          {lesson.pdfUrl ? (
            <button type="button" onClick={() => openExternal(lesson.pdfUrl!)} className="os-panel mt-6 flex w-full items-center gap-3 px-4 py-4 text-left">
              <span className="grid h-10 w-10 place-items-center rounded-xl bg-primary/15 text-primary"><IconFile size={20} /></span>
              <span className="flex-1 text-[15px] font-medium">{t('academy.pdf')}</span>
              <IconChevron size={18} className="text-muted" />
            </button>
          ) : null}
          <div className="mt-8 flex flex-col gap-3">
            <Button size="lg" block variant={done ? 'secondary' : 'primary'} busy={busy} onClick={() => void toggle()}>
              {done ? t('academy.markUndone') : t('academy.markDone')}
            </Button>
            {nextId ? <Button variant="ghost" block onClick={() => onNext(nextId)}>{t('academy.next')}</Button> : null}
          </div>
        </article>
      )}
    </div>
  );
}
