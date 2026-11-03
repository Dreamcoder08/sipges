#!/usr/bin/env node
// Fails when a feature document repeats a task id under "## Tasks" or a log id under "## Log".
// Feature documents are append-only logs merged with git's union driver (.gitattributes), which
// keeps both sides of a conflict and can therefore duplicate an entry or reuse a number.
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Duplicates that predate this check, kept as history rather than rewritten.
const KNOWN = {
  'compact-sidebar.md': { Tasks: ['T1'] },
  'typescript-hexagonal-migration.md': { Log: ['L40', 'L45', 'L49'] },
};

const section = (text, title) => {
  const match = text.match(new RegExp(`^## ${title}\\n([\\s\\S]*?)(?=^## |(?![\\s\\S]))`, 'm'));
  return match ? match[1] : '';
};

const repeated = (body, prefix) => {
  const ids = [...body.matchAll(new RegExp(`^- (${prefix}\\d+[a-z]?)\\b`, 'gm'))].map((m) => m[1]);
  return [...new Set(ids.filter((id, i) => ids.indexOf(id) !== i))];
};

/** Returns one message per duplicated id across the feature documents in `dir`. */
export const duplicateIds = (dir) => {
  const problems = [];
  for (const file of readdirSync(dir)
    .filter((f) => f.endsWith('.md'))
    .sort()) {
    const text = readFileSync(path.join(dir, file), 'utf8');
    for (const [title, prefix] of [
      ['Tasks', 'T'],
      ['Log', 'L'],
    ]) {
      const known = KNOWN[file]?.[title] ?? [];
      for (const id of repeated(section(text, title), prefix)) {
        if (!known.includes(id))
          problems.push(`${file}: ${id} appears more than once under "## ${title}"`);
      }
    }
  }
  return problems;
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const dir = path.resolve(process.argv[2] ?? 'odd/tasks');
  const problems = duplicateIds(dir);
  for (const problem of problems) console.error(problem);
  if (problems.length > 0) {
    console.error('Renumber the later entry (next free id) and keep the earlier one.');
    process.exit(1);
  }
  console.log(`odd ids: no duplicates in ${path.relative(process.cwd(), dir) || '.'}`);
}
