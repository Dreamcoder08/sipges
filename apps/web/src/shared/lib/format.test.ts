/// <reference types="node" />
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  formatDateTime,
  formatDay,
  formatIndex,
  formatLongDay,
  formatNumber,
  formatPercent,
  formatShares,
  formatShortDay,
  limaDay,
} from './format.ts';

// functional-10 T1 (F1–F3): one date rule — the Lima calendar day, in Spanish.
describe('dates', () => {
  it('reads a stored day as the calendar day it names, never shifted by a timezone', () => {
    expect(limaDay('2026-11-14')).toBe('2026-11-14');
    expect(formatDay('2026-11-14')).toBe('14 nov. 2026');
    expect(formatDay('2026-01-01')).toBe('1 ene. 2026');
  });

  it('reads an instant as the day it was in Lima, not the UTC day', () => {
    // 03:33 UTC on the 15th is 22:33 in Lima on the 14th.
    expect(limaDay('2026-11-15T03:33:35Z')).toBe('2026-11-14');
    expect(limaDay('2026-11-15T03:33:35.123Z')).toBe('2026-11-14');
    expect(limaDay('2026-11-15T03:33:35+00:00')).toBe('2026-11-14');
    // An instant the API wrote without an offset is UTC.
    expect(limaDay('2026-11-15T03:33:35')).toBe('2026-11-14');
    expect(limaDay(new Date('2026-11-15T05:00:00Z'))).toBe('2026-11-15');
    expect(formatDay('2026-11-15T03:33:35Z')).toBe('14 nov. 2026');
  });

  it('shows an instant with its Lima time on a 24-hour clock', () => {
    expect(formatDateTime('2026-11-15T03:33:35Z')).toBe('14 nov. 2026, 22:33');
    expect(formatDateTime(new Date('2026-11-14T13:05:00Z'))).toBe('14 nov. 2026, 08:05');
    // A day without a time has no hour to show.
    expect(formatDateTime('2026-11-14')).toBe('14 nov. 2026');
  });

  it('keeps short and long forms on the same Lima day', () => {
    expect(formatShortDay('2026-11-15T03:33:35Z')).toBe('14 nov.');
    expect(formatLongDay(new Date('2026-11-15T03:33:35Z'))).toBe('sábado, 14 de noviembre de 2026');
  });

  it('returns text that is not a date unchanged and an empty value as empty', () => {
    expect(limaDay('30 días')).toBeNull();
    expect(limaDay('2026-02-30')).toBeNull();
    expect(formatDay('30 días')).toBe('30 días');
    expect(formatDay('2026-02-30')).toBe('2026-02-30');
    expect(formatDateTime('pendiente')).toBe('pendiente');
    expect(formatDay(null)).toBe('');
    expect(formatDay(undefined)).toBe('');
    expect(formatDay('')).toBe('');
  });
});

// functional-10 T2 (F4–F6): one number rule — decimal comma, fixed decimals per kind.
/** The percent sign follows a no-break space so it never wraps alone; compare it as a space. */
const plain = (text: string) => text.replaceAll('\u00a0', ' ');

describe('numbers', () => {
  it('uses the decimal comma with a fixed number of decimals', () => {
    expect(formatNumber(10.75, 2)).toBe('10,75');
    expect(formatNumber(7.2, 2)).toBe('7,20');
    expect(formatNumber(3, 1)).toBe('3,0');
    expect(formatNumber(53)).toBe('53');
    expect(formatNumber(12345.5, 1)).toBe('12.345,5');
    expect(formatNumber(-0.001, 2)).toBe('0,00');
  });

  it('shows every IRSA value and score with one decimal', () => {
    expect(formatIndex(10.75)).toBe('10,8');
    expect(formatIndex(2.8)).toBe('2,8');
    expect(formatIndex(0)).toBe('0,0');
  });

  it('writes percentages with the comma and a space before the sign', () => {
    expect(plain(formatPercent(100))).toBe('100,0 %');
    expect(plain(formatPercent(66.666))).toBe('66,7 %');
    expect(plain(formatPercent(25, 0))).toBe('25 %');
    expect(formatPercent(25, 0)).toBe('25\u00a0%');
  });

  it('shows weights as shares that add up to exactly 100 %', () => {
    const weights = [0.1666667, 0.1666667, 0.1666667, 0.1666667, 0.1666667, 0.1666665];
    const shares = formatShares(weights).map(plain);
    expect(shares).toEqual(['16,7 %', '16,7 %', '16,7 %', '16,7 %', '16,6 %', '16,6 %']);
    const total = shares.reduce((sum, s) => sum + Number(s.replace(' %', '').replace(',', '.')), 0);
    expect(Math.round(total * 10) / 10).toBe(100);
    expect(formatShares([0.5, 0.25, 0.25]).map(plain)).toEqual(['50,0 %', '25,0 %', '25,0 %']);
    expect(formatShares([0, 0]).map(plain)).toEqual(['0,0 %', '0,0 %']);
    // Weights inside the 0,02 tolerance add up to their own total, not to a forced 100 %.
    expect(formatShares([0.5, 0.49]).map(plain)).toEqual(['50,0 %', '49,0 %']);
  });
});

/** Every UI source file except this formatter: components, models and helpers, not their tests. */
const uiSources = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return uiSources(path);
    return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [path] : [];
  });

// functional-10 T1 and T2: dates and numbers reach people only through this module, so the
// browser's timezone and locale defaults never decide what a screen shows.
it('leaves no toLocaleDateString or toLocaleString outside the shared formatter', () => {
  const root = join(process.cwd(), 'src');
  const found = uiSources(root)
    .filter((file) => relative(root, file) !== join('shared', 'lib', 'format.ts'))
    .flatMap((file) =>
      readFileSync(file, 'utf8')
        .split('\n')
        .flatMap((line, index) =>
          /\.toLocale(?:Date|Time)?String\(|\.toFixed\((?!5\))/.test(line)
            ? [`${relative(root, file)}:${index + 1}: ${line.trim()}`]
            : [],
        ),
    );
  expect(found).toEqual([]);
});
