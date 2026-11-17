import { randomBytes } from 'node:crypto';
import { academyCategoryInputSchema, academyLessonInputSchema, type AcademyCategoryInput, type AcademyLessonInput } from '@open-signal/shared';
import { AppError } from '../lib/errors.ts';
import { C } from '../storage/collections.ts';
import type { DocumentStore } from '../storage/types.ts';
import type { UserRecord } from '../domain/records.ts';
import type { TenantScope } from '../domain/tenant.ts';
import { writeAudit } from '../domain/audit.ts';
import { requireOwner, type AdminActor } from '../admin/auth.ts';
import { BUILTIN_CATEGORIES, BUILTIN_LESSONS } from './builtin.ts';

export type CategoryRecord = AcademyCategoryInput & { [k: string]: unknown; updatedAt: string };
export type LessonRecord = AcademyLessonInput & { [k: string]: unknown; updatedAt: string };

interface ProgressRecord {
  [k: string]: unknown;
  botId: string;
  /** lessonId → ISO time it was marked as done. */
  completed: Record<string, string>;
  updatedAt: string;
}

export interface CatalogLesson {
  id: string;
  categoryId: string;
  title: AcademyLessonInput['title'];
  summary: AcademyLessonInput['summary'];
  durationMin: number;
  order: number;
  hasVideo: boolean;
  hasPdf: boolean;
  published: boolean;
}

export interface Catalog {
  /** True while the shared Academy has no lessons of its own and the starter course is shown. */
  builtIn: boolean;
  categories: { id: string; title: AcademyCategoryInput['title']; order: number; published: boolean; lessons: CatalogLesson[] }[];
}

function validation(error: { issues: { path: PropertyKey[]; message: string }[] }): AppError {
  const fields: Record<string, string> = {};
  for (const i of error.issues) fields[i.path.map(String).join('.') || 'form'] = i.message;
  return new AppError('VALIDATION_FAILED', 'invalid academy content', { fields });
}

const byOrder = <T extends { order: number }>(a: T, b: T) => a.order - b.order;

/**
 * The Academy is shared by every bot: one catalogue for the whole platform.
 * Progress is personal and stored per user (users are separated by bot).
 */
export class AcademyService {
  private readonly store: DocumentStore;
  private readonly now: () => Date;

  constructor(deps: { store: DocumentStore; now: () => Date }) {
    this.store = deps.store;
    this.now = deps.now;
  }

  private async load(): Promise<{ builtIn: boolean; categories: (AcademyCategoryInput & { id: string })[]; lessons: (AcademyLessonInput & { id: string })[] }> {
    const [cats, lessons] = await Promise.all([
      this.store.query<CategoryRecord>(C.academyCategories, { limit: 200 }),
      this.store.query<LessonRecord>(C.academyLessons, { limit: 1000 }),
    ]);
    if (cats.length === 0 && lessons.length === 0) return { builtIn: true, categories: BUILTIN_CATEGORIES, lessons: BUILTIN_LESSONS };
    return {
      builtIn: false,
      categories: cats.map((c) => ({ ...c.data, id: c.id })),
      lessons: lessons.map((l) => ({ ...l.data, id: l.id })),
    };
  }

  /** Catalogue. `publishedOnly` for the Mini App, everything for the admin. */
  async catalog(publishedOnly: boolean): Promise<Catalog> {
    const { builtIn, categories, lessons } = await this.load();
    const cats = categories.filter((c) => !publishedOnly || c.published).sort(byOrder);
    return {
      builtIn,
      categories: cats.map((c) => ({
        id: c.id,
        title: c.title,
        order: c.order,
        published: c.published,
        lessons: lessons
          .filter((l) => l.categoryId === c.id && (!publishedOnly || l.published))
          .sort(byOrder)
          .map((l) => ({ id: l.id, categoryId: l.categoryId, title: l.title, summary: l.summary, durationMin: l.durationMin, order: l.order, hasVideo: Boolean(l.videoUrl), hasPdf: Boolean(l.pdfUrl), published: l.published })),
      })),
    };
  }

  async lesson(id: string, publishedOnly: boolean): Promise<AcademyLessonInput & { id: string }> {
    const { categories, lessons } = await this.load();
    const l = lessons.find((x) => x.id === id);
    const cat = l ? categories.find((c) => c.id === l.categoryId) : null;
    if (!l || !cat || (publishedOnly && (!l.published || !cat.published))) throw new AppError('NOT_FOUND');
    return l;
  }

  // ───────── progress (per user) ─────────

  async progress(scope: TenantScope, user: UserRecord): Promise<Record<string, string>> {
    const p = await this.store.get<ProgressRecord>(C.academyProgress, scope.userDocId(user.telegramId));
    return p && scope.owns(p) ? p.completed : {};
  }

