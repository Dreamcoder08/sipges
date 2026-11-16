// The Windows drill itself only runs on Windows (.github/workflows/windows-desktop.yml); these
// tests cover what it decides on its own: options, the environment its children get, and which
// process holds the port. Synthetic input only; nothing is started.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  HALT_LINE,
  INSTALLED_LINE,
  childEnv,
  listeners,
  packScripts,
  parseOptions,
} from './drill.mjs';

const drill = join(dirname(fileURLToPath(import.meta.url)), 'drill.mjs');
const NOW = new Date('2026-11-14T09:08:07.000Z');

test('options: defaults name a fresh work folder, the old commits and two ordered versions', () => {
  const options = parseOptions([], { now: NOW, tmp: 'C:\\Temp' });
  assert.deepEqual(options, {
    work: join('C:\\Temp', 'sipges-drill-20261114T090807Z'),
    logs: join('C:\\Temp', 'sipges-drill-20261114T090807Z', 'logs'),
    oldCommit: 'e490339c',
    launcherCommit: '6d867050',
    versions: ['0.0.7-drill.20261114090807.1', '0.0.7-drill.20261114090807.2'],
  });
});

test('options: each one is taken once, unknown ones are refused', () => {
  const options = parseOptions(
    [
      '--work',
      'D:\\w',
      '--logs',
      'D:\\l',
      '--old-commit',
      'abc1234',
      '--launcher-commit',
      'def5678',
    ],
    { now: NOW, tmp: 'C:\\Temp' },
  );
  assert.equal(options.work, 'D:\\w');
  assert.equal(options.logs, 'D:\\l');
  assert.equal(options.oldCommit, 'abc1234');
  assert.equal(options.launcherCommit, 'def5678');
  for (const args of [
    ['--port', '8000'],
    ['--work'],
    ['--work', '--logs'],
    ['--work', 'a', '--work', 'b'],
  ])
    assert.throws(
      () => parseOptions(args, { now: NOW, tmp: 'C:\\Temp' }),
      /Invalid options; use --help/,
    );
});

test('options: an old or launcher commit is a commit or ref name, never an option or a range', () => {
  for (const commit of ['6d867050', 'dc7abde0', 'origin/main', 'v1.0.0', 'feat/desktop-launchers'])
    assert.equal(parseOptions(['--old-commit', commit], { now: NOW }).oldCommit, commit);
  for (const commit of ['-x', '-c=core.pager', 'a..b', 'a b', 'a;b', '/main', 'x'.repeat(101)]) {
    assert.throws(() => parseOptions(['--old-commit', commit], { now: NOW }), {
      message: `Invalid commit: ${commit}`,
    });
    assert.throws(() => parseOptions(['--launcher-commit', commit], { now: NOW }), {
      message: `Invalid commit: ${commit}`,
    });
  }
});

test('the accented lines the drill checks are the ones the Windows scripts print', async () => {
  const read = (file) => readFile(join(dirname(drill), file), 'utf8');
  assert.ok((await read('install.ps1')).includes(`Write-Host '${INSTALLED_LINE}'`));
  assert.equal(
    INSTALLED_LINE,
    'SIPGES está instalado. Ábrelo desde el menú Inicio o el escritorio.',
  );
  assert.ok((await read('start-managed.ps1')).includes(`'${HALT_LINE}*'`));
});

test('the scripts travel as the runbook packs them: deploy/desktop of HEAD in a zip', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sipges-drill-test-'));
  try {
    const zip = join(dir, 'sipges-scripts.zip');
    packScripts(zip);
    const bytes = await readFile(zip);
    assert.equal(bytes.readUInt32LE(0), 0x04034b50, 'a zip file');
    for (const name of [
      'deploy/desktop/windows/install.ps1',
      'deploy/desktop/windows/start-managed.ps1',
      'deploy/desktop/updater/update.mjs',
      'deploy/desktop/migration/snapshot.mjs',
      'deploy/desktop/migration/compare.mjs',
    ])
      assert.ok(bytes.includes(name), `the zip lacks ${name}`);
    assert.equal(bytes.includes('apps/api/'), false, 'only deploy/desktop travels');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('children get no SIPGES_* variable, no inherited PowerShell 7 module path and their own LOCALAPPDATA', () => {
  const env = childEnv(
    {
      Path: 'C:\\Windows',
      SIPGES_DATA_KEY: 'synthetic',
      sipges_port: '1',
      PSModulePath: 'C:\\Program Files\\PowerShell\\7\\Modules',
      LocalAppData: 'C:\\Users\\someone\\AppData\\Local',
    },
    { LOCALAPPDATA: 'D:\\scratch\\lad', SIPGES_DESKTOP_NO_UI: '1' },
  );
  assert.deepEqual(env, {
    Path: 'C:\\Windows',
    LOCALAPPDATA: 'D:\\scratch\\lad',
    SIPGES_DESKTOP_NO_UI: '1',
  });
});

test('the process listening on a port is found in netstat output in any Windows language', () => {
  const english = [
    '',
    'Active Connections',
    '',
    '  Proto  Local Address          Foreign Address        State           PID',
    '  TCP    0.0.0.0:135            0.0.0.0:0              LISTENING       1012',
    '  TCP    127.0.0.1:8000         0.0.0.0:0              LISTENING       5524',
    '  TCP    127.0.0.1:8000         127.0.0.1:50211        ESTABLISHED     5524',
    '  TCP    127.0.0.1:50211        127.0.0.1:8000         TIME_WAIT       0',
    '  TCP    127.0.0.1:18000        0.0.0.0:0              LISTENING       77',
    '  TCP    [::1]:8000             [::]:0                 LISTENING       6001',
  ].join('\r\n');
  assert.deepEqual(listeners(english, 8000), [5524, 6001]);
  const spanish = [
    'Conexiones activas',
    '  Proto  Dirección local          Dirección remota        Estado           PID',
    '  TCP    127.0.0.1:8000         0.0.0.0:0              ESCUCHANDO      4242',
  ].join('\r\n');
  assert.deepEqual(listeners(spanish, 8000), [4242]);
  assert.deepEqual(listeners(english, 9000), []);
});

test(
  'the drill refuses to run anywhere but Windows, before writing anything',
  { skip: process.platform === 'win32' },
  async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sipges-drill-test-'));
    try {
      const work = join(dir, 'work');
      const result = spawnSync(process.execPath, [drill, '--work', work], { encoding: 'utf8' });
      assert.equal(result.status, 1);
      assert.equal(result.stdout, '');
      assert.equal(
        result.stderr,
        'DRILL FAILED: the Windows drill runs on Windows only; on Linux use deploy/desktop/migration/rehearse.mjs\n',
      );
      assert.deepEqual(await readdir(dir), []);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
);

test('--help prints the usage', () => {
  const result = spawnSync(process.execPath, [drill, '--help'], { encoding: 'utf8' });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /^Usage: node deploy\/desktop\/windows\/drill\.mjs /);
  assert.equal(result.stderr, '');
});
