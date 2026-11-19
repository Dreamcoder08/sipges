// Pure parts of the desktop stack benchmark (desktop-bench.mjs): options, run order, process
// classification, memory peaks, folder sizes, seed batches and the summary. No process is started
// here, so everything runs in node --test without a server.
import { lstat, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { parseArgs } from 'node:util';

export const STACKS = Object.freeze(['ts', 'go']);
const MAX_STEP_SECONDS = 120;
const MAX_SCREENS = 32;

/** The repetition order: the stack that runs first changes on every repetition. */
export const runOrder = (rep, stacks) => (rep % 2 === 0 ? [...stacks] : [...stacks].reverse());

const integers = (text, name, min, max) => {
  const list = text.split(',').map((part) => Number(part.trim()));
  if (!list.length || !list.every((n) => Number.isInteger(n) && n >= min && n <= max))
    throw new Error(`${name} must be a comma list of integers from ${min} to ${max}`);
  return list;
};

/** Command-line options; every error names the option, never a value from a file. */
export function parseOptions(argv) {
  const { values } = parseArgs({
    args: argv[0] === '--' ? argv.slice(1) : argv,
    options: {
      sizes: { type: 'string', default: '1,10' },
      reps: { type: 'string', default: '3' },
      steps: { type: 'string', default: '1,4,8' },
      'step-seconds': { type: 'string', default: '10' },
      writes: { type: 'string', default: '40' },
      stacks: { type: 'string', default: STACKS.join(',') },
      'pg-bin': { type: 'string' },
      'bin-dir': { type: 'string' },
      work: { type: 'string' },
      out: { type: 'string' },
      label: { type: 'string', default: 'run' },
    },
  });
  const reps = Number(values.reps);
  if (!(Number.isInteger(reps) && reps >= 1 && reps <= 20)) throw new Error('--reps must be 1 to 20');
  const stepSeconds = Number(values['step-seconds']);
  if (!(stepSeconds > 0 && stepSeconds <= MAX_STEP_SECONDS))
    throw new Error(`--step-seconds must be between 1 and ${MAX_STEP_SECONDS}`);
  const writes = Number(values.writes);
  if (!(Number.isInteger(writes) && writes >= 1 && writes <= 1000))
    throw new Error('--writes must be 1 to 1000');
  const stacks = values.stacks.split(',').map((s) => s.trim());
  if (!stacks.length || !stacks.every((s) => STACKS.includes(s)) || new Set(stacks).size !== stacks.length)
    throw new Error(`--stacks must list ${STACKS.join(' and/or ')}`);
  return {
    sizes: integers(values.sizes, '--sizes', 1, 100),
    reps,
    steps: integers(values.steps, '--steps', 1, MAX_SCREENS),
    stepSeconds,
    writes,
    stacks,
    pgBin: values['pg-bin'],
    binDir: values['bin-dir'],
    work: values.work,
    out: values.out,
    label: values.label,
  };
}

const kb = (text, key) => {
  const match = new RegExp(`^${key}:\\s*(\\d+)\\s*kB`, 'm').exec(text);
  return match ? Number(match[1]) : null;
};

/** Rss and Pss of /proc/<pid>/smaps_rollup, in kB. Pss shares shared pages among processes. */
export const parseSmapsRollup = (text) => ({ rssKb: kb(text, 'Rss'), pssKb: kb(text, 'Pss') });

/** Name, parent, peak resident set (VmHWM) and resident set of /proc/<pid>/status. */
export function parseProcStatus(text) {
  const name = /^Name:\s*(.*)$/m.exec(text)?.[1]?.trim() ?? '';
  const ppid = Number(/^PPid:\s*(\d+)/m.exec(text)?.[1] ?? 0);
  return { name, ppid, hwmKb: kb(text, 'VmHWM'), rssKb: kb(text, 'VmRSS') };
}

const base = (name) => name.toLowerCase().replace(/\.exe$/, '');
const norm = (path) => path.toLowerCase().replaceAll('\\', '/').replace(/\/+$/, '');

/**
 * The processes of one stack, by role. `rootPid` is the process the benchmark spawned (node for
 * TypeScript, sipges-desktop for Go). The postmaster is found by the data folder on its command
 * line, because pg_ctl leaves it reparented outside the launcher's tree; its backends follow.
 */
export function classify(procs, rootPid, dataDir, stack) {
  const children = new Map();
  for (const p of procs) children.set(p.ppid, [...(children.get(p.ppid) ?? []), p]);
  const below = (pid) => {
    const out = [];
    const queue = [pid];
    while (queue.length)
      for (const c of children.get(queue.shift()) ?? []) {
        out.push(c);
        queue.push(c.pid);
      }
    return out;
  };
  const root = procs.find((p) => p.pid === rootPid);
  const tree = root ? [root, ...below(rootPid)] : [];
  const folder = norm(dataDir);
  const postmasters = procs.filter(
    (p) => base(p.name) === 'postgres' && norm(p.cmdline ?? '').includes(folder),
  );
  const database = [...new Map([...postmasters, ...postmasters.flatMap((p) => below(p.pid)), ...tree.filter((p) => base(p.name) === 'postgres')].map((p) => [p.pid, p])).values()];
  if (stack === 'ts') return { api: root ? [root] : [], database: [], launcher: [] };
  return {
    api: tree.filter((p) => base(p.name) === 'api'),
    database,
    launcher: tree.filter((p) => base(p.name) === 'sipges-desktop'),
  };
}

/** The peak of each role's sum over the samples, and the peak of their total. */
export function summarizeSamples(samples) {
  if (!samples.length) return { api: null, database: null, launcher: null, total: null };
  const peak = (f) => Math.max(...samples.map(f));
  return {
    api: peak((s) => s.api),
    database: peak((s) => s.database),
    launcher: peak((s) => s.launcher),
    total: peak((s) => s.api + s.database + s.launcher),
  };
}

/** Apparent bytes of every regular file below `dir` (0 when it does not exist). */
export async function folderBytes(dir) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') return 0;
    throw error;
  }
  let total = 0;
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) total += await folderBytes(path);
    else if (entry.isFile()) total += (await lstat(path)).size;
  }
  return total;
}

