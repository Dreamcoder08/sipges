// argv: updater module URL, root, release, start time (ms epoch), hold ms, mode
import process from 'node:process';
import console from 'node:console';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { setTimeout as sleep } from 'node:timers/promises';
const [, , url, root, release, startAt, holdMs, mode] = process.argv;
const { update } = await import(url);
const now = () => performance.timeOrigin + performance.now();
const lockNow = async () =>
  JSON.parse(await readFile(join(root, 'update.lock'), 'utf8').catch(() => 'null'));
await sleep(Math.max(0, Number(startAt) - Date.now()));
const out = { pid: process.pid };
try {
  await update({
    root,
    release,
    ready: async () => {},
    migrate: async () => {
      if (mode === 'slow') {
        console.log('MIGRATING');
        await sleep(Number(holdMs));
      }
    },
    onStep: async (name) => {
      if (name !== 'locked' || mode === 'slow') return;
      out.enter = now();
      const first = await lockNow();
      await sleep(Number(holdMs));
      const second = await lockNow();
      out.mine =
        first?.pid === process.pid && second?.pid === process.pid && first.token === second.token;
      out.exit = now();
      throw new Error('probe-abort');
    },
  });
  out.result = 'DONE';
} catch (error) {
  out.result = error.message === 'probe-abort' ? 'HELD' : (error.code ?? 'ERROR');
  out.message = error.message;
}
console.log(JSON.stringify(out));
