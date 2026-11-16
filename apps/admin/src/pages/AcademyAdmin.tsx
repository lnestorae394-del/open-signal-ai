import { useCallback, useEffect, useState } from 'react';
import { videoEmbed } from '@open-signal/shared';
import { LANGUAGE_LABELS, SUPPORTED_LANGUAGES, type Lang } from '@open-signal/i18n';
import { Badge, Button, EmptyState, Field, IconAcademy, Input, Notice, Panel, Segmented, Select, Switch, TextArea } from '@open-signal/ui';
import { useI18n } from '../i18n.tsx';
import { ApiError, api, errorText } from '../lib/api.ts';
import { Loading, PageTitle } from '../components/layout.tsx';

type Localized = { ru?: string; uk?: string; en?: string };
interface CatalogLesson { id: string; categoryId: string; title: Localized; durationMin: number; order: number; hasVideo: boolean; hasPdf: boolean; published: boolean }
interface Category { id: string; title: Localized; order: number; published: boolean; lessons: CatalogLesson[] }
interface Catalog { builtIn: boolean; categories: Category[] }
interface LessonForm {
  categoryId: string;
  title: Localized;
  summary: Localized;
  body: Localized;
  videoUrl: string;
  pdfUrl: string;
  durationMin: number;
  order: number;
  published: boolean;
}

const label = (v: Localized, lang: Lang) => v[lang] || v.en || v.ru || v.uk || '—';
const missingLangs = (...fields: Localized[]) => SUPPORTED_LANGUAGES.filter((l) => fields.some((f) => !f[l]?.trim()));

