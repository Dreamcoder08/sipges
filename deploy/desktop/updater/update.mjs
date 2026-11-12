// CLI: install, update or recover a managed desktop install from a local signed release.
// Stop SIPGES before running it: the state folder must not change while it is copied.
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';
import console from 'node:console';
import { bootCheck } from './boot.mjs';
import { PUBLIC_KEY, loadPublicKey } from './release.mjs';
import {
  acceptRestoredState,
  firstStart,
  install,
  readCurrent,
  recover,
  update,
} from './updater.mjs';

const USAGE = `Usage: node deploy/desktop/updater/update.mjs --install <root> --release <dir> [--state <dir>] [--adopt <old package dir>] [--trust-key <public.pem> | --trust-release-key]
       node deploy/desktop/updater/update.mjs --install <root> --recover [--accept-restored-state]
       node deploy/desktop/updater/update.mjs --install <root> --first-start

First install: --state and a trust key are required: --trust-key names the public key file, or
--trust-release-key trusts the key that signed this release and prints its SHA-256 fingerprint.
Old plain package: --adopt and --state (and --trust-key when it has no update key); its first
update rehearses on a copy of the state.
--recover finishes an interrupted update. When it cannot (exit code 3), restore the state folder
from your own backup, then --recover --accept-restored-state makes the version from before the
update current again without touching the state folder (refused while it is missing or empty).
--first-start does now, in this terminal, what the launcher does at the first start: a state
folder that already holds a database gets a dated pre-update copy, the migration runs on a
second copy and only then on the state folder. Done once; later runs change nothing.
Exit codes: 0 done, 1 refused or invalid, 2 failed and rolled back, 3 rollback incomplete.`;

const VALUED = ['--install', '--release', '--state', '--adopt', '--trust-key'];
const FLAGS = {
  '--recover': 'recover',
  '--accept-restored-state': 'accept',
  '--trust-release-key': 'trustRelease',
  '--first-start': 'firstStart',
};

function parse(args) {
  const options = {};
  for (let i = 0; i < args.length; i += 1) {
    const key = args[i];
    const flag = FLAGS[key];
    if (flag && !options[flag]) {
      options[flag] = true;
      continue;
    }
    const value = args[i + 1];
    if (!VALUED.includes(key) || !value || value.startsWith('--') || options[key])
      throw new Error('Invalid options; use --help');
    options[key] = value;
    i += 1;
  }
  if (!options['--install']) throw new Error('Missing --install');
  if (options.accept && !options.recover)
    throw new Error('--accept-restored-state goes with --recover');
  if (options.trustRelease && options['--trust-key'])
    throw new Error('Use either --trust-key or --trust-release-key');
  return options;
}

/** The public key shipped inside the release, with the fingerprint the operator can compare. */
async function releaseKey(release) {
  const pem = await readFile(join(release, 'package', PUBLIC_KEY), 'utf8');
  const der = loadPublicKey(pem).export({ type: 'spki', format: 'der' });
  console.log(
    `Trusting the update key that signed this release (SHA-256 ${createHash('sha256').update(der).digest('hex')}).`,
  );
  return pem;
}

async function main(args) {
  if (args.length === 1 && args[0] === '--help') return console.log(USAGE);
  const options = parse(args);
  const root = resolve(options['--install']);
  if (options.firstStart) {
    if (Object.keys(options).length !== 2) throw new Error('--first-start takes only --install');
    const result = await firstStart({
      root,
      migrate: bootCheck({ logFile: join(root, 'update-boot.log') }),
    });
    console.log(
      !result.done
        ? `First start already done for ${result.version}; nothing changed.`
        : result.preUpdateCopy
          ? `First start of ${result.version} done. Pre-update copy: ${result.preUpdateCopy}`
          : `First start of ${result.version} recorded; no existing database.`,
    );
    return;
  }
  if (options.recover) {
    if (Object.keys(options).length !== (options.accept ? 3 : 2))
      throw new Error('--recover takes only --install and --accept-restored-state');
    if (options.accept) {
      const accepted = await acceptRestoredState({ root });
      console.log(
        accepted.accepted
          ? `Accepted the restored state folder; current version ${accepted.version}.`
          : `Nothing to recover; current version ${accepted.version}.`,
      );
      return;
    }
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
  const state = options['--state'] ? resolve(options['--state']) : undefined;
  const current = await readCurrent(root);
  if (options.trustRelease && (current || options['--adopt']))
    throw new Error('--trust-release-key is only for a first install');
  const trustKey = options['--trust-key']
    ? await readFile(resolve(options['--trust-key']), 'utf8')
    : options.trustRelease
      ? await releaseKey(release)
      : undefined;
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
