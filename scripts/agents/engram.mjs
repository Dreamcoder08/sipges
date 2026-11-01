#!/usr/bin/env node
// Engram (Gentle AI persistent memory) entry point for Claude Code, Codex and people.
// Memory lives in the local Engram database; `.engram/` carries it between machines and
// ephemeral cloud sessions as append-only chunks committed with the work.
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ENGRAM_VERSION = '3.4.0';
// From the v3.4.0 release checksums.txt; a download that does not match is discarded.
const SHA256 = {
  'linux-x64': '715fda625556e46d65ddb4526bb7f88a3fee5339ca3c44ce44cc652f17fa57f1',
  'linux-arm64': '3309e9c0bbb539d183fd5aa9f9a13cd7aa0e81ec2512b5bedefb8b2bdd35b3e5',
};
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const exe = process.platform === 'win32' ? 'engram.exe' : 'engram';
const localBin = () => path.join(homedir(), '.local', 'bin');
const env = { ...process.env, ENGRAM_PROJECT: process.env.ENGRAM_PROJECT || 'sipges' };
const log = (text) => process.stderr.write(`engram: ${text}\n`);
const fail = (text) => {
  log(text);
  return null;
};

const LOCAL_STEPS = `Engram is not installed. On your machine run one of:
  gentle-ai install --agent claude-code,codex --preset ecosystem-only   (installs Engram too)
  brew install gentleman-programming/tap/engram
  go install github.com/Gentleman-Programming/engram/v3/cmd/engram@v${ENGRAM_VERSION}
See docs/agents/gentle-ai.md.`;

export function findEngram() {
  if (process.env.SIPGES_ENGRAM_BIN) return process.env.SIPGES_ENGRAM_BIN;
  const dirs = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean);
  for (const dir of [...dirs, localBin()]) {
    const candidate = path.join(dir, exe);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

// Downloads the pinned release only inside Claude Code cloud sessions, whose containers start
// empty every time. A person's machine is never changed: they install Engram themselves.
function installInCloud() {
  if (process.env.CLAUDE_CODE_REMOTE !== 'true') {
    return fail(LOCAL_STEPS);
  }
  const key = `${process.platform}-${process.arch}`;
  if (!SHA256[key]) {
    return fail(`no pinned Engram ${ENGRAM_VERSION} build for ${key}`);
  }
  const arch = process.arch === 'x64' ? 'amd64' : 'arm64';
  const name = `engram_${ENGRAM_VERSION}_linux_${arch}.tar.gz`;
  const url = `https://github.com/Gentleman-Programming/engram/releases/download/v${ENGRAM_VERSION}/${name}`;
  const work = mkdtempSync(path.join(tmpdir(), 'engram-'));
  try {
    const archive = path.join(work, name);
    const fetched = spawnSync('curl', ['-fsSL', '--retry', '3', '-o', archive, url], {
      stdio: ['ignore', 2, 2],
    });
    if (fetched.status !== 0) return fail(`download failed: ${url}`);
    const digest = createHash('sha256').update(readFileSync(archive)).digest('hex');
    if (digest !== SHA256[key]) return fail(`checksum mismatch for ${name}`);
    mkdirSync(localBin(), { recursive: true });
    const unpacked = spawnSync('tar', ['-xzf', archive, '-C', localBin(), 'engram'], {
      stdio: ['ignore', 2, 2],
    });
    if (unpacked.status !== 0) return fail('could not unpack the archive');
    const bin = path.join(localBin(), 'engram');
    chmodSync(bin, 0o755);
    log(`installed ${ENGRAM_VERSION} at ${bin}`);
    return bin;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

const ensureEngram = () => findEngram() ?? installInCloud();

// MCP speaks JSON-RPC on stdout, so anything else Engram prints goes to stderr.
const run = (bin, args, stdout = 'inherit') =>
  spawnSync(bin, args, { cwd: root, env, stdio: ['ignore', stdout, 2] }).status ?? 1;

const importChunks = (bin, stdout) =>
  existsSync(path.join(root, '.engram', 'manifest.json'))
    ? run(bin, ['sync', '--import'], stdout)
    : 0;

const commands = {
  install: (bin) => {
    console.log(bin);
    return 0;
  },
  import: (bin) => importChunks(bin),
  sync: (bin) => run(bin, ['sync']),
  status: (bin) => run(bin, ['sync', '--status']),
  mcp: (bin) => {
    if (importChunks(bin, 2) !== 0) log('could not import .engram/ chunks; serving local memory');
    const child = spawn(bin, ['mcp', '--tools=agent'], { cwd: root, env, stdio: 'inherit' });
    for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
    child.on('exit', (code) => process.exit(code ?? 1));
    return undefined;
  },
};

const [command] = process.argv.slice(2);
if (!commands[command]) {
  console.error('usage: node scripts/agents/engram.mjs <mcp|import|sync|status|install>');
  process.exit(2);
}
const bin = ensureEngram();
if (!bin) process.exit(1);
const code = commands[command](bin);
if (code !== undefined) process.exit(code);
