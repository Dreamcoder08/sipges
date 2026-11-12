// The processes the rehearsal starts (old API, managed launcher, snapshot and compare runs) are
// stopped and awaited on every way out: a normal end, an error, and SIGINT or SIGTERM. Synthetic
// child processes only; the full rehearsal (git worktree, pnpm, package build) is not run here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import process from 'node:process';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { startLogged, stop } from './rehearse.mjs';

const rehearse = join(dirname(fileURLToPath(import.meta.url)), 'rehearse.mjs');
const IDLE = ['-e', 'setInterval(() => {}, 1000)'];

async function withTemp(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'sipges-rehearse-'));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code !== 'ESRCH') throw error;
    return false;
  }
};
const within = (promise, ms) => Promise.race([promise, sleep(ms, 'hung', { ref: false })]);

test('stopping a process that already ended by a signal returns at once', () =>
  withTemp(async (dir) => {
    const child = await startLogged(process.execPath, IDLE, {
      cwd: dir,
      env: process.env,
      log: join(dir, 'idle.log'),
    });
    child.kill('SIGKILL');
    await once(child, 'exit');
    assert.notEqual(await within(stop(child), 3000), 'hung');
  }));

test('a server that never gets ready is stopped and awaited before the start fails', () =>
  withTemp(async (dir) => {
    await assert.rejects(
      startLogged(
        process.execPath,
        ['-e', 'console.log(String(process.pid)); setInterval(() => {}, 1000)'],
        {
          cwd: dir,
          env: process.env,
          log: join(dir, 'never-ready.log'),
          ready: { base: 'http://127.0.0.1:9', seconds: 1 },
        },
      ),
      /was not ready within 1 s/,
    );
    const pid = Number((await readFile(join(dir, 'never-ready.log'), 'utf8')).trim());
    assert.ok(pid > 0);
    assert.equal(alive(pid), false, 'the server outlived its failed start');
  }));

for (const signal of ['SIGINT', 'SIGTERM'])
  test(`${signal} to the rehearsal stops and awaits every process it started`, () =>
    withTemp(async (dir) => {
      const driver = `
        import process from 'node:process';
        import { startLogged } from ${JSON.stringify(pathToFileURL(rehearse).href)};
        const child = await startLogged(process.execPath, ${JSON.stringify(IDLE)}, {
          cwd: ${JSON.stringify(dir)},
          env: process.env,
          log: ${JSON.stringify(join(dir, 'child.log'))},
        });
        console.log(String(child.pid));
      `;
      const parent = spawn(process.execPath, ['--input-type=module', '-e', driver], {
        stdio: ['ignore', 'pipe', 'inherit'],
      });
      const ended = once(parent, 'exit');
      let output = '';
      parent.stdout.on('data', (chunk) => (output += chunk));
      while (!output.includes('\n')) await sleep(20);
      const pid = Number(output.trim());
      try {
        assert.equal(alive(pid), true);
        parent.kill(signal);
        const [code] = await within(ended, 5000).then((r) => (r === 'hung' ? ['hung'] : r));
        assert.equal(code, 130);
        assert.equal(alive(pid), false, 'a process of the rehearsal outlived it');
      } finally {
        parent.kill('SIGKILL');
        if (alive(pid)) process.kill(pid, 'SIGKILL');
      }
    }));

test('the second account check asserts the same access before and after the move', async () => {
  const { sameAccess } = await import('./rehearse.mjs');
  const before = { status: 200, projects: 1 };
  assert.equal(sameAccess(before, { status: 200, projects: 1 }), true);
  assert.equal(sameAccess(before, { status: 403, projects: null }), false);
  assert.equal(sameAccess(before, { status: 401, projects: null }), false);
  assert.equal(sameAccess(before, { status: 200, projects: 2 }), false);
  assert.equal(sameAccess(before, { status: 200, projects: 0 }), false);
  assert.equal(sameAccess({ status: 200, projects: 0 }, { status: 200, projects: 0 }), false);
  assert.equal(sameAccess({ status: 500, projects: null }, { status: 500, projects: null }), false);
});
