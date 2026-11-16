import assert from 'node:assert/strict';
import { test } from 'node:test';
import process from 'node:process';
import {
  GO_DATABASE_PREFIX,
  e2eRuntime,
  goApiEnv,
  goMigrateEnv,
  scratchDatabase,
  scratchDatabaseUrl,
} from './runtime.ts';
import { runBounded } from './server.ts';

test('the runtime is node when unset, and only workers or go otherwise', () => {
  assert.equal(e2eRuntime(undefined), 'node');
  assert.equal(e2eRuntime(''), 'node');
  assert.equal(e2eRuntime('node'), 'node');
  assert.equal(e2eRuntime('workers'), 'workers');
  assert.equal(e2eRuntime('go'), 'go');
  assert.throws(
    () => e2eRuntime('Go'),
    new Error("SIPGES_E2E_RUNTIME must be unset, 'node', 'workers' or 'go'; got 'Go'"),
  );
});

test('the scratch database URL keeps the server and credentials and names only the database', () => {
  const url = scratchDatabaseUrl(
    'postgres://user:pw@127.0.0.1:55500/sipges_test?sslmode=disable',
    `${GO_DATABASE_PREFIX}0a1b2c3d4e5f`,
  );
  assert.equal(
    url,
    'postgres://user:pw@127.0.0.1:55500/sipges_e2e_go_0a1b2c3d4e5f?sslmode=disable',
  );
  assert.equal(GO_DATABASE_PREFIX, 'sipges_e2e_go_');
  for (const bad of ['', 'Sipges', 'a;DROP DATABASE x', 'with space', '1abc']) {
    assert.throws(() => scratchDatabaseUrl('postgres://127.0.0.1/x', bad), /database name/);
  }
});

test('the Go migrate env names the database, the SQL files and the loopback test override only', () => {
  assert.deepEqual(goMigrateEnv({ databaseUrl: 'postgres://db', migrationsDir: '/m' }), {
    SIPGES_DATABASE_URL: 'postgres://db',
    SIPGES_MIGRATIONS_DIR: '/m',
    SIPGES_ALLOW_PRIVILEGED_DB_ROLE: '1',
  });
});

test('the Go serve env serves the SPA behind the host allowlist, with the shared settings', () => {
  const env = goApiEnv({
    databaseUrl: 'postgres://db',
    webDir: '/web/dist',
    uploadDir: '/scratch/uploads',
    hostname: 'localhost',
    shared: {
      SIPGES_REQUIRE_MFA: '0',
      SIPGES_ADMIN_USERNAME: 'e2e-admin',
      SIPGES_COOKIE_SECURE: undefined,
    },
  });
  assert.deepEqual(env, {
    SIPGES_REQUIRE_MFA: '0',
    SIPGES_ADMIN_USERNAME: 'e2e-admin',
    SIPGES_COOKIE_SECURE: undefined,
    SIPGES_DATABASE_URL: 'postgres://db',
    SIPGES_ALLOW_PRIVILEGED_DB_ROLE: '1',
    SIPGES_WEB_DIR: '/web/dist',
    SIPGES_ALLOWED_HOSTS: 'localhost',
    SIPGES_UPLOAD_DIR: '/scratch/uploads',
    SIPGES_ACCESS_LOG: '0',
  });
});

test('shared settings cannot override what the Go harness owns', () => {
  const env = goApiEnv({
    databaseUrl: 'postgres://db',
    webDir: '/web/dist',
    uploadDir: '/u',
    hostname: 'localhost',
    shared: { SIPGES_DATABASE_URL: 'postgres://other', SIPGES_WEB_DIR: '/elsewhere' },
  });
  assert.equal(env.SIPGES_DATABASE_URL, 'postgres://db');
  assert.equal(env.SIPGES_WEB_DIR, '/web/dist');
});

// functional-10 T15: the name is checked before any SQL holding it exists, so a bad name can never
// reach CREATE DATABASE (the DDL is built only from a name that passed).
test('the scratch database is checked before its CREATE and DROP statements are built', () => {
  assert.deepEqual(
    scratchDatabase('postgres://u:pw@127.0.0.1:55500/postgres', GO_DATABASE_PREFIX, '0a1b2c'),
    {
      name: 'sipges_e2e_go_0a1b2c',
      url: 'postgres://u:pw@127.0.0.1:55500/sipges_e2e_go_0a1b2c',
      create: 'CREATE DATABASE sipges_e2e_go_0a1b2c',
      drop: 'DROP DATABASE IF EXISTS sipges_e2e_go_0a1b2c WITH (FORCE)',
    },
  );
  const bad: readonly (readonly [string, string])[] = [
    ['sipges_e2e_', 'x; DROP DATABASE postgres'],
    ['Sipges-', 'abc'],
    ['', ''],
    ['sipges_e2e_', 'a'.repeat(60)],
  ];
  for (const [prefix, suffix] of bad) {
    assert.throws(
      () => scratchDatabase('postgres://127.0.0.1/x', prefix, suffix),
      /^Error: invalid scratch database name: /,
    );
  }
});

// functional-10 T15: `go build` and `migrate` are bounded, and a failure carries their output.
test('a bounded tool that overruns its time is stopped and says so, with what it printed', async () => {
  await assert.rejects(
    runBounded(
      'slow tool',
      process.execPath,
      ['-e', "console.log('started'); setTimeout(() => {}, 30000)"],
      { cwd: process.cwd(), env: process.env, timeoutMs: 300 },
    ),
    (error: Error) => {
      assert.match(error.message, /^slow tool timed out after 300 ms:\nstarted\n/);
      return true;
    },
  );
});

// A tool that ignores SIGTERM must still be stopped at its limit, not succeed after it.
test('a bounded tool that ignores SIGTERM is still stopped and reported as timed out', async () => {
  await assert.rejects(
    runBounded(
      'stubborn tool',
      process.execPath,
      ['-e', "process.on('SIGTERM', () => {}); console.log('started'); setTimeout(() => {}, 1500)"],
      { cwd: process.cwd(), env: process.env, timeoutMs: 300 },
    ),
    (error: Error) => {
      assert.match(error.message, /^stubborn tool timed out after 300 ms:\nstarted\n/);
      return true;
    },
  );
});

test('a bounded tool that fails rejects with its exit code, stdout and stderr', async () => {
  await assert.rejects(
    runBounded(
      'broken tool',
      process.execPath,
      ['-e', "console.log('out line'); console.error('err line'); process.exit(3)"],
      { cwd: process.cwd(), env: process.env, timeoutMs: 20_000 },
    ),
    (error: Error) => {
      assert.equal(error.message, 'broken tool failed with exit code 3:\nout line\nerr line\n');
      return true;
    },
  );
});

test('a bounded tool that succeeds resolves with its output', async () => {
  const { stdout } = await runBounded(
    'quick tool',
    process.execPath,
    ['-e', "console.log('done')"],
    { cwd: process.cwd(), env: process.env, timeoutMs: 20_000 },
  );
  assert.equal(stdout, 'done\n');
});
