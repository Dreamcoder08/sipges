#!/usr/bin/env node
// Runs one Rust operator tool (engines/crates/*) for a pnpm script of apps/api/package.json:
//   node scripts/rust-tool.mjs <crate> <binary> <script> [tool arguments...]
// It builds the binary with the toolchain pinned in engines/rust-toolchain.toml (rustup reads that
// file from the working directory, not from the manifest, so the channel is passed explicitly),
// then runs it in the caller's directory with the arguments unchanged, so relative paths such as
// --seed or --report mean what they meant with the TypeScript tool. Exit code: the tool's.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ENGINES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'engines');
const USAGE = 'Usage: node scripts/rust-tool.mjs <crate> <binary> <script> [tool arguments...]';

const fail = (message, code = 1) => {
  console.error(message);
  process.exit(code);
};

const [crate, binary, script, ...toolArgs] = process.argv.slice(2);
if (!crate || !binary || !script) fail(USAGE, 2);

// The Rust tools only speak to PostgreSQL; refuse before a long compile rather than after it.
if (process.env.SIPGES_PGLITE_DIR && !process.env.SIPGES_DATABASE_URL) {
  fail(
    [
      'Las herramientas Rust necesitan PostgreSQL: defina SIPGES_DATABASE_URL.',
      `Una instalación con PGlite (SIPGES_PGLITE_DIR) usa \`${script}:ts\` hasta que se migre a pg18.`,
    ].join('\n'),
    2,
  );
}

const channel = /^channel\s*=\s*"([^"]+)"/m.exec(
  readFileSync(path.join(ENGINES, 'rust-toolchain.toml'), 'utf8'),
)?.[1];
if (!channel)
  fail(`No se encontró el canal de Rust en ${path.join(ENGINES, 'rust-toolchain.toml')}.`);

const toolchains = spawnSync('rustup', ['toolchain', 'list'], { encoding: 'utf8' });
if (toolchains.error) {
  fail(
    `No se encontró rustup (${toolchains.error.code ?? toolchains.error.message}). ` +
      'Instálelo desde https://rustup.rs y vuelva a intentarlo.',
  );
}
const installed = toolchains.stdout
  .split('\n')
  .map((line) => line.trim().split(/\s+/)[0])
  .some((name) => name === channel || name?.startsWith(`${channel}-`));
if (!installed) {
  fail(
    `Falta el toolchain de Rust ${channel} (engines/rust-toolchain.toml). ` +
      'Instálelo con: cd engines && rustup toolchain install',
  );
}

// The binary is taken from cargo's own report: CARGO_BUILD_TARGET_DIR or a user build.target-dir
// move the target folder, and running engines/target/release would start an old build on real data.
const build = spawnSync(
  'cargo',
  [
    `+${channel}`,
    'build',
    '--quiet',
    '--release',
    '--locked',
    '--message-format=json-render-diagnostics',
    '-p',
    crate,
    '--bin',
    binary,
  ],
  {
    cwd: ENGINES,
    stdio: ['inherit', 'pipe', 'inherit'],
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  },
);
if (build.error) fail(`No se pudo ejecutar cargo: ${build.error.message}`);
if (build.status !== 0) process.exit(build.status ?? 1);

const executable = build.stdout
  .split('\n')
  .map((line) => {
    try {
      return JSON.parse(line);
    } catch {
      return null;
    }
  })
  .filter((message) => message?.reason === 'compiler-artifact' && message.target?.name === binary)
  .map((message) => message.executable)
  .findLast(Boolean);
if (!executable) fail(`cargo no informó dónde quedó ${binary}; no se ejecutó nada.`);
const run = spawnSync(executable, toolArgs, { stdio: 'inherit' });
if (run.error) fail(`No se pudo ejecutar ${executable}: ${run.error.message}`);
process.exit(run.status ?? 1);
