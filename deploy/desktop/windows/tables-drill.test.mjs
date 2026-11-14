// tables-drill.mjs, the drill's real runs of deploy/desktop/migration/tables.mjs, on this system
// with this checkout's PGlite (no --app): synthetic folders in a fresh temp folder, removed at the
// end. On Windows the junctions are real ones and the drive must be NTFS; elsewhere they are
// symbolic links. drill.mjs runs the same with the drill's managed install (--app).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { lastLine, report, tablesDrill } from './tables-drill.mjs';

test('report and lastLine: exit code, stdout and stderr apart; the last non-empty line', () => {
  assert.equal(
    report({ code: 2, stdout: 'a\nRESULT: x\n', stderr: 'Error: x' }),
    'exit code 2\n--- stdout\na\nRESULT: x\n--- stderr\nError: x\n--- end',
  );
  assert.equal(report({ code: 0, stdout: '', stderr: '' }), 'exit code 0\n--- stdout\n--- stderr\n--- end');
  assert.equal(lastLine('one\r\nRESULT: no difference\r\n\r\n'), 'RESULT: no difference');
  assert.equal(lastLine(''), '');
});

test('tables.mjs for real: identical, one changed row, junction refusals, --app, port', async () => {
  const work = await mkdtemp(join(tmpdir(), 'sipges-tables-drill-test-'));
  try {
    const said = [];
    const checks = [];
    const result = await tablesDrill({
      work,
      say: (line) => said.push(line),
      check: (ok, label) => {
        assert.ok(ok, label);
        checks.push(label);
      },
      log: (name) => join(work, `${name}.txt`),
    });
    assert.deepEqual(result, { pglite: 'checkout', runs: 6 });
    assert.ok(said.includes("PGlite exercised: this checkout's (apps/api, no --app: no managed install here)"));
    for (const label of [
      'identical folders: exit 0 (got 0)',
      'identical folders: last line RESULT: no difference',
      'identical folders: scratch empty afterwards ()',
      'one changed row: exit 1 (got 1)',
      'one changed row: a RESULT: N difference(s) line',
      'input that is a junction: exit 2 (got 2)',
      'input that holds a junction: exit 2 (got 2)',
      'input that holds a junction: scratch empty afterwards ()',
      '--app without current.json: exit 2 (got 2)',
    ])
      assert.ok(checks.includes(label), `${label}\n${checks.join('\n')}`);
    assert.ok(said.some((line) => line.startsWith('not run: an interrupt (Ctrl+C)')));
    const logs = (await readdir(work)).filter((name) => name.endsWith('.txt')).sort();
    assert.deepEqual(logs, [
      'app-not-an-install.txt',
      'identical.txt',
      'input-holds-junction.txt',
      'input-is-junction.txt',
      'one-changed-row.txt',
      'port-answers.txt',
    ]);
  } finally {
    await rm(work, { recursive: true, force: true });
  }
});

test('a failed check carries the exit code, stdout and stderr of the run', async () => {
  const work = await mkdtemp(join(tmpdir(), 'sipges-tables-drill-test-'));
  try {
    // A stand-in tables.mjs that finds a difference where there is none.
    const fake = join(work, 'fake-tables.mjs');
    await writeFile(
      fake,
      "console.log('users: 2 -> 2, row [0123abcd] differs in password_hash');\nconsole.log('RESULT: 1 difference');\nconsole.error('a line on stderr');\nprocess.exitCode = 1;\n",
    );
    await assert.rejects(
      tablesDrill({ work, script: fake, say: () => {}, check: (ok, label) => assert.ok(ok, label) }),
      (error) => {
        assert.match(error.message, /^Check failed: identical folders: exit 0 \(got 1\)\n/);
        assert.match(error.message, /\nexit code 1\n--- stdout\n/);
        assert.match(error.message, /\nRESULT: 1 difference\n--- stderr\na line on stderr\n--- end$/);
        return true;
      },
    );
  } finally {
    await rm(work, { recursive: true, force: true });
  }
});
