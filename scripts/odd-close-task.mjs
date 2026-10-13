#!/usr/bin/env node
/**
 * Closes an ODD task: marks `- <task> [ ]` as done, points its `commit:` at the next log entry
 * and appends `- L<n> (<label>): <text>` after the highest-numbered log entry.
 *
 *   node scripts/odd-close-task.mjs --task T14 --label "T14 E2E" --text "..." [--file odd/tasks/x.md] [--dry-run]
 *   --text @path reads the entry from a file.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';

const { values } = parseArgs({
  options: {
    task: { type: 'string' },
    label: { type: 'string' },
    text: { type: 'string' },
    file: { type: 'string', default: 'odd/tasks/typescript-hexagonal-migration.md' },
    'dry-run': { type: 'boolean', default: false },
  },
});
const { task, label, file } = values;
if (!task || !/^T\d+[a-z]?$/.test(task) || !label || !values.text) {
  console.error('usage: --task T<n> --label <label> --text <entry|@file> [--file] [--dry-run]');
  process.exit(2);
}
const text = (
  values.text.startsWith('@') ? readFileSync(values.text.slice(1), 'utf8') : values.text
)
  .replace(/\s+/g, ' ')
  .trim();

const lines = readFileSync(file, 'utf8').split('\n');
const entries = lines
  .map((line, index) => ({ index, n: Number(/^- L(\d+) \(/.exec(line)?.[1] ?? NaN) }))
  .filter((e) => !Number.isNaN(e.n));
if (entries.length === 0) throw new Error(`no log entries (- L<n> (...)) in ${file}`);
const last = entries.reduce((a, b) => (b.n > a.n ? b : a));
const next = last.n + 1;

const taskLine = new RegExp(`^(\\s*- ${task}) \\[ \\]`);
const at = lines.findIndex((line) => taskLine.test(line));
if (at === -1) throw new Error(`${task} is not an open task ("- ${task} [ ]") in ${file}`);
lines[at] = lines[at]
  .replace(taskLine, '$1 [x]')
  .replace(/commit: pending/, `commit: see L${next}`);
lines.splice(last.index + 1, 0, `- L${next} (${label}): ${text}`);

if (values['dry-run']) {
  console.log(`${lines[at]}\n${lines[last.index + 1]}`);
} else {
  writeFileSync(file, lines.join('\n'));
  console.log(`${task} closed; added L${next} after L${last.n} in ${file}`);
}