  async setCompleted(scope: TenantScope, user: UserRecord, lessonId: string, done: boolean): Promise<Record<string, string>> {
    await this.lesson(lessonId, true); // only existing, published lessons
    const id = scope.userDocId(user.telegramId);
    const nowIso = this.now().toISOString();
    return this.store.runTransaction(async (tx) => {
      const p = await tx.get<ProgressRecord>(C.academyProgress, id);
      const completed = { ...(p && scope.owns(p) ? p.completed : {}) };
      if (done) completed[lessonId] ??= nowIso;
      else delete completed[lessonId];
      tx.set(C.academyProgress, id, scope.stamp({ completed, updatedAt: nowIso }));
      return completed;
    });
  }

  // ───────── admin (owner only, audited) ─────────

  /** Copies the starter course into the database so it can be edited. Existing documents are never overwritten. */
  async importBuiltIn(actor: AdminActor): Promise<void> {
    requireOwner(actor);
    const now = this.now();
    await this.store.runTransaction(async (tx) => {
      const existing = await Promise.all([
        ...BUILTIN_CATEGORIES.map((c) => tx.get(C.academyCategories, c.id)),
        ...BUILTIN_LESSONS.map((l) => tx.get(C.academyLessons, l.id)),
      ]);
      BUILTIN_CATEGORIES.forEach(({ id, ...c }, i) => {
        if (!existing[i]) tx.create(C.academyCategories, id, { ...c, updatedAt: now.toISOString() });
      });
      BUILTIN_LESSONS.forEach(({ id, ...l }, i) => {
        if (!existing[BUILTIN_CATEGORIES.length + i]) tx.create(C.academyLessons, id, { ...l, updatedAt: now.toISOString() });
      });
      writeAudit(tx, { botId: 'global', actor: { type: 'admin', id: actor.uid }, action: 'academy.imported', target: 'builtin' }, now);
    });
  }

  async saveCategory(actor: AdminActor, id: string | null, raw: unknown): Promise<string> {
    requireOwner(actor);
    const parsed = academyCategoryInputSchema.safeParse(raw);
    if (!parsed.success) throw validation(parsed.error);
    const now = this.now();
    const docId = id ?? `c-${randomBytes(4).toString('hex')}`;
    await this.store.runTransaction(async (tx) => {
      const before = await tx.get<CategoryRecord>(C.academyCategories, docId);
      if (id && !before) throw new AppError('NOT_FOUND');
      tx.set(C.academyCategories, docId, { ...parsed.data, updatedAt: now.toISOString() });
      writeAudit(tx, { botId: 'global', actor: { type: 'admin', id: actor.uid }, action: id ? 'academy.category_updated' : 'academy.category_created', target: docId, after: { title: parsed.data.title } }, now);
    });
    return docId;
  }

  async deleteCategory(actor: AdminActor, id: string): Promise<void> {
    requireOwner(actor);
    const lessons = await this.store.query<LessonRecord>(C.academyLessons, { where: [{ field: 'categoryId', op: '==', value: id }], limit: 1 });
    if (lessons.length) throw new AppError('VALIDATION_FAILED', 'move or delete the lessons of this category first', { fields: { category: 'not empty' } });
    const now = this.now();
    await this.store.runTransaction(async (tx) => {
      if (!(await tx.get(C.academyCategories, id))) throw new AppError('NOT_FOUND');
      tx.delete(C.academyCategories, id);
      writeAudit(tx, { botId: 'global', actor: { type: 'admin', id: actor.uid }, action: 'academy.category_deleted', target: id }, now);
    });
  }

  async saveLesson(actor: AdminActor, id: string | null, raw: unknown): Promise<string> {
    requireOwner(actor);
    const parsed = academyLessonInputSchema.safeParse(raw);
    if (!parsed.success) throw validation(parsed.error);
    const now = this.now();
    const docId = id ?? `l-${randomBytes(4).toString('hex')}`;
    await this.store.runTransaction(async (tx) => {
      const cat = await tx.get(C.academyCategories, parsed.data.categoryId);
      if (!cat) throw new AppError('VALIDATION_FAILED', 'category not found', { fields: { categoryId: 'not found' } });
      const before = await tx.get<LessonRecord>(C.academyLessons, docId);
      if (id && !before) throw new AppError('NOT_FOUND');
      tx.set(C.academyLessons, docId, { ...parsed.data, updatedAt: now.toISOString() });
      writeAudit(tx, { botId: 'global', actor: { type: 'admin', id: actor.uid }, action: id ? 'academy.lesson_updated' : 'academy.lesson_created', target: docId, after: { title: parsed.data.title, published: parsed.data.published } }, now);
    });
    return docId;
  }

  async deleteLesson(actor: AdminActor, id: string): Promise<void> {
    requireOwner(actor);
    const now = this.now();
    await this.store.runTransaction(async (tx) => {
      if (!(await tx.get(C.academyLessons, id))) throw new AppError('NOT_FOUND');
      tx.delete(C.academyLessons, id);
      writeAudit(tx, { botId: 'global', actor: { type: 'admin', id: actor.uid }, action: 'academy.lesson_deleted', target: id }, now);
    });
  }
}
