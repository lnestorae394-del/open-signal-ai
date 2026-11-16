import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dictionaries, flatten, resolveLanguage, translate, SUPPORTED_LANGUAGES } from '../src/index.ts';

const flat = Object.fromEntries(
  SUPPORTED_LANGUAGES.map((l) => [l, flatten(dictionaries[l])]),
) as Record<(typeof SUPPORTED_LANGUAGES)[number], Record<string, string>>;

test('every language has exactly the same keys', () => {
  const reference = Object.keys(flat.en).sort();
  for (const lang of SUPPORTED_LANGUAGES) {
    const keys = Object.keys(flat[lang]).sort();
    const missing = reference.filter((k) => !keys.includes(k));
    const extra = keys.filter((k) => !reference.includes(k));
    assert.deepEqual(missing, [], `${lang}: missing keys`);
    assert.deepEqual(extra, [], `${lang}: extra keys`);
  }
});

test('no empty translations', () => {
  for (const lang of SUPPORTED_LANGUAGES) {
    for (const [k, v] of Object.entries(flat[lang])) {
      assert.ok(v.trim().length > 0, `${lang}.${k} is empty`);
    }
  }
});

test('placeholders match across languages', () => {
  const ph = (s: string) => (s.match(/\{\w+\}/g) ?? []).sort().join(',');
  for (const key of Object.keys(flat.en)) {
    for (const lang of SUPPORTED_LANGUAGES) {
      assert.equal(ph(flat[lang][key] ?? ''), ph(flat.en[key] ?? ''), `${lang}.${key} placeholders differ`);
    }
  }
});

test('interpolation and no cross-language fallback', () => {
  assert.equal(translate('en', 'academy.progress', { done: 2, total: 10 }), 'Completed 2 of 10');
  assert.equal(translate('ru', 'academy.progress', { done: 2, total: 10 }), 'Пройдено 2 из 10');
  assert.equal(translate('uk', 'does.not.exist'), 'does.not.exist');
});

test('language resolution order', () => {
  assert.equal(resolveLanguage('uk', 'en', 'ru'), 'uk');
  assert.equal(resolveLanguage(null, 'en', 'ru'), 'en');
  assert.equal(resolveLanguage(undefined, 'xx', 'uk-UA'), 'uk');
  assert.equal(resolveLanguage(undefined, undefined, 'de'), 'ru');
});

test('every translation key used in the apps exists (no raw keys on screen)', async () => {
  const { readdirSync, readFileSync, statSync } = await import('node:fs');
  const { join } = await import('node:path');
  const root = new URL('../../../', import.meta.url).pathname;
  const files: string[] = [];
  const walk = (d: string) => {
    for (const f of readdirSync(d)) {
      const p = join(d, f);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.(tsx?)$/.test(f)) files.push(p);
    }
  };
  for (const d of ['apps/admin/src', 'apps/miniapp/src', 'apps/api/src']) walk(join(root, d));
  const missing: string[] = [];
  for (const f of files) {
    for (const m of readFileSync(f, 'utf8').matchAll(/\bt\(\s*'([a-zA-Z0-9_.]+)'/g)) {
      if (!(m[1]! in flat.en)) missing.push(`${m[1]} (${f.slice(root.length)})`);
    }
  }
  assert.deepEqual(missing, []);
});
