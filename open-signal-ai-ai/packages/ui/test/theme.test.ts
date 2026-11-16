import { test } from 'node:test';
import assert from 'node:assert/strict';
import { contrastRatio, themeToCssVars, applyTheme, DEFAULT_THEME_COLORS } from '../src/theme.ts';

test('contrast ratio matches WCAG reference values', () => {
  assert.equal(Math.round(contrastRatio('#FFFFFF', '#000000')), 21);
  assert.equal(contrastRatio('#777777', '#777777'), 1);
});

test('default theme has readable text on background and cards', () => {
  assert.ok(contrastRatio(DEFAULT_THEME_COLORS.text, DEFAULT_THEME_COLORS.background) >= 4.5);
  assert.ok(contrastRatio(DEFAULT_THEME_COLORS.text, DEFAULT_THEME_COLORS.card) >= 4.5);
  assert.ok(contrastRatio(DEFAULT_THEME_COLORS.textMuted, DEFAULT_THEME_COLORS.card) >= 4.5);
});

test('theme becomes CSS variables applied to a root element', () => {
  const vars = themeToCssVars({ ...DEFAULT_THEME_COLORS, primary: '#123456' });
  assert.equal(vars['--os-primary'], '#123456');
  assert.equal(vars['--os-primary-rgb'], '18 52 86');
  const set: Record<string, string> = {};
  applyTheme({ style: { setProperty: (k, v) => (set[k] = v) } }, DEFAULT_THEME_COLORS);
  assert.equal(set['--os-bg'], DEFAULT_THEME_COLORS.background);
});
