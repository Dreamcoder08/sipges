// Tests for scripts/rust-tool.mjs, the launcher behind the operator tool scripts of
// apps/api/package.json. rustup, cargo and the built binary are fakes on PATH that record their
// arguments and working directory, so nothing is compiled and no database is touched.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LAUNCHER = path.join(ROOT, 'scripts', 'rust-tool.mjs');
const ENGINES = path.join(ROOT, 'engines');
const CHANNEL = /^channel\s*=\s*"([^"]+)"/m.exec(
  readFileSync(path.join(ENGINES, 'rust-toolchain.toml'), 'utf8'),
)[1];

const scratch = mkdtempSync(path.join(tmpdir(), 'rust-tool-test-'));
after(() => rmSync(scratch, { recursive: true, force: true }));

let counter = 0;
/** A PATH holding only node and the requested fakes; every fake logs one JSON line per call. */
const sandbox = ({
  rustup = true,
  toolchains = [`${CHANNEL}-x86_64-unknown-linux-gnu`],
  toolExit = 0,
} = {}) => {
  const dir = path.join(scratch, `case-${(counter += 1)}`);
  const bin = path.join(dir, 'bin');
  const target = path.join(dir, 'target');
  const caller = path.join(dir, 'caller');
  const log = path.join(dir, 'calls.log');
  mkdirSync(bin, { recursive: true });
  mkdirSync(caller);
  symlinkSync(process.execPath, path.join(bin, 'node'));
  const fake = (name, body) => {
    const file = path.join(bin, name);
    writeFileSync(
      file,
      `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ name: ${JSON.stringify(name)}, args, cwd: process.cwd() }) + '\\n');
${body}
`,
    );
    chmodSync(file, 0o755);
  };
  if (rustup) {
    fake(
      'rustup',
      `if (args[0] === 'toolchain' && args[1] === 'list') console.log(${JSON.stringify(toolchains.join('\n'))});`,
    );
  }
  // cargo build "produces" a binary that records its call and exits with toolExit.
  fake(
    'cargo',
    `const bin = args[args.indexOf('--bin') + 1];
const out = path.join(process.env.CARGO_TARGET_DIR, 'release');
fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(path.join(out, bin), ${JSON.stringify(
      `#!/usr/bin/env node
require('node:fs').appendFileSync(${JSON.stringify(log)}, JSON.stringify({ name: 'tool', args: process.argv.slice(2), cwd: process.cwd() }) + '\\n');
console.log('tool output');
process.exit(${toolExit});
`,
    )});
fs.chmodSync(path.join(out, bin), 0o755);`,
  );
  const run = (args, env = {}) => {
    const result = spawnSync(process.execPath, [LAUNCHER, ...args], {
      cwd: caller,
      encoding: 'utf8',
      env: { PATH: bin, CARGO_TARGET_DIR: target, ...env },
    });
    let calls = [];
    try {
      calls = readFileSync(log, 'utf8')
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line));
    } catch {
      // no fake was called
    }
    return { ...result, calls };
  };
  return { run, caller };
};

const DB = { SIPGES_DATABASE_URL: 'postgres://synthetic@127.0.0.1:1/none' };

test('a PGlite-only configuration stops before compiling, in Spanish, pointing at the :ts script', () => {
  const { run } = sandbox();
  const result = run(
    ['sipges-review-materialize', 'review-materialize', 'review:materialize', '--apply'],
    {
      SIPGES_PGLITE_DIR: '/synthetic/pglite',
    },
  );
  assert.equal(result.status, 2);
  assert.match(result.stderr, /herramientas Rust necesitan PostgreSQL/);
  assert.match(result.stderr, /SIPGES_DATABASE_URL/);
  assert.match(result.stderr, /review:materialize:ts/);
  assert.match(result.stderr, /pg18/);
  assert.equal(result.stdout, '');
  assert.deepEqual(result.calls, [], 'neither rustup nor cargo may run');
});

test('a PGlite directory with a database URL runs the Rust tool', () => {
  const { run } = sandbox();
  const result = run(['sipges-review-materialize', 'review-materialize', 'review:materialize'], {
    ...DB,
    SIPGES_PGLITE_DIR: '/synthetic/pglite',
  });
  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.calls.some((call) => call.name === 'tool'));
});

test('a missing rustup is reported clearly and nothing runs', () => {
  const { run } = sandbox({ rustup: false });
  const result = run(['sipges-rotate-data-key', 'rotate-data-key', 'rotate:data-key'], DB);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /rustup/);
  assert.match(result.stderr, /https:\/\/rustup\.rs/);
  assert.deepEqual(
    result.calls.filter((call) => call.name !== 'rustup'),
    [],
  );
});

test('a missing pinned toolchain is reported with the command that installs it', () => {
  const { run } = sandbox({ toolchains: ['stable-x86_64-unknown-linux-gnu'] });
  const result = run(['sipges-rotate-data-key', 'rotate-data-key', 'rotate:data-key'], DB);
  assert.equal(result.status, 1);
  assert.match(result.stderr, new RegExp(CHANNEL.replaceAll('.', '\\.')));
  assert.match(result.stderr, /rustup toolchain install/);
  assert.deepEqual(
    result.calls.filter((call) => call.name !== 'rustup'),
    [],
  );
});

test('cargo builds with the pinned toolchain from engines/, whatever the caller directory', () => {
  const { run } = sandbox();
  const result = run(['sipges-base-maestra', 'import-base-maestra', 'import:base-maestra'], DB);
  assert.equal(result.status, 0, result.stderr);
  const cargo = result.calls.find((call) => call.name === 'cargo');
  assert.equal(cargo.cwd, ENGINES);
  assert.deepEqual(cargo.args, [
    `+${CHANNEL}`,
    'build',
    '--quiet',
    '--release',
    '--locked',
    '-p',
    'sipges-base-maestra',
    '--bin',
    'import-base-maestra',
  ]);
});

test('the tool gets the arguments unchanged, in the caller directory, and its exit code is kept', () => {
  const { run, caller } = sandbox({ toolExit: 1 });
  const args = ['--', '--seed', 'seed.json', '--scope', 'A/B', '--apply'];
  const result = run(
    ['sipges-base-maestra', 'import-base-maestra', 'import:base-maestra', ...args],
    DB,
  );
  assert.equal(result.status, 1);
  assert.equal(result.stdout, 'tool output\n');
  const tool = result.calls.find((call) => call.name === 'tool');
  assert.deepEqual(tool.args, args);
  assert.equal(tool.cwd, caller);
});

test('a launcher call without crate, binary and script name prints its usage', () => {
  const { run } = sandbox();
  const result = run(['sipges-base-maestra'], DB);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /Usage: node scripts\/rust-tool\.mjs <crate> <binary> <script>/);
});
