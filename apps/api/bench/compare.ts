/**
 * Compares two benchmark result files written by `run.ts --out` and prints a markdown table of
 * p95 and event-loop block per scenario, flagging rows that trip the ADR 0005 gate.
 *
 *   node bench/compare.ts before.json after.json
 */
import { readFile } from 'node:fs/promises';
import { GATE } from './harness.ts';

type Row = { scenario: string; scale: string; p95: number; loopBlock: number };
type Results = { results: Row[] };

const [beforePath, afterPath] = process.argv.slice(2);
if (!beforePath || !afterPath) {
  console.error('usage: node bench/compare.ts <before.json> <after.json>');
  process.exit(2);
}
const load = async (path: string) => JSON.parse(await readFile(path, 'utf8')) as Results;
const [before, after] = await Promise.all([load(beforePath), load(afterPath)]);

// Scale labels carry the record count ("10× (4840 records)"); compare on the multiplier only.
const key = (r: Row) => `${r.scenario} | ${r.scale.split(' (')[0] ?? r.scale}`;
const old = new Map(before.results.map((r) => [key(r), r]));
const trips = (r: Row) => r.p95 > GATE.p95 || r.loopBlock > GATE.loopBlock;
const delta = (a: number | undefined, b: number) =>
  a === undefined
    ? 'new'
    : `${b - a >= 0 ? '+' : ''}${(((b - a) / Math.max(a, 0.01)) * 100).toFixed(0)}%`;

console.log(
  '| Scenario | Scale | p95 before → after (ms) | Loop block before → after (ms) | Gate |',
);
console.log('| --- | --- | --- | --- | --- |');
for (const r of after.results) {
  const b = old.get(key(r));
  console.log(
    `| ${r.scenario} | ${key(r).split(' | ')[1]} | ${b?.p95 ?? '–'} → ${r.p95} (${delta(b?.p95, r.p95)}) | ${b?.loopBlock ?? '–'} → ${r.loopBlock} (${delta(b?.loopBlock, r.loopBlock)}) | ${trips(r) ? 'TRIPS' : 'ok'} |`,
  );
}
const tripped = after.results.filter(trips).filter((r) => r.scale.startsWith('10×'));
process.exitCode = tripped.length > 0 ? 1 : 0;
