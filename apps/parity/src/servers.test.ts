import assert from 'node:assert/strict';
import { test } from 'node:test';
import { startProcess } from './servers.ts';

const startedWithin = async (ms: number, start: () => Promise<unknown>) => {
  const began = Date.now();
  await assert.rejects(start);
  assert.ok(Date.now() - began < ms, `took ${Date.now() - began} ms`);
};

test('a command that cannot start rejects at once instead of crashing the runner', async () => {
  await startedWithin(5_000, async () => {
    await assert.rejects(
      startProcess('Missing', '/nonexistent/sipges-parity-binary', [], {}, 1),
      /Missing could not start/,
    );
    throw new Error('rejected as expected');
  });
});

test('a process killed by a signal before it is ready rejects at once, naming the signal', async () => {
  await startedWithin(5_000, async () => {
    await assert.rejects(
      startProcess(
        'Killed',
        process.execPath,
        ['-e', "process.kill(process.pid, 'SIGKILL')"],
        {},
        1,
      ),
      /Killed exited with signal SIGKILL/,
    );
    throw new Error('rejected as expected');
  });
});

test('a process that exits with a code still reports it', async () => {
  await assert.rejects(
    startProcess('Exits', process.execPath, ['-e', 'process.exit(3)'], {}, 1),
    /Exits exited with code 3/,
  );
});
