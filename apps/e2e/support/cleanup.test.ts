import assert from 'node:assert/strict';
import { test } from 'node:test';
import { usingCleanup } from './cleanup.ts';

test('failed startup releases registered database, connection and scratch before rejecting', async () => {
  const calls: string[] = [];
  const failure = new Error('startup failed');
  await assert.rejects(
    usingCleanup(async (register) => {
      register(async () => {
        calls.push('scratch');
      });
      register(async () => {
        calls.push('connection');
      });
      register(async () => {
        calls.push('database');
      });
      throw failure;
    }),
    (error) => error === failure,
  );
  assert.deepEqual(calls, ['database', 'connection', 'scratch']);
});
test('teardown attempts every release despite errors and never repeats released resources', async () => {
  const calls: string[] = [];
  const cleanup = await usingCleanup(async (register) => {
    register(async () => {
      calls.push('scratch');
    });
    register(async () => {
      calls.push('database');
      throw new Error('drop failed');
    });
    register(async () => {
      calls.push('process');
      throw new Error('stop failed');
    });
  });
  await assert.rejects(
    cleanup(),
    (error) => error instanceof AggregateError && error.errors.length === 2,
  );
  assert.deepEqual(calls, ['process', 'database', 'scratch']);
  await cleanup();
  assert.equal(calls.length, 3);
});
test('setup failure preserves its original error if resource cleanup also fails', async () => {
  const failure = new Error('startup failed');
  const release = new Error('cleanup failed');
  await assert.rejects(
    usingCleanup(async (register) => {
      register(async () => {
        throw release;
      });
      throw failure;
    }),
    (error) => error instanceof AggregateError && error.errors[0] === failure,
  );
});
