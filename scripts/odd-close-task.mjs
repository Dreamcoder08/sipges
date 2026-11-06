#!/usr/bin/env node
/**
 * Closes an ODD task: marks `- <task> [ ]` as done, points its `commit:` at the next log entry
 * and appends the entry after the highest-numbered one, in that entry's style: `- L<n> (label): text`,
 * `- L<n> — label: text` or `- L<n>: label: text`. With --log-only it appends the entry alone.
 *
 *   node scripts/odd-close-task.mjs --task T14 --label "T14 E2E" --text "..." --file odd/tasks/x.md [--dry-run]
 *   node scripts/odd-close-task.mjs --log-only --label "Decision" --text "..." --file odd/tasks/x.md [--dry-run]
 *   --text @path reads the entry from a file.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';

const { values } = parseArgs({
  options: {
    task: { type: 'string' },
    label: { type: 'string' },
    text: { type: 'string' },
    file: { type: 'string' },
    'log-only': { type: 'boolean', default: false },
    'dry-run': { type: 'boolean', default: false },
  },
});
const { task, label, file } = values;
const logOnly = values['log-only'];
const validTask = logOnly ? !task : Boolean(task && /^T\d+[a-z]?$/.test(task));
if (!validTask || !file || !label?.trim() || /[\r\n]/.test(label) || !values.text) {
  console.error(
    'usage: (--task T<n> | --log-only) --label <label> --text <entry|@file> --file <doc> [--dry-run]',
  );
  process.exit(2);
}
const text = (
  values.text.startsWith('@') ? readFileSync(values.text.slice(1), 'utf8') : values.text
)
  .replace(/\s+/g, ' ')
  .trim();

if (!text) throw new Error('ODD evidence must not be blank');

const lines = readFileSync(file, 'utf8').split('\n');
const entries = lines
  .map((line, index) => {
    const match = /^- L(\d+)( \(| — |:)/.exec(line);
    return { index, n: Number(match?.[1] ?? NaN), separator: match?.[2] };
  })
  .filter((e) => !Number.isNaN(e.n));
if (entries.length === 0) throw new Error(`no log entries (- L<n>) in ${file}`);
const last = entries.reduce((a, b) => (b.n > a.n ? b : a));
const next = last.n + 1;

const entry = (() => {
  if (last.separator === ' (') return `- L${next} (${label}): ${text}`;
  if (last.separator === ' — ') return `- L${next} — ${label}: ${text}`;
  return `- L${next}: ${label}: ${text}`;
})();

let closed;
if (!logOnly) {
  const taskLine = new RegExp(`^(\\s*- ${task}) \\[ \\]`);
  const at = lines.findIndex((line) => taskLine.test(line));
  if (at === -1) throw new Error(`${task} is not an open task ("- ${task} [ ]") in ${file}`);
  lines[at] = lines[at]
    .replace(taskLine, '$1 [x]')
    .replace(/commit: pending/, `commit: see L${next}`);
  closed = lines[at];
}
lines.splice(last.index + 1, 0, entry);

if (values['dry-run']) {
  console.log([closed, entry].filter(Boolean).join('\n'));
} else {
  writeFileSync(file, lines.join('\n'));
  console.log(`${logOnly ? 'log' : `${task} closed`}; added L${next} after L${last.n} in ${file}`);
}
