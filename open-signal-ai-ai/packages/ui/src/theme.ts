/**
 * Dynamic theming. A bot's theme (from the admin panel) becomes a set of CSS
 * custom properties on a root element; every component reads only these
 * variables, so changing a theme never requires touching components.
 */

import type { Theme } from '@open-signal/shared';

/** Single source of truth for theme shape and defaults lives in @open-signal/shared. */
export type ThemeColors = Theme;
export { DEFAULT_THEME as DEFAULT_THEME_COLORS } from '@open-signal/shared';

const HEX = /^#([0-9a-f]{6})$/i;

export function hexToRgb(hex: string): [number, number, number] {
  const m = HEX.exec(hex);
  if (!m) throw new Error(`Invalid colour: ${hex}`);
  const n = parseInt(m[1]!, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** WCAG 2.x relative luminance. */
export function luminance(hex: string): number {
  const [r, g, b] = hexToRgb(hex).map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG contrast ratio between two colours (1…21). */
export function contrastRatio(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

/** Converts a theme into CSS custom properties consumed by the design system. */
export function themeToCssVars(theme: ThemeColors): Record<string, string> {
  const rgb = (hex: string) => hexToRgb(hex).join(' ');
  return {
    '--os-primary': theme.primary,
    '--os-primary-rgb': rgb(theme.primary),
    '--os-secondary': theme.secondary,
    '--os-accent': theme.accent,
    '--os-bg': theme.background,
    '--os-surface': theme.surface,
    '--os-card': theme.card,
    '--os-text': theme.text,
    '--os-text-muted': theme.textMuted,
    '--os-btn-from': theme.buttonFrom,
    '--os-btn-to': theme.buttonTo,
    // Text colour on top of the button gradient: pick the more readable one.
    '--os-on-primary':
      contrastRatio('#FFFFFF', theme.buttonFrom) >= contrastRatio('#0A0A0A', theme.buttonFrom) ? '#FFFFFF' : '#0A0A0A',
  };
}

export interface StyleTarget {
  style: { setProperty(name: string, value: string): void };
}

export function applyTheme(target: StyleTarget, theme: ThemeColors): void {
  for (const [k, v] of Object.entries(themeToCssVars(theme))) target.style.setProperty(k, v);
}
