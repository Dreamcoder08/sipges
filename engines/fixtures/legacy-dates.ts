/**
 * Writes engines/fixtures/legacy-dates.tsv: what Node's `new Date(text)` returns for timestamp
 * shapes the legacy columns may hold, generated from a fixed seed, so the Rust port of V8's date
 * parser (crates/migrate-legacy/src/js_date.rs) is pinned to observed values. Lines are
 * `<milliseconds or null>\t<text>`, with newlines, tabs and NUL escaped.
 *
 *   TZ=UTC node engines/fixtures/legacy-dates.ts
 */
import { writeFileSync } from 'node:fs';

let state = 0x5eed;
const random = (n: number) => {
  state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
  return Math.floor((state / 2 ** 32) * n);
};
const pick = <T,>(items: readonly T[]): T => items[random(items.length)] as T;
const pad = (n: number, width: number) => String(n).padStart(width, '0');

const MONTHS = ['Jan', 'feb', 'MAR', 'April', 'mayo', 'junio', 'julio', 'agosto', 'Sept', 'octubre', 'Nov', 'december'];
const WORDS = ['GMT', 'UTC', 'UT', 'Z', 'z', 'EST', 'edt', 'CST', 'CDT', 'MST', 'MDT', 'PST', 'pdt', 'AM', 'pm', 'T', 't', 'Thu', 'lunes', 'x', 'ayer', 'Thursday,'];
const SEPARATORS = [' ', ' ', ' ', '  ', '-', '/', '.', ',', ', ', 'T', '\t', '\n', ':', '+', '(', ')', '(x)', '\u00a0', '\u3000', '\ufeff', '\u2028', 'é', '[', '_'];
const TIMES = ['09:00', '09:00:00', '9:5', '9:05:07.5', '09:00:00.123456', '23:59:59.999', '24:00', '24:00:00', '24:00:01', '25:00', '12:60', '12:00:60', '1::', '12:', '10.5', '12:30 PM', '12:30 am', '13:00 pm', '00:00 AM'];
const ZONES = ['Z', 'z', '+05:30', '-03:00', '+0530', '-0300', '+05', '-3', '+5:30', 'GMT+1', 'UTC-0800', 'GMT', '+123', '-12345', '+99:99', '+24:00', ' (hora local)'];

const isoDate = () => {
  const year = pick([pad(random(10000), 4), `+${pad(random(300000), 6)}`, `-${pad(random(300000), 6)}`, '2026', '1970', '0000']);
  const month = pick(['', `-${pad(random(14), 2)}`, `-${pad(1 + random(12), 2)}`]);
  const day = month ? pick(['', `-${pad(random(34), 2)}`, `-${pad(1 + random(28), 2)}`]) : '';
  return `${year}${month}${day}`;
};

const legacyDate = () => {
  const y = pick([String(1900 + random(200)), String(random(100)), pad(random(100), 2), String(random(1_000_000)), '0', '49', '50', '99', '100']);
  const m = String(1 + random(13));
  const d = String(1 + random(32));
  return pick([
    `${m}/${d}/${y}`,
    `${y}/${m}/${d}`,
    `${d}-${m}-${y}`,
    `${y}-${m}-${d}`,
    `${pick(MONTHS)} ${d} ${y}`,
    `${d} ${pick(MONTHS)} ${y}`,
    `${y} ${pick(MONTHS)} ${d}`,
    `${pick(MONTHS)} ${y}`,
    `${pick(MONTHS)}-${d}-${y}`,
    `${d}-${pick(MONTHS)}-${y}`,
    `${m} ${d}`,
    y,
    d,
  ]);
};

const shape = (): string => {
  switch (random(7)) {
    case 0:
      return `${isoDate()}T${pick(TIMES)}${pick(['', ...ZONES])}`;
    case 1:
      return `${isoDate()}${pick(['Z', '', ' ', 'z'])}`;
    case 2:
      return `${legacyDate()}${pick(SEPARATORS)}${pick(TIMES)}${pick(['', ' ', ...ZONES])}`;
    case 3:
      return `${pick(WORDS)}${pick(SEPARATORS)}${legacyDate()}${pick(['', ' ', ...ZONES])}`;
    case 4:
      return `${legacyDate()}${pick(SEPARATORS)}${pick(WORDS)}${pick(['Z', ''])}`;
    case 5:
      return Array.from({ length: 1 + random(6) }, () =>
        pick([pick(WORDS), pick(SEPARATORS), pick(TIMES), pick(ZONES), String(random(3000)), pick(MONTHS)]),
      ).join('');
    default:
      return `${isoDate()}${pick(SEPARATORS)}${pick(TIMES)}Z`;
  }
};

const fixed = [
  '', ' ', 'Z', 'T', '0', '00', '000', '0000', '00000', '000000', '0Z', '5Z', '13Z', '32Z', '100Z', '2026Z',
  '2026-10-01Z', '2026-02-31Z', '2026-13-01Z', '2026-10-32Z', '2026-10-01T09:00:00Z', '-000000-01-01T00:00:00Z',
  '+275760-09-13T00:00:00.000Z', '+275760-09-13T00:00:00.001Z', '-271821-04-20T00:00:00.000Z', '-271821-04-19T23:59:59.999Z',
  '2026-10-01T09:00:00.0000000001Z', '2026-10-01T09:00:00.Z', '12345678901234567890', '(((', '(a(b)c) 2026Z', ')2026', '2026)',
  '1 2 3 4Z', '1:2:3:4:5Z', '1:2:3.4.5Z', '12:30:15.1234 2026-10-01', '2026-10-01\u0000garbage', '\u0000', 'Jan\u00002026',
];

const lines = new Map<string, number | null>();
for (const text of fixed) lines.set(text, null);
while (lines.size < 6000) lines.set(shape(), null);

const escape = (text: string) =>
  text.replaceAll('\n', '\\n').replaceAll('\t', '\\t').replaceAll('\u0000', '\\0');
const body = [...lines.keys()]
  .filter((text) => !text.includes('\\'))
  .map((text) => {
    const time = new Date(text).getTime();
    return `${Number.isNaN(time) ? 'null' : time}\t${escape(text)}`;
  })
  .join('\n');
writeFileSync(new URL('legacy-dates.tsv', import.meta.url), `${body}\n`);
