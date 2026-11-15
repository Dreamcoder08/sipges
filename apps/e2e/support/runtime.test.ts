import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  GO_DATABASE_PREFIX,
  e2eRuntime,
  goApiEnv,
  goMigrateEnv,
  scratchDatabaseUrl,
} from './runtime.ts';

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
