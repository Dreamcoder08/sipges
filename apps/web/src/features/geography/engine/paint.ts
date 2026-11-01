/**
 * Map paint for the canvases that cannot use var() (MapLibre styles, deck.gl layers, CesiumJS
 * colours). They read the --map-* tokens of tokens.css from the document root, which already
 * resolves the theme on screen, so tokens.css stays the only place that holds the values.
 */
export type PaintTheme = 'light' | 'dark';

/**
 * Used only where no stylesheet is loaded (jsdom); paint.test.ts checks each pair against
 * tokens.css, so the copies cannot drift. Order: [light, dark].
 */
const FALLBACK = {
  '--map-bg': ['#e9eef3', '#0b0d10'], // token-exempt: test fallback, checked against tokens.css
  '--map-outline-selected': ['#0f2541', '#ffffff'], // token-exempt: test fallback, checked against tokens.css
  '--map-district-line': ['#17365d', '#c9d4df'], // token-exempt: test fallback, checked against tokens.css
  '--map-point-halo': ['#ffffff', '#000000'], // token-exempt: test fallback, checked against tokens.css
  '--map-relief-1': ['#eef0e2', '#14211a'], // token-exempt: test fallback, checked against tokens.css
  '--map-relief-2': ['#d6e2b8', '#27402c'], // token-exempt: test fallback, checked against tokens.css
  '--map-relief-3': ['#e3d39c', '#4a4a2c'], // token-exempt: test fallback, checked against tokens.css
  '--map-relief-4': ['#c9a477', '#5e4630'], // token-exempt: test fallback, checked against tokens.css
  '--map-relief-5': ['#94714f', '#7a5c44'], // token-exempt: test fallback, checked against tokens.css
} as const;

export type PaintToken = keyof typeof FALLBACK;
export const PAINT_TOKENS = FALLBACK;

/** The token as a CSS colour (hex), read now: call it where the theme change already re-runs. */
export const paintColour = (token: PaintToken, theme: PaintTheme): string => {
  const value = getComputedStyle(document.documentElement).getPropertyValue(token).trim();
  return value || FALLBACK[token][theme === 'dark' ? 1 : 0];
};

/** The token as 0–255 channels, for deck.gl; tokens read here are six-digit hex. */
export const paintRgb = (token: PaintToken, theme: PaintTheme): [number, number, number] => {
  const n = Number.parseInt(paintColour(token, theme).slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};
