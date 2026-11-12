// CLI: install, update or recover a managed desktop install from a local signed release.
// Stop SIPGES before running it: the state folder must not change while it is copied.
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';
import console from 'node:console';
import { bootCheck } from './boot.mjs';
import { install, readCurrent, recover, update } from './updater.mjs';

const USAGE = `Usage: node deploy/desktop/updater/update.mjs --install <root> --release <dir> [--state <dir>] [--adopt <old package dir>] [--trust-key <public.pem>]
       node deploy/desktop/updater/update.mjs --install <root> --recover

First install: --state and --trust-key are required. Old plain package: --adopt and --state
(and --trust-key when it has no update key); its first update rehearses on a copy of the state.
Exit codes: 0 done, 1 refused or invalid, 2 failed and rolled back, 3 rollback incomplete.`;

const VALUED = ['--install', '--release', '--state', '--adopt', '--trust-key'];

function parse(args) {
  const options = {};
  for (let i = 0; i < args.length; i += 1) {
    const key = args[i];
    if (key === '--recover' && !options.recover) {
      options.recover = true;
      continue;
    }
    const value = args[i + 1];
    if (!VALUED.includes(key) || !value || value.startsWith('--') || options[key])
      throw new Error('Invalid options; use --help');
    options[key] = value;
    i += 1;
  }
  if (!options['--install']) throw new Error('Missing --install');
  return options;
}

async function main(args) {
  if (args.length === 1 && args[0] === '--help') return console.log(USAGE);
  const options = parse(args);
  const root = resolve(options['--install']);
  if (options.recover) {
    if (Object.keys(options).length !== 2) throw new Error('--recover takes only --install');
    const result = await recover({ root });
    console.log(
      result.recovered
        ? `Recovered: rolled back to ${result.version}.`
        : `Nothing to recover; current version ${result.version}.`,
    );
    return;
  }
  if (!options['--release']) throw new Error('Missing --release');
  const release = resolve(options['--release']);
  const trustKey = options['--trust-key']
    ? await readFile(resolve(options['--trust-key']), 'utf8')
    : undefined;
  const state = options['--state'] ? resolve(options['--state']) : undefined;
  const current = await readCurrent(root);
  if (!current && !options['--adopt']) {
    if (!state) throw new Error('Missing --state for the first install');
    const result = await install({ root, release, stateDir: state, trustKey });
    console.log(`Installed ${result.version}`);
    return;
  }
  if (state && !options['--adopt'])
    throw new Error('--state is only for a first install or --adopt');
  if (options['--adopt'] && !state) throw new Error('Missing --state for --adopt');
  const check = bootCheck({ logFile: join(root, 'update-boot.log') });
  const result = await update({
    root,
    release,
    trustKey,
    adopt: options['--adopt'] ? { dir: resolve(options['--adopt']), stateDir: state } : undefined,
    migrate: check,
    ready: check,
  });
  console.log(`Updated ${result.from} -> ${result.to}. Pre-update copy: ${result.preUpdateCopy}`);
}

const EXIT = { ROLLED_BACK: 2, ROLLBACK_INCOMPLETE: 3 };

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(`Error: ${error.message}`);
    process.exitCode = EXIT[error.code] ?? 1;
  });
}
