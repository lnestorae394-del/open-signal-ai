import { z } from 'zod';
import { SIGNAL_PERIODS_SEC } from './constants.ts';
import { FOREX_INSTRUMENTS, OTC_INSTRUMENTS } from './instruments.ts';
import { localizedTextSchema } from './schemas.ts';

// ───────────────────────── signals (shared by every bot) ─────────────────────────

const periodSchema = z.number().int().refine((v) => (SIGNAL_PERIODS_SEC as readonly number[]).includes(v), 'unsupported period');

/** Platform-wide signal settings: one signal system for all bots. */
export const signalSettingsSchema = z
  .object({
    forexInstruments: z.array(z.string().max(32)).max(100),
    otcInstruments: z.array(z.string().max(32)).max(100),
    periods: z.array(periodSchema).min(1).max(SIGNAL_PERIODS_SEC.length),
    defaultPeriod: periodSchema,
    /** Seconds between two signals of one user. */
    cooldownSec: z.number().int().min(0).max(3600),
    /** Signals per user per UTC day. */
    maxPerDay: z.number().int().min(1).max(1000),
    /** The app (signals, academy) opens only after a confirmed first deposit of at least $10. */
    requireFtd: z.boolean(),
    /**
     * Hidden Dinox Academy rule: a registration postback WITHOUT our click_id is kept with an
     * unknown owner, and the first user who enters that Trader ID links it (one account per
     * Trader ID across all bots). Off = a registration must carry the user's own click_id.
     */
    allowClicklessRegistration: z.boolean(),
  })
  .refine((s) => s.forexInstruments.length + s.otcInstruments.length > 0, { message: 'at least one instrument', path: ['forexInstruments'] })
  .refine((s) => s.periods.includes(s.defaultPeriod), { message: 'default period must be enabled', path: ['defaultPeriod'] })
  .refine((s) => s.forexInstruments.every((id) => FOREX_INSTRUMENTS.some((i) => i.id === id)), { message: 'unknown Forex instrument', path: ['forexInstruments'] })
  .refine((s) => s.otcInstruments.every((id) => OTC_INSTRUMENTS.some((i) => i.id === id)), { message: 'unknown OTC instrument', path: ['otcInstruments'] });
export type SignalSettings = z.infer<typeof signalSettingsSchema>;

export const DEFAULT_SIGNAL_SETTINGS: SignalSettings = {
  forexInstruments: FOREX_INSTRUMENTS.map((i) => i.id),
  otcInstruments: OTC_INSTRUMENTS.map((i) => i.id),
  periods: [...SIGNAL_PERIODS_SEC],
  defaultPeriod: 60,
  cooldownSec: 30,
  maxPerDay: 50,
  requireFtd: true,
  allowClicklessRegistration: true,
};

// ───────────────────────── academy (shared by every bot) ─────────────────────────

const httpsUrl = z
  .string()
  .trim()
  .max(1000)
  .refine((v) => {
    try {
      return new URL(v).protocol === 'https:';
    } catch {
      return false;
    }
  }, 'must be an https:// address');

export const academyCategoryInputSchema = z.object({
  title: localizedTextSchema(80),
  order: z.number().int().min(0).max(10_000),
  published: z.boolean(),
});
export type AcademyCategoryInput = z.infer<typeof academyCategoryInputSchema>;

export const academyLessonInputSchema = z.object({
  categoryId: z.string().regex(/^[a-z0-9-]{2,40}$/),
  title: localizedTextSchema(120),
  summary: localizedTextSchema(300),
  /** Lesson text. Blank line = new paragraph, a line starting with "## " = heading. */
  body: localizedTextSchema(20_000),
  /** YouTube, Vimeo or a direct https .mp4 link. */
  videoUrl: httpsUrl.nullable(),
  pdfUrl: httpsUrl.nullable(),
  durationMin: z.number().int().min(0).max(600),
  order: z.number().int().min(0).max(10_000),
  published: z.boolean(),
});
export type AcademyLessonInput = z.infer<typeof academyLessonInputSchema>;

/** Turns a YouTube / Vimeo page link into an embeddable player URL; direct files stay as they are. */
export function videoEmbed(url: string): { kind: 'iframe' | 'file'; src: string } | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:') return null;
  const host = u.hostname.replace(/^www\.|^m\./, '');
  const yt = host === 'youtu.be' ? u.pathname.slice(1) : host === 'youtube.com' ? (u.searchParams.get('v') ?? u.pathname.match(/^\/(?:shorts|embed|live)\/([\w-]+)/)?.[1]) : null;
  if (yt && /^[\w-]{6,20}$/.test(yt)) return { kind: 'iframe', src: `https://www.youtube-nocookie.com/embed/${yt}` };
  if (host === 'vimeo.com' || host === 'player.vimeo.com') {
    const id = u.pathname.match(/(\d{5,12})/)?.[1];
    if (id) return { kind: 'iframe', src: `https://player.vimeo.com/video/${id}` };
  }
  if (/\.(mp4|webm)$/i.test(u.pathname)) return { kind: 'file', src: u.toString() };
  return null;
}

/** Lesson text: a blank line starts a new paragraph, a line starting with "## " is a heading. */
export function parseLessonText(text: string): { kind: 'h' | 'p'; text: string }[] {
  const out: { kind: 'h' | 'p'; text: string }[] = [];
  let para: string[] = [];
  const flush = () => {
    if (para.length) out.push({ kind: 'p', text: para.join('\n').trim() });
    para = [];
  };
  for (const line of text.replace(/\r\n/g, '\n').split('\n')) {
    if (line.startsWith('## ')) {
      flush();
      out.push({ kind: 'h', text: line.slice(3).trim() });
    } else if (!line.trim()) flush();
    else para.push(line);
  }
  flush();
  return out.filter((b) => b.text);
}
