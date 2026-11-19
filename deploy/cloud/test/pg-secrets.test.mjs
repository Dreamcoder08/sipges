// pg-secrets.mjs must take the password out of a URL without changing what the URL means to
// libpq: the query string reaches psql, pg_dump and pg_restore byte for byte, so a PlanetScale
// URL keeps sslmode, sslrootcert and options. With SIPGES_TEST_DATABASE_URL (a synthetic loopback
// server, scripts/agents/test-pg.sh), psql also proves that an `options` parameter still applies.
//   node --test deploy/cloud/test/pg-secrets.test.mjs
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { after, describe, it } from 'node:test';
import { URL, fileURLToPath } from 'node:url';

const helper = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'pg-secrets.mjs');
const scratch = mkdtempSync(path.join(tmpdir(), 'pg-secrets-test-'));
after(() => rmSync(scratch, { recursive: true, force: true }));

let files = 0;
const strip = (url) => {
  const passfile = path.join(scratch, `pass${++files}`);
  const stripped = execFileSync(process.execPath, [helper, 'strip', 'URL', passfile], {
    env: { ...process.env, URL: url },
    encoding: 'utf8',
  }).trim();
  let lines = '';
  try {
    lines = readFileSync(passfile, 'utf8');
  } catch {
    // no password, no file
  }
  return { stripped, passfile, lines };
};

// PlanetScale's documented form (https://planetscale.com/docs/postgres/connecting), plus an
// `options` value with the spaces and `=` libpq reads only percent-encoded.
const QUERY =
  'sslmode=verify-full&sslrootcert=system&sslnegotiation=direct' +
  '&options=-c%20statement_timeout%3D5000%20-c%20search_path%3Dpublic';

describe('pg-secrets strip', () => {
  it('keeps a PlanetScale query string byte for byte', () => {
    const { stripped, passfile, lines } = strip(
      `postgres://postgres.abc123:s3cr%40t@host.example:5432/sipges?${QUERY}`,
    );
    assert.equal(stripped, `postgres://postgres.abc123@host.example:5432/sipges?${QUERY}`);
    assert.equal(lines, 'host.example:5432:*:postgres.abc123:s3cr@t\n');
    assert.equal(statSync(passfile).mode & 0o777, 0o600);
  });

  it('removes a password query parameter and keeps the others byte for byte', () => {
    const { stripped, lines } = strip(
      `postgres://sipges_app.abc123@host.example/sipges?password=p%3Aw&${QUERY}`,
    );
    assert.equal(stripped, `postgres://sipges_app.abc123@host.example/sipges?${QUERY}`);
    assert.equal(lines, 'host.example:5432:*:sipges_app.abc123:p\\:w\n');
  });

  it('leaves a URL without a password unchanged and writes no line', () => {
    const url = `postgres://reader@host.example:6432/sipges?${QUERY}`;
    const { stripped, lines } = strip(url);
    assert.equal(stripped, url);
    assert.equal(lines, '');
  });

  it('applies the options through libpq after stripping', { skip: !process.env.SIPGES_TEST_DATABASE_URL }, () => {
    const server = new URL(process.env.SIPGES_TEST_DATABASE_URL);
    const url =
      `postgres://${server.username}:unused@${server.host}${server.pathname}` +
      '?options=-c%20statement_timeout%3D4321%20-c%20search%5Fpath%3Dpg%5Fsecrets';
    const { stripped } = strip(url);
    const result = spawnSync(
      'psql',
      [stripped, '-X', '-At', '-c', "SELECT current_setting('statement_timeout'), current_setting('search_path')"],
      { encoding: 'utf8' },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), '4321ms|pg_secrets');
  });
});
