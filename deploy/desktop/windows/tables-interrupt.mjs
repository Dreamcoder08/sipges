// deploy/desktop/migration/tables.mjs interrupted for real in the middle of a run, as a person
// does with Ctrl+C: the run must remove every scratch copy, end with `RESULT: not compared
// (interrupted)` and exit 2, and both input folders stay byte-identical (functional-10 T11).
//
// On Windows the interrupt is a real console Ctrl+C: tables-interrupt.ps1 starts tables.mjs in a
// console of its own and sends CTRL_C_EVENT with GenerateConsoleCtrlEvent once the copy has
// begun (Node's child.kill() ends a Windows process outright, it delivers no signal). Elsewhere
// it is SIGINT, which is what Ctrl+C sends there. Closing the console window is not driven:
// GenerateConsoleCtrlEvent cannot send CTRL_CLOSE_EVENT, and closing a real console window on a
// runner depends on the terminal host and on Windows ending the processes seconds later.
//
// Synthetic state folders only, built like tables-drill.mjs builds them (every migration of this
// checkout, rows holding a marker), with a 96 MiB filler in the second database folder so the copy
// is still in flight when the interrupt lands. Everything lives under <work>\tables-interrupt.
//
//   node deploy/desktop/windows/tables-interrupt.mjs [--work <folder>] [--logs <folder>]
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { cp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';
import console from 'node:console';
import { Buffer } from 'node:buffer';
import { clearTimeout, setTimeout } from 'node:timers';
import { digest, tree } from '../migration/rehearse.mjs';
import {
  MARK,
  TABLES,
  buildState,
  checkoutPGlite,
  closedPort,
  driveFormat,
  lastLine,
  report,
} from './tables-drill.mjs';

const here = dirname(fileURLToPath(import.meta.url));
export const HELPER = join(here, 'tables-interrupt.ps1');
export const INTERRUPTED = 'RESULT: not compared (interrupted)';
const FILLER_BYTES = 96 * 1024 ** 2;
const TIMEOUT_MS = 120_000;

/** The scratch copy of a run that has begun copying: a sipges-tables-* folder holding `before`. */
async function copyInFlight(scratch) {
  for (const name of await readdir(scratch).catch(() => []))
    if (name.startsWith('sipges-tables-') && existsSync(join(scratch, name, 'before')))
      return join(scratch, name);
  return null;
}

/**
 * POSIX: tables.mjs as a child, SIGINT once its copy has begun. Returns what the Windows helper
 * reports: `{ sent, copySeen, exitCode, stdout, stderr, error }`.
 */
export async function sigint({ node = process.execPath, args, scratch, timeoutMs = TIMEOUT_MS }) {
  const child = spawn(node, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  let [stdout, stderr] = ['', ''];
  child.stdout.setEncoding('utf8').on('data', (chunk) => (stdout += chunk));
  child.stderr.setEncoding('utf8').on('data', (chunk) => (stderr += chunk));
  const closed = once(child, 'close');
  const deadline = Date.now() + timeoutMs;
  let copySeen = null;
  while (!copySeen && child.exitCode === null && Date.now() < deadline) {
    copySeen = await copyInFlight(scratch);
    if (!copySeen) await new Promise((done) => setTimeout(done, 5));
  }
  const sent = Boolean(copySeen) && child.exitCode === null && child.kill('SIGINT');
  const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
  const [code, signal] = await closed;
  clearTimeout(timer);
  return {
    sent,
    copySeen,
    exitCode: code ?? `none (ended by ${signal})`,
    stdout,
    stderr,
    error: null,
  };
}

/** Windows: tables-interrupt.ps1 in Windows PowerShell 5.1 sends a console Ctrl+C. */
export async function consoleCtrlC({
  node = process.execPath,
  args,
  scratch,
  reportFile,
  timeoutMs = TIMEOUT_MS,
}) {
  const helper = spawn(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', HELPER],
    {
      stdio: ['ignore', 'pipe', 'pipe'],
      // A hidden console of its own for the helper; it replaces it with a fresh one anyway.
      windowsHide: true,
      // Without PowerShell 7's module path, which Windows PowerShell 5.1 must not load from.
      env: {
        ...Object.fromEntries(
          Object.entries(process.env).filter(([key]) => key.toUpperCase() !== 'PSMODULEPATH'),
        ),
        TI_NODE: node,
        TI_ARGS_JSON: JSON.stringify(args),
        TI_SCRATCH: scratch,
        TI_REPORT: reportFile,
        TI_TIMEOUT_MS: String(timeoutMs),
      },
    },
  );
  let output = '';
  helper.stdout.setEncoding('utf8').on('data', (chunk) => (output += chunk));
  helper.stderr.setEncoding('utf8').on('data', (chunk) => (output += chunk));
  const [code] = await once(helper, 'close');
  const text = await readFile(reportFile, 'utf8').catch(() => null);
  if (code !== 0 || text === null)
    throw new Error(
      `tables-interrupt.ps1 failed (exit ${code}, report ${text === null ? 'missing' : 'written'}):\n${output}`,
    );
  return JSON.parse(text.replace(/^\uFEFF/, ''));
}

/**
 * The drill. `say` and `check` print as drill.mjs does; `log(name)` names the file the run's
 * report is written to. `interrupt` defaults to the console Ctrl+C on Windows, SIGINT elsewhere.
 */
export async function interruptDrill({
  work,
  say,
  check,
  log = null,
  script = TABLES,
  platform = process.platform,
  interrupt = platform === 'win32' ? consoleCtrlC : sigint,
  fileSystem = driveFormat,
  timeoutMs = TIMEOUT_MS,
}) {
  const dir = join(work, 'tables-interrupt');
  const scratch = join(dir, 'scratch');
  await mkdir(scratch, { recursive: true });
  if (platform === 'win32') {
    const format = fileSystem(dir);
    check(format === 'NTFS', `the drive of ${dir} is NTFS (${format || 'not read'})`);
  } else say(`not Windows (${platform}): SIGINT stands for Ctrl+C, the file system is not checked`);
  say(
    platform === 'win32'
      ? 'interrupt: a console Ctrl+C (GenerateConsoleCtrlEvent CTRL_C_EVENT in the console of tables.mjs)'
      : 'interrupt: SIGINT (what Ctrl+C sends on this system)',
  );

  const PGlite = await checkoutPGlite();
  const before = await buildState(PGlite, join(dir, 'before'));
  const after = join(dir, 'after');
  await cp(before, after, { recursive: true, errorOnExist: true, force: false });
  await writeFile(join(after, 'pglite', 'filler.bin'), Buffer.alloc(FILLER_BYTES));
  const digests = [digest(await tree(before)), digest(await tree(after))];
  check(
    true,
    `synthetic state folders built (a ${FILLER_BYTES / 1024 ** 2} MiB filler keeps the copy in flight)`,
  );

  const port = String(await closedPort());
  const args = [script, '--before', before, '--after', after, '--scratch', scratch, '--port', port];
  say(`tables.mjs run: ${script}`);
  const reportFile = join(dir, 'helper-report.json');
  const result = await interrupt({ args, scratch, reportFile, timeoutMs });
  const run = { code: result.exitCode, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
  const text = report(run);
  if (log) await writeFile(log('interrupted'), `${text}\n`);
  say('tables.mjs interrupted:');
  for (const line of text.split(/\r?\n/)) say(`  | ${line}`);
  // A failed check carries the run's exit code, stdout and stderr, and what the helper saw.
  const expect = (ok, label) => {
    if (!ok)
      throw new Error(
        `Check failed: ${label}\n${text}\nhelper: ${JSON.stringify({ ...result, stdout: undefined, stderr: undefined })}`,
      );
    check(true, label);
  };
  expect(!result.error, `the interrupt helper reported no error (${result.error ?? 'none'})`);
  expect(
    Boolean(result.copySeen),
    `the run began copying before the interrupt (${result.copySeen ?? 'never'})`,
  );
  expect(result.sent === true, 'the interrupt was sent while the run was copying');
  expect(run.code === 2, `interrupted run: exit 2 (got ${run.code})`);
  expect(lastLine(run.stdout) === INTERRUPTED, `interrupted run: last line ${INTERRUPTED}`);
  // By name: tables.mjs prints the real path of --scratch, which may be spelled otherwise.
  expect(
    run.stderr
      .split(/\r?\n/)
      .some(
        (line) =>
          line.startsWith('Interrupted: removing the scratch copy ') &&
          line.includes(basename(result.copySeen)),
      ),
    'interrupted run: it said it was removing the scratch copy it had begun',
  );
  const left = await readdir(scratch);
  expect(left.length === 0, `interrupted run: scratch empty afterwards (${left.join(', ')})`);
  expect(
    digest(await tree(before)) === digests[0],
    `interrupted run: ${before} byte-identical afterwards`,
  );
  expect(
    digest(await tree(after)) === digests[1],
    `interrupted run: ${after} byte-identical afterwards`,
  );
  expect(!`${run.stdout}${run.stderr}`.includes(MARK), 'interrupted run: no seeded value printed');
  say('tables.mjs: Ctrl+C mid-copy left no copy and both inputs unchanged');
  return { interrupt: platform === 'win32' ? 'console Ctrl+C' : 'SIGINT' };
}

/** --work and --logs, each at most once; defaults under the temp folder. */
export function parseOptions(args, { now = new Date(), tmp = tmpdir() } = {}) {
  const names = { '--work': 'work', '--logs': 'logs' };
  const options = {};
  for (let i = 0; i < args.length; i += 2) {
    const name = names[args[i]];
    if (!name || args[i + 1] === undefined || name in options)
      throw new Error(`invalid option ${args[i]}; use --work <folder> [--logs <folder>]`);
    options[name] = resolve(args[i + 1]);
  }
  const stamp = now
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d+Z$/, 'Z');
  const work = options.work ?? join(tmp, `sipges-tables-interrupt-${stamp}`);
  return { work, logs: options.logs ?? join(work, 'logs') };
}

async function main(args) {
  const { work, logs } = parseOptions(args);
  await mkdir(logs, { recursive: true });
  const say = (line = '') => console.log(line);
  const check = (ok, label) => {
    if (!ok) throw new Error(`Check failed: ${label}`);
    say(`ok - ${label}`);
  };
  await interruptDrill({ work, say, check, log: (name) => join(logs, `tables-${name}.txt`) });
  say('\nTABLES INTERRUPT DRILL PASSED');
  say(`work folder kept (synthetic data only): ${work}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(`TABLES INTERRUPT DRILL FAILED: ${error.message}`);
    process.exitCode = 1;
  });
}
