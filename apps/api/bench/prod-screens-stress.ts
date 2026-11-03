/**
 * Authenticated, read-only screen stress against a deployed SIPGES (production: Worker +
 * Hyperdrive + Neon). It signs in a synthetic load account with password and TOTP, selects a
 * project, and opens screens like the browser does: every GET a screen fires, in parallel, then
 * the next screen, at increasing concurrency. It stops as soon as more than 20 % of requests fail.
 *
 *   node bench/prod-screens-stress.ts --env-file ~/.config/sipges-carga.env \
 *     [--steps 1,4,8] [--step-seconds 20] [--label after-200] [--out result.json]
 *
 * Settings (environment variables, or the env file; the environment wins):
 * SIPGES_LOAD_BASE_URL, SIPGES_LOAD_USER, SIPGES_LOAD_PASSWORD, SIPGES_LOAD_TOTP (base32),
 * SIPGES_LOAD_SCOPE. The account must have the `consulta` role. Response bodies are drained and
 * discarded; output is JSON (stdout or --out) and a short Spanish summary on stderr.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { performance } from 'node:perf_hooks';
import { parseArgs } from 'node:util';
import {
  SCREENS,
  httpProbe,
  loadConfig,
  login,
  logout,
  parseEnvFile,
  runSteps,
  summarize,
} from './prod-screens.ts';

const MAX_SCREENS = 32;
const MAX_STEP_SECONDS = 120;
const REQUEST_TIMEOUT_MS = 45_000;
const ABORT_ERROR_RATE = 0.2;

// `pnpm run bench:prod-screens -- --flag` forwards the separator itself.
const argv = process.argv.slice(2);
const { values } = parseArgs({
  args: argv[0] === '--' ? argv.slice(1) : argv,
  options: {
    'env-file': { type: 'string' },
    steps: { type: 'string', default: '1,4,8' },
    'step-seconds': { type: 'string', default: '20' },
    label: { type: 'string', default: 'run' },
    out: { type: 'string' },
  },
});

const steps = values.steps.split(',').map(Number);
if (!steps.every((n) => Number.isInteger(n) && n >= 1 && n <= MAX_SCREENS))
  throw new Error(`--steps must be integers from 1 to ${MAX_SCREENS}, e.g. 1,4,8`);
const stepSeconds = Number(values['step-seconds']);
if (!(stepSeconds > 0 && stepSeconds <= MAX_STEP_SECONDS))
  throw new Error(`--step-seconds must be between 1 and ${MAX_STEP_SECONDS}`);

const envFile = values['env-file']?.replace(/^~(?=\/)/, homedir());
const fromFile = envFile ? parseEnvFile(readFileSync(envFile, 'utf8')) : {};
const config = loadConfig({ ...fromFile, ...process.env });

const session = await login(config, fetch, Date.now());
const startedAt = new Date().toISOString();
let run;
try {
  run = await runSteps({
    screens: SCREENS,
    steps,
    stepMs: stepSeconds * 1000,
    abortErrorRate: ABORT_ERROR_RATE,
    get: httpProbe(config.baseUrl, session.cookie, fetch, REQUEST_TIMEOUT_MS),
    now: () => performance.now(),
  });
} finally {
  await logout(config, fetch, session.cookie);
}

const report = {
  label: values.label,
  startedAt,
  finishedAt: new Date().toISOString(),
  stepSeconds,
  abortErrorRate: ABORT_ERROR_RATE,
  screens: SCREENS,
  ...run,
};
console.error(summarize(values.label, run));
const json = JSON.stringify(report, null, 2);
if (values.out) writeFileSync(values.out, `${json}\n`);
else console.log(json);
if (run.stopped) process.exitCode = 1;
