import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ALL_INSTRUMENTS,
  DEFAULT_THEME,
  FOREX_INSTRUMENTS,
  OTC_INSTRUMENTS,
  botTokenSchema,
  botUsernameSchema,
  forexSessionState,
  themeSchema,
} from '../src/index.ts';

test('catalogue has the 21 requested Forex pairs and a separate OTC category', () => {
  assert.equal(FOREX_INSTRUMENTS.length, 21);
  assert.equal(OTC_INSTRUMENTS.length, 21);
  assert.equal(new Set(ALL_INSTRUMENTS.map((i) => i.id)).size, 42, 'ids are unique');
  for (const i of OTC_INSTRUMENTS) {
    assert.equal(i.market, 'otc');
    assert.equal(i.providerSymbol, null, 'OTC must not reuse Forex quotes');
  }
});

test('forex calendar: closed on Saturday, open on Wednesday, edges at 22:00 UTC', () => {
  assert.equal(forexSessionState(new Date('2026-11-14T12:00:00Z')).open, false); // Saturday
  assert.equal(forexSessionState(new Date('2026-11-18T12:00:00Z')).open, true); // Wednesday
  assert.equal(forexSessionState(new Date('2026-11-15T21:59:59Z')).open, false); // Sunday before open
  assert.equal(forexSessionState(new Date('2026-11-15T22:00:00Z')).open, true); // Sunday open
  assert.equal(forexSessionState(new Date('2026-11-20T21:59:59Z')).open, true); // Friday before close
  assert.equal(forexSessionState(new Date('2026-11-20T22:00:00Z')).open, false); // Friday close
});

test('forex calendar: next state change is computed correctly', () => {
  assert.equal(
    forexSessionState(new Date('2026-11-14T12:00:00Z')).nextChangeAt.toISOString(),
    '2026-11-15T22:00:00.000Z',
  );
  assert.equal(
    forexSessionState(new Date('2026-11-18T12:00:00Z')).nextChangeAt.toISOString(),
    '2026-11-20T22:00:00.000Z',
  );
  assert.equal(
    forexSessionState(new Date('2026-11-20T23:00:00Z')).nextChangeAt.toISOString(),
    '2026-11-22T22:00:00.000Z',
  );
});

test('schemas: theme, token and username validation', () => {
  assert.ok(themeSchema.safeParse(DEFAULT_THEME).success);
  assert.equal(themeSchema.safeParse({ ...DEFAULT_THEME, primary: 'red' }).success, false);
  assert.ok(botTokenSchema.safeParse('1234567890:AAH5YkoiEuPk8-FZa32hStHTqXiLPtAEhx8').success);
  assert.equal(botTokenSchema.safeParse('not-a-token').success, false);
  assert.ok(botUsernameSchema.safeParse('OpenSignalDemoBot').success);
  assert.equal(botUsernameSchema.safeParse('open_signal').success, false);
});

test('lesson text: headings and the paragraphs under them are both kept', async () => {
  const { parseLessonText } = await import('../src/platform.ts');
  assert.deepEqual(parseLessonText('## Title\nFirst line\nsecond line\n\nNext para\n## Two\nBody'), [
    { kind: 'h', text: 'Title' },
    { kind: 'p', text: 'First line\nsecond line' },
    { kind: 'p', text: 'Next para' },
    { kind: 'h', text: 'Two' },
    { kind: 'p', text: 'Body' },
  ]);
});

test('lesson video links: YouTube / Vimeo become players, https files stay, anything else is refused', async () => {
  const { videoEmbed } = await import('../src/platform.ts');
  assert.deepEqual(videoEmbed('https://www.youtube.com/watch?v=dQw4w9WgXcQ'), { kind: 'iframe', src: 'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ' });
  assert.deepEqual(videoEmbed('https://youtu.be/dQw4w9WgXcQ'), { kind: 'iframe', src: 'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ' });
  assert.deepEqual(videoEmbed('https://vimeo.com/123456789'), { kind: 'iframe', src: 'https://player.vimeo.com/video/123456789' });
  assert.equal(videoEmbed('https://cdn.example.com/a.mp4')?.kind, 'file');
  assert.equal(videoEmbed('http://cdn.example.com/a.mp4'), null);
  assert.equal(videoEmbed('https://example.com/page'), null);
});