/** The seed rows of every module in batches, with ids `<module>-<n>` like bench/run.ts. */
export function insertBatches(records, size = 500) {
  const batches = [];
  for (const [module, rows] of Object.entries(records))
    for (let i = 0; i < rows.length; i += size)
      batches.push({
        module,
        rows: rows.slice(i, i + size).map((payload, j) => ({ id: `${module}-${i + j}`, payload })),
      });
  return batches;
}

/** Lower median: the middle value, or the lower of the two middle ones. */
const median = (values) => {
  const sorted = values.filter((v) => typeof v === 'number').sort((a, b) => a - b);
  return sorted.length ? sorted[Math.floor((sorted.length - 1) / 2)] : null;
};

/** A repetition is an outlier when it is more than 25 % away from the median of its group. */
export const OUTLIER_FRACTION = 0.25;

/**
 * Groups runs by size, stack and metric. Every repetition stays in `values`, in repetition order;
 * `outliers` names the repetitions (0-based) far from the median. Nothing is dropped.
 */
export function aggregate(runs) {
  const out = {};
  const grouped = {};
  for (const run of runs) {
    const key = `${run.size}\u0000${run.stack}`;
    (grouped[key] ??= []).push(run);
  }
  for (const group of Object.values(grouped)) {
    group.sort((a, b) => a.rep - b.rep);
    const { size, stack } = group[0];
    const metrics = new Set(group.flatMap((r) => Object.keys(r.metrics)));
    const target = ((out[size] ??= {})[stack] = {});
    for (const metric of metrics) {
      const values = group.map((r) => r.metrics[metric] ?? null);
      const mid = median(values);
      const outliers =
        mid === null || mid === 0
          ? []
          : group
              .filter((r, i) => typeof values[i] === 'number' && Math.abs(values[i] - mid) > OUTLIER_FRACTION * Math.abs(mid))
              .map((r) => r.rep);
      target[metric] = { values, median: mid, outliers };
    }
  }
  return out;
}

const cell = (m) => {
  if (!m || m.median === null) return '–';
  const text = String(m.median);
  return m.outliers.length ? `${text} (${m.values.map((v) => v ?? '–').join(' / ')})` : text;
};

/**
 * One table per size: the median of each metric for TypeScript and Go, and Go ÷ TypeScript. A cell
 * with an outlier also lists every repetition.
 */
export function renderMarkdown(agg, metrics) {
  const lines = [];
  for (const size of Object.keys(agg).sort((a, b) => Number(a) - Number(b))) {
    lines.push(`### ${size}×`, '', '| Metric | TypeScript + PGlite | Go + PostgreSQL 18 | Go ÷ TS |', '| --- | ---: | ---: | ---: |');
    for (const { key, label } of metrics) {
      const ts = agg[size].ts?.[key];
      const go = agg[size].go?.[key];
      const ratio = ts?.median && go?.median !== null && go?.median !== undefined ? (go.median / ts.median).toFixed(2) : '–';
      lines.push(`| ${label} | ${cell(ts)} | ${cell(go)} | ${ratio} |`);
    }
    lines.push('');
  }
  return lines.join('\n');
}
