#!/usr/bin/env node
/**
 * Summarises every ODD feature document: title, closed/total tasks and the open tasks, so resuming
 * work ("continúa con ODD") does not mean reading each file. Accepts every task style in use:
 * `- T2 [ ] …`, `- [ ] P3 …`, `- T2 [done|dropped|pending…] …` and `- T2 — … Done: …` (a dash-style
 * task is closed once it records `Done:` or `Status: done`).
 *
 *   node scripts/odd-status.mjs [--dir odd/tasks] [--all] [--json]
 */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';

const { values } = parseArgs({
  options: {
    dir: { type: 'string', default: 'odd/tasks' },
    all: { type: 'boolean', default: false },
    json: { type: 'boolean', default: false },
  },
});

const task = /^\s*- (?:([A-Z]+\d+[a-z]?) \[([ x])\]|\[([ x])\] ([A-Z]+\d+[a-z]?))\s*(.*)$/;
const worded = /^\s*- (T\d+[a-z]?) \[([a-z][^\]]*)\]\s*(.*)$/;
const dashed = /^\s*- (T\d+[a-z]?) — (.*)$/;
const parse = (line) => {
  let m = task.exec(line);
  if (m) return { id: m[1] ?? m[4], done: (m[2] ?? m[3]) === 'x', rest: m[5] };
  m = worded.exec(line);
  if (m) return { id: m[1], done: /^(done|dropped)\b/.test(m[2]), rest: m[3] };
  m = dashed.exec(line);
  if (m) return { id: m[1], done: /(^|\s)Done:|Status: done\b/.test(m[2]), rest: m[2] };
  return undefined;
};
const summary = (rest) => {
  const text = rest
    .replace(/^[—:]\s*/, '')
    .replace(/;\s*(route|commit):.*$/, '')
    .replace(/\s*commit:.*$/i, '');
  return text.length > 90 ? `${text.slice(0, 89)}…` : text;
};

const features = readdirSync(values.dir)
  .filter((name) => name.endsWith('.md'))
  .sort()
  .map((file) => {
    const lines = readFileSync(path.join(values.dir, file), 'utf8').split('\n');
    const title =
      lines
        .find((line) => line.startsWith('# '))
        ?.slice(2)
        .trim() ?? file;
    const tasks = lines.flatMap((line) => {
      const t = parse(line);
      return t ? [{ id: t.id, done: t.done, text: summary(t.rest) }] : [];
    });
    const open = tasks.filter((t) => !t.done).map(({ id, text }) => ({ id, text }));
    return { file, title, done: tasks.length - open.length, total: tasks.length, open };
  });

if (values.json) {
  console.log(JSON.stringify(features, null, 2));
} else {
  const shown = values.all ? features : features.filter((f) => f.open.length > 0);
  for (const f of shown) {
    console.log(`${f.title} (${f.file}): ${f.done}/${f.total}`);
    for (const t of f.open) console.log(`  - ${t.id} — ${t.text}`);
  }
  const closed = features.filter((f) => f.open.length === 0).length;
  if (!values.all)
    console.log(`${closed} ODD cerrado${closed === 1 ? '' : 's'} (--all para verlos)`);
}