/** The shared Academy: one catalogue for every bot. */
export function AcademyAdminPage() {
  const { t, lang } = useI18n();
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [edit, setEdit] = useState<{ kind: 'lesson'; id: string | null; categoryId?: string } | { kind: 'category'; id: string | null } | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    api<{ catalog: Catalog }>('GET', '/academy').then((r) => setCatalog(r.catalog), (e: unknown) => setError(errorText(t, e)));
  }, [t]);
  useEffect(load, [load]);

  const importBuiltIn = async () => {
    setBusy(true);
    try {
      setCatalog((await api<{ catalog: Catalog }>('POST', '/academy/import')).catalog);
    } catch (e) {
      setError(errorText(t, e));
    } finally {
      setBusy(false);
    }
  };

  if (edit?.kind === 'lesson' && catalog) return <LessonEditor id={edit.id} categories={catalog.categories} defaultCategory={edit.categoryId} onClose={() => (setEdit(null), load())} />;
  if (edit?.kind === 'category' && catalog) return <CategoryEditor category={catalog.categories.find((c) => c.id === edit.id) ?? null} onClose={() => (setEdit(null), load())} />;

  const total = catalog?.categories.reduce((n, c) => n + c.lessons.length, 0) ?? 0;
  return (
    <div className="os-enter">
      <PageTitle
        title={t('admin.academy.title')}
        subtitle={t('admin.academy.subtitle')}
        action={catalog && !catalog.builtIn ? (
          <div className="flex gap-2">
            <Button variant="secondary" onClick={() => setEdit({ kind: 'category', id: null })}>{t('admin.academy.newCategory')}</Button>
            <Button onClick={() => setEdit({ kind: 'lesson', id: null })} disabled={!catalog.categories.length}>{t('admin.academy.newLesson')}</Button>
          </div>
        ) : undefined}
      />
      {error ? <Notice tone="danger" className="mb-5">{error}</Notice> : null}
      {!catalog ? <Loading /> : (
        <div className="flex flex-col gap-5">
          {catalog.builtIn ? (
            <Panel className="p-5 lg:p-6">
              <h2 className="text-[17px] font-semibold">{t('admin.academy.builtInTitle')}</h2>
              <p className="mt-1 max-w-2xl text-[14px] text-muted">{t('admin.academy.builtInText', { n: total })}</p>
              <Button className="mt-4" busy={busy} onClick={() => void importBuiltIn()}>{t('admin.academy.import')}</Button>
            </Panel>
          ) : null}
          {catalog.categories.length === 0 ? <Panel><EmptyState icon={<IconAcademy />} text={t('admin.academy.empty')} /></Panel> : null}
          {catalog.categories.map((c) => (
            <Panel key={c.id} className="overflow-hidden">
              <div className="flex flex-wrap items-center justify-between gap-3 px-5 py-4">
                <div className="flex items-center gap-2">
                  <span className="text-[16px] font-semibold">{label(c.title, lang)}</span>
                  {!c.published ? <Badge>{t('admin.academy.draft')}</Badge> : null}
                  <span className="os-num text-[13px] text-muted">{c.lessons.length}</span>
                </div>
                {!catalog.builtIn ? (
                  <div className="flex gap-2">
                    <Button size="sm" variant="ghost" onClick={() => setEdit({ kind: 'category', id: c.id })}>{t('admin.academy.edit')}</Button>
                    <Button size="sm" variant="secondary" onClick={() => setEdit({ kind: 'lesson', id: null, categoryId: c.id })}>{t('admin.academy.addLesson')}</Button>
                  </div>
                ) : null}
              </div>
              <ul className="os-rows border-t border-line">
                {c.lessons.map((l) => (
                  <li key={l.id}>
                    <button type="button" disabled={catalog.builtIn} onClick={() => setEdit({ kind: 'lesson', id: l.id })} className="flex w-full items-center gap-3 px-5 py-3 text-left text-[14px] enabled:hover:bg-white/[0.03]">
                      <span className="os-num w-8 text-muted">{l.order}</span>
                      <span className="flex-1 font-medium">{label(l.title, lang)}</span>
                      {l.hasVideo ? <Badge>{t('academy.video')}</Badge> : null}
                      {l.hasPdf ? <Badge>PDF</Badge> : null}
                      {!l.published ? <Badge tone="warning">{t('admin.academy.draft')}</Badge> : null}
                      <span className="text-[13px] text-muted">{t('academy.minutes', { n: l.durationMin })}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </Panel>
          ))}
        </div>
      )}
    </div>
  );
}

function LocalizedInputs({ label: lbl, value, onChange, multiline, rows, max }: { label: string; value: Localized; onChange: (v: Localized) => void; multiline?: boolean; rows?: number; max: number }) {
  const [tab, setTab] = useState<Lang>('ru');
  return (
    <div>
      <div className="mb-2 flex items-center justify-between gap-3">
        <span className="text-[14px] font-medium">{lbl}</span>
        <Segmented ariaLabel={lbl} value={tab} onChange={setTab} options={SUPPORTED_LANGUAGES.map((l) => ({ value: l, label: <span className={value[l]?.trim() ? '' : 'text-danger'}>{l.toUpperCase()}</span> }))} />
      </div>
      {multiline ? (
        <TextArea id={`li-${lbl}-${tab}`} rows={rows ?? 4} maxLength={max} value={value[tab] ?? ''} onChange={(v) => onChange({ ...value, [tab]: v })} />
      ) : (
        <Input aria-label={`${lbl} (${LANGUAGE_LABELS[tab]})`} maxLength={max} value={value[tab] ?? ''} onChange={(e) => onChange({ ...value, [tab]: e.target.value })} />
      )}
    </div>
  );
}

function CategoryEditor({ category, onClose }: { category: Category | null; onClose: () => void }) {
  const { t } = useI18n();
  const [title, setTitle] = useState<Localized>(category?.title ?? {});
  const [order, setOrder] = useState(category?.order ?? 100);
  const [published, setPublished] = useState(category?.published ?? true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    try {
      const body = { title, order, published };
      if (category) await api('PUT', `/academy/categories/${category.id}`, body);
      else await api('POST', '/academy/categories', body);
      onClose();
    } catch (e) {
      setError(errorText(t, e));
      setBusy(false);
    }
  };
  const remove = async () => {
    if (!category) return;
    setBusy(true);
    try {
      await api('DELETE', `/academy/categories/${category.id}`);
      onClose();
    } catch (e) {
      setError(errorText(t, e));
      setBusy(false);
    }
  };
  const missing = missingLangs(title);
  return (
    <div className="os-enter">
      <PageTitle title={category ? t('admin.academy.editCategory') : t('admin.academy.newCategory')} back={{ label: t('admin.academy.title'), onClick: onClose }} />
      <Panel className="max-w-2xl p-5 lg:p-6">
        <div className="flex flex-col gap-5">
          <LocalizedInputs label={t('admin.academy.fTitle')} value={title} onChange={setTitle} max={80} />
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label={t('admin.academy.fOrder')} htmlFor="c-order"><Input id="c-order" type="number" value={String(order)} onChange={(e) => setOrder(Number(e.target.value))} /></Field>
            <label className="flex items-center gap-3 self-end pb-3 text-[14px]"><Switch checked={published} onChange={setPublished} label={t('admin.academy.published')} />{t('admin.academy.published')}</label>
          </div>
          {missing.length ? <Notice tone="warning">{t('admin.academy.missingLangs', { langs: missing.map((l) => l.toUpperCase()).join(', ') })}</Notice> : null}
          {error ? <Notice tone="danger">{error}</Notice> : null}
          <div className="flex flex-wrap gap-2">
            <Button busy={busy} onClick={() => void save()}>{t('admin.editor.save')}</Button>
            {category ? <Button variant="danger" disabled={busy || category.lessons.length > 0} onClick={() => void remove()}>{t('admin.academy.delete')}</Button> : null}
          </div>
          {category && category.lessons.length > 0 ? <p className="text-[13px] text-muted">{t('admin.academy.deleteCategoryHint')}</p> : null}
        </div>
      </Panel>
    </div>
  );
}

function LessonEditor({ id, categories, defaultCategory, onClose }: { id: string | null; categories: Category[]; defaultCategory?: string; onClose: () => void }) {
  const { t } = useI18n();
  const [form, setForm] = useState<LessonForm | null>(
    id ? null : { categoryId: defaultCategory ?? categories[0]?.id ?? '', title: {}, summary: {}, body: {}, videoUrl: '', pdfUrl: '', durationMin: 5, order: 100, published: false },
  );
  const [fields, setFields] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!id) return;
    api<{ lesson: LessonForm & { videoUrl: string | null; pdfUrl: string | null } }>('GET', `/academy/lessons/${id}`).then(
      (r) => setForm({ ...r.lesson, videoUrl: r.lesson.videoUrl ?? '', pdfUrl: r.lesson.pdfUrl ?? '' }),
      (e: unknown) => setError(errorText(t, e)),
    );
  }, [id, t]);

  if (!form) return error ? <Notice tone="danger">{error}</Notice> : <Loading />;
  const set = <K extends keyof LessonForm>(k: K, v: LessonForm[K]) => setForm({ ...form, [k]: v });
  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const body = { ...form, videoUrl: form.videoUrl.trim() || null, pdfUrl: form.pdfUrl.trim() || null };
      if (id) await api('PUT', `/academy/lessons/${id}`, body);
      else await api('POST', '/academy/lessons', body);
      onClose();
    } catch (e) {
      if (e instanceof ApiError) setFields(e.fields);
      setError(errorText(t, e));
      setBusy(false);
    }
  };
  const remove = async () => {
    if (!id) return;
    setBusy(true);
    try {
      await api('DELETE', `/academy/lessons/${id}`);
      onClose();
    } catch (e) {
      setError(errorText(t, e));
      setBusy(false);
    }
  };
  const videoOk = !form.videoUrl.trim() || videoEmbed(form.videoUrl.trim()) !== null;
  const missing = missingLangs(form.title, form.body);

  return (
    <div className="os-enter">
      <PageTitle title={id ? t('admin.academy.editLesson') : t('admin.academy.newLesson')} back={{ label: t('admin.academy.title'), onClick: onClose }} />
      <Panel className="max-w-3xl p-5 lg:p-6">
        <div className="flex flex-col gap-5">
          <div className="grid gap-4 sm:grid-cols-3">
            <Field label={t('admin.academy.fCategory')} htmlFor="l-cat">
              <Select id="l-cat" value={form.categoryId} onChange={(v) => set('categoryId', v)} options={categories.map((c) => ({ value: c.id, label: c.title.ru || c.title.en || c.id }))} />
            </Field>
            <Field label={t('admin.academy.fOrder')} htmlFor="l-order"><Input id="l-order" type="number" value={String(form.order)} onChange={(e) => set('order', Number(e.target.value))} /></Field>
            <Field label={t('admin.academy.fDuration')} htmlFor="l-dur"><Input id="l-dur" type="number" value={String(form.durationMin)} onChange={(e) => set('durationMin', Number(e.target.value))} /></Field>
          </div>
          <LocalizedInputs label={t('admin.academy.fTitle')} value={form.title} onChange={(v) => set('title', v)} max={120} />
          <LocalizedInputs label={t('admin.academy.fSummary')} value={form.summary} onChange={(v) => set('summary', v)} multiline rows={2} max={300} />
          <LocalizedInputs label={t('admin.academy.fBody')} value={form.body} onChange={(v) => set('body', v)} multiline rows={14} max={20000} />
          <p className="-mt-3 text-[13px] text-muted">{t('admin.academy.bodyHint')}</p>
          <div className="grid gap-4 md:grid-cols-2">
            <Field label={t('admin.academy.fVideo')} hint={videoOk ? t('admin.academy.videoHint') : undefined} error={!videoOk ? t('admin.academy.videoBad') : fields['videoUrl']} htmlFor="l-video">
              <Input id="l-video" value={form.videoUrl} placeholder="https://www.youtube.com/watch?v=…" onChange={(e) => set('videoUrl', e.target.value)} />
            </Field>
            <Field label={t('admin.academy.fPdf')} hint={t('admin.academy.pdfHint')} error={fields['pdfUrl']} htmlFor="l-pdf">
              <Input id="l-pdf" value={form.pdfUrl} placeholder="https://…/lesson.pdf" onChange={(e) => set('pdfUrl', e.target.value)} />
            </Field>
          </div>
          <label className="flex items-center gap-3 text-[14px]"><Switch checked={form.published} onChange={(v) => set('published', v)} label={t('admin.academy.published')} />{t('admin.academy.published')}</label>
          {missing.length ? <Notice tone="warning">{t('admin.academy.missingLangs', { langs: missing.map((l) => l.toUpperCase()).join(', ') })}</Notice> : null}
          {error ? <Notice tone="danger">{error}</Notice> : null}
          <div className="flex flex-wrap gap-2">
            <Button busy={busy} disabled={!videoOk} onClick={() => void save()}>{t('admin.editor.save')}</Button>
            {id ? <Button variant="danger" disabled={busy} onClick={() => void remove()}>{t('admin.academy.delete')}</Button> : null}
          </div>
        </div>
      </Panel>
    </div>
  );
}
