import { formatNumber } from './format.ts';

/**
 * Spanish agreement for counts (odd/archive/functional-10.md T4): one takes the singular, zero and
 * more than one the plural; no screen leaves the choice to the reader.
 */
export const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);

/** «1 registro», «53 registros», «48 señales documentadas». */
export const count = (n: number, one: string, many: string) =>
  `${formatNumber(n)} ${plural(n, one, many)}`;
