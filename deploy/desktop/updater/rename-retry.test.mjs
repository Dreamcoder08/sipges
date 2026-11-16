// On Windows a folder rename is refused while another process briefly holds it or a file in it
// (an antivirus scan, the search indexer, an open Explorer window). The updater waits for it with
// a growing pause for well over a few seconds before giving up, so an ordinary hold does not end
// in a halt. The clock and the pause are injected: these tests take no real time.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { renameRetry } from './updater.mjs';
import { withTemp } from './verifier-helpers.mjs';

const held = (code = 'EPERM') =>
  Object.assign(new Error(`${code}: operation not permitted, rename 'a' -> 'b'`), { code });

/** A fake clock that only the injected pause moves, and a rename that fails `failures` times. */
function windows({ failures = Infinity, code = 'EPERM', renameMs = 0 } = {}) {
  let clock = 0;
  const waits = [];
  const calls = [];
  const errors = [];
  const options = {
    platform: 'win32',
    now: () => clock,
    wait: async (ms) => {
      waits.push(ms);
      clock += ms;
    },
    move: async (from, to) => {
      calls.push([from, to]);
      clock += renameMs;
      if (calls.length > failures) return undefined;
      const error = held(code);
      errors.push(error);
      throw error;
    },
  };
  return { options, waits, calls, errors, elapsed: () => clock };
}

const total = (waits) => waits.reduce((sum, ms) => sum + ms, 0);

test('a folder held for good is retried for 30 to 60 seconds, then its last error is thrown', async () => {
  const w = windows();
  const error = await renameRetry('a', 'b', w.options).then(
    () => null,
    (failure) => failure,
  );
  assert.equal(error, w.errors.at(-1), 'the error of the last attempt, unchanged');
  assert.equal(error.code, 'EPERM');
  assert.equal(error.message, "EPERM: operation not permitted, rename 'a' -> 'b'");
  assert.ok(total(w.waits) >= 30_000, `waited ${total(w.waits)} ms in all`);
  assert.ok(total(w.waits) <= 60_000, `waited ${total(w.waits)} ms in all`);
  assert.equal(w.calls.length, w.waits.length + 1, 'one more attempt than pauses');
  assert.ok(
    w.calls.every(([from, to]) => from === 'a' && to === 'b'),
    'the same rename every time',
  );
  assert.equal(w.waits[0], 100, 'the first pause is short');
  for (let i = 1; i < w.waits.length; i += 1)
    assert.ok(w.waits[i] >= w.waits[i - 1] || i === w.waits.length - 1, 'pauses grow');
  assert.ok(Math.max(...w.waits) <= 2_000, 'no single pause is long');
});

test('slow refused renames count against the same budget', async () => {
  const w = windows({ renameMs: 5_000 });
  await assert.rejects(renameRetry('a', 'b', w.options), { code: 'EPERM' });
  assert.ok(w.elapsed() <= 65_000, `gave up after ${w.elapsed()} ms`);
  assert.ok(w.elapsed() >= 30_000, `gave up after ${w.elapsed()} ms`);
});

test('EACCES and EBUSY are waited for like EPERM', async () => {
  for (const code of ['EACCES', 'EBUSY']) {
    const w = windows({ failures: 3, code });
    assert.equal(await renameRetry('a', 'b', w.options), undefined);
    assert.deepEqual(w.waits, [100, 200, 400]);
    assert.equal(w.calls.length, 4);
  }
});

test('a hold released after 20 seconds no longer ends in an error', async () => {
  // 2 s of retries (the old limit) is long past at 20 s.
  const w = windows({ failures: 25 });
  assert.equal(await renameRetry('a', 'b', w.options), undefined);
  assert.ok(total(w.waits) > 20_000, `waited ${total(w.waits)} ms`);
  assert.equal(w.calls.length, 26);
});

test('preserved: a rename that succeeds on the first try does not wait', async () => {
  const w = windows({ failures: 0 });
  assert.equal(await renameRetry('a', 'b', w.options), undefined);
  assert.deepEqual(w.waits, []);
  assert.deepEqual(w.calls, [['a', 'b']]);
});

test('preserved: an error that is not a hold is thrown at once, without waiting', async () => {
  const w = windows({ code: 'ENOENT' });
  await assert.rejects(renameRetry('a', 'b', w.options), (error) => error === w.errors[0]);
  assert.deepEqual(w.waits, []);
  assert.equal(w.calls.length, 1);
});

test('preserved: off Windows a refused rename is thrown at once, without waiting', async () => {
  const w = windows();
  await assert.rejects(renameRetry('a', 'b', { ...w.options, platform: 'linux' }), {
    code: 'EPERM',
  });
  assert.deepEqual(w.waits, []);
  assert.equal(w.calls.length, 1);
});

test('preserved: with the real defaults a folder is renamed at once', () =>
  withTemp(async (dir) => {
    const from = join(dir, 'from');
    await mkdir(from);
    await writeFile(join(from, 'file'), 'synthetic\n');
    const started = Date.now();
    await renameRetry(from, join(dir, 'to'));
    assert.ok(Date.now() - started < 1_000);
    assert.equal(existsSync(from), false);
    assert.equal(await readFile(join(dir, 'to', 'file'), 'utf8'), 'synthetic\n');
  }));
