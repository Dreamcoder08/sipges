// The visit kit builds only on Windows (.github/workflows/windows-desktop.yml, job visit-kit);
// these tests cover what runs anywhere: options, the places the key and the kit may not go, the
// old-clone check, LEEME.txt, and the signed kit of a synthetic package, whose fingerprint.txt
// must be the fingerprint the installer prints. Throwaway keys and synthetic packages only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import process from 'node:process';
import { Buffer } from 'node:buffer';
import { spawnSync } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join, posix, win32 } from 'node:path';
import { fileURLToPath } from 'node:url';
import { keyFingerprint } from '../updater/release.mjs';
import { makePackage, makeState, withTemp } from '../updater/verifier-helpers.mjs';
import {
  NOTES,
  checklist,
  leeme,
  opensCheckout,
  parseKitOptions,
  refusePaths,
  writeKit,
} from './visit-kit.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const kit = join(here, 'visit-kit.mjs');
const repo = join(here, '../../..');
const updateCli = join(here, '../updater/update.mjs');
const node = (...args) => spawnSync(process.execPath, args, { encoding: 'utf8' });
const FP = 'ab'.repeat(32);

test('options: version, key and out are each required once; the version is semantic', () => {
  assert.deepEqual(parseKitOptions(['--version', '1.0.0', '--key', 'K:\\k.pem', '--out', 'F:\\']), {
    version: '1.0.0',
    key: 'K:\\k.pem',
    out: 'F:\\',
  });
  for (const [args, message] of [
    [['--key', 'k', '--out', 'o'], /^Missing --version$/],
    [['--version', '1.0.0', '--out', 'o'], /^Missing --key$/],
    [['--version', '1.0.0', '--key', 'k'], /^Missing --out$/],
    [['--version', '1.0', '--key', 'k', '--out', 'o'], /^Invalid semantic version: 1\.0$/],
    [['--version', '1.0.0', '--key', 'k', '--out', 'o', '--notes', 'x'], /^Invalid options/],
    [['--version', '1.0.0', '--version', '1.0.1', '--key', 'k', '--out', 'o'], /^Invalid options/],
    [['--version', '--key', 'k', '--out', 'o'], /^Invalid options/],
    [['--version'], /^Invalid options/],
  ])
    assert.throws(() => parseKitOptions(args), { message }, JSON.stringify(args));
});

test('the key never goes into the repository, the laptop SIPGES folders or the visit USB', () => {
  const base = {
    repo: 'C:\\src\\sipges',
    localAppData: 'C:\\Users\\Someone\\AppData\\Local',
    pathApi: win32,
  };
  assert.equal(refusePaths({ ...base, key: 'K:\\sipges-clave.pem', out: 'F:\\' }), null);
  assert.equal(
    refusePaths({ ...base, key: 'C:\\Users\\Someone\\AppData\\Local\\Temp\\k.pem', out: 'F:\\' }),
    null,
    'another folder of %LOCALAPPDATA% is not the laptop install',
  );
  const refusals = [
    [{ key: 'c:\\SRC\\sipges\\.data\\k.pem', out: 'F:\\' }, /inside the repository/],
    [{ key: 'C:\\src\\sipges\\k.pem', out: 'F:\\' }, /inside the repository/],
    [{ key: 'C:\\Users\\Someone\\AppData\\Local\\SIPGES\\k.pem', out: 'F:\\' }, /to the laptop/],
    [
      { key: 'C:\\Users\\Someone\\AppData\\Local\\sipges-app\\releases\\k.pem', out: 'F:\\' },
      /to the laptop/,
    ],
    [
      { key: 'C:\\Users\\Someone\\AppData\\Local\\SIPGES-visita\\k.pem', out: 'F:\\' },
      /to the laptop/,
    ],
    [{ key: 'F:\\k.pem', out: 'F:\\' }, /never travels on the visit USB/],
    [{ key: 'F:\\SIPGES-visita\\k.pem', out: 'F:\\' }, /never travels on the visit USB/],
    [{ key: 'K:\\k.pem', out: 'C:\\src\\sipges\\usb' }, /--out .* is inside the repository/],
    [
      { key: 'K:\\k.pem', out: 'C:\\Users\\Someone\\AppData\\Local\\SIPGES-datos' },
      /--out .* SIPGES folder of %LOCALAPPDATA%/,
    ],
    [
      { key: 'K:\\k.pem', out: 'C:\\Users\\Someone\\AppData\\Local' },
      /--out .* SIPGES folder of %LOCALAPPDATA%/,
    ],
  ];
  for (const [paths, message] of refusals)
    assert.match(refusePaths({ ...base, ...paths }) ?? 'accepted', message, JSON.stringify(paths));
  assert.equal(
    refusePaths({
      key: '/media/k/k.pem',
      out: '/media/usb',
      repo: '/src/sipges',
      localAppData: null,
      pathApi: posix,
    }),
    null,
  );
});

test('the old clone is recognised by the shortcut that opens its start.ps1, whatever the case', () => {
  const args = (folder) =>
    `-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "${folder}\\deploy\\desktop\\windows\\start.ps1"`;
  assert.equal(opensCheckout(`${args('C:\\Users\\a\\sipges')}\r\n`, 'c:\\users\\A\\SIPGES'), true);
  assert.equal(
    opensCheckout(
      `${args('C:\\Users\\a\\sipges')}\r\n-NoProfile -File "C:\\x\\SIPGES-app\\start.ps1"\r\n`,
      'C:\\Users\\a\\sipges-final',
    ),
    false,
  );
  assert.equal(opensCheckout('', 'C:\\Users\\a\\sipges'), false);
});

test('LEEME names the runbook steps with this kit’s paths, version and fingerprint, and no secret', () => {
  const text = leeme({
    version: '1.0.0',
    commit: '0123456789abcdef0123456789abcdef01234567',
    fingerprint: FP,
    visit: 'F:\\SIPGES-visita',
    built: '2026-11-13T10:00:00Z',
  });
  for (const line of [
    'Versión:  1.0.0',
    'Commit:   0123456789abcdef0123456789abcdef01234567',
    `Huella SHA-256 de la clave de actualizaciones: ${FP}`,
    'Paso 0 - Descomprimir los scripts en la laptop',
    '  Copy-Item F:\\SIPGES-visita\\sipges-scripts.zip "$env:LOCALAPPDATA\\SIPGES-visita"',
    '  Expand-Archive -LiteralPath "$env:LOCALAPPDATA\\SIPGES-visita\\sipges-scripts.zip" -DestinationPath "$env:LOCALAPPDATA\\SIPGES-visita\\sipges"',
    'Paso 2 - Conteos de la versión vieja',
    '  node "$env:LOCALAPPDATA\\SIPGES-visita\\sipges\\deploy\\desktop\\migration\\snapshot.mjs" --url http://127.0.0.1:8000 --out "$env:LOCALAPPDATA\\SIPGES-visita\\sipges-antes.json"',
    'Paso 3 - Instalar al lado de la vieja',
    '  powershell -ExecutionPolicy Bypass -File "$env:LOCALAPPDATA\\SIPGES-visita\\sipges\\deploy\\desktop\\windows\\install.ps1" -Release F:\\SIPGES-visita\\release-1.0.0 -State "$env:LOCALAPPDATA\\SIPGES-datos"',
    `  Trusting the update key that signed this release (SHA-256 ${FP}).`,
    '  Installed 1.0.0',
    '  SIPGES está instalado. Ábrelo desde el menú Inicio o el escritorio.',
    'Paso 4 - Primer arranque sobre la copia',
    '  node "$env:LOCALAPPDATA\\SIPGES-app\\versions\\1.0.0\\updater\\update.mjs" --install "$env:LOCALAPPDATA\\SIPGES-app" --first-start',
    'Paso 5 - Comparar',
    '  node "$env:LOCALAPPDATA\\SIPGES-visita\\sipges\\deploy\\desktop\\migration\\compare.mjs" --before "$env:LOCALAPPDATA\\SIPGES-visita\\sipges-antes.json" --url http://127.0.0.1:8000',
    'Regla de corte (sección 3 del runbook). La versión vieja sigue en uso.',
  ])
    assert.ok(
      text.split('\n').some((l) => l === line || l.startsWith(`${line} `)),
      `LEEME lacks the line ${line}`,
    );
  assert.ok(text.includes('(docs/deployment/desktop-visit.es.md)'));
  assert.doesNotMatch(text, /\.pem|admin-password|data-key|--password/);
  const spaced = leeme({
    version: '1.0.0',
    commit: 'c0ffee',
    fingerprint: FP,
    visit: 'D:\\Mi USB\\SIPGES-visita',
    built: '2026-11-13T10:00:00Z',
  });
  assert.ok(spaced.includes('  Copy-Item "D:\\Mi USB\\SIPGES-visita\\sipges-scripts.zip" '));
  assert.ok(spaced.includes(' -Release "D:\\Mi USB\\SIPGES-visita\\release-1.0.0" -State '));
});

test('the checklist names the fingerprint, the key USB and whether the key is new', () => {
  const common = {
    version: '1.0.0',
    commit: 'c0ffee',
    fingerprint: FP,
    visit: 'F:\\SIPGES-visita',
  };
  const fresh = checklist({ ...common, created: true, key: 'K:\\k.pem' });
  assert.ok(fresh.includes(`huella ${FP}.`));
  assert.match(fresh, /La clave se creó ahora en K:\\k\.pem: hacé YA una segunda copia/);
  assert.match(fresh, /Retirá ahora el USB de la clave/);
  assert.match(checklist({ ...common, created: false, key: 'K:\\k.pem' }), /Se reutilizó la clave/);
});

test('a kit of a synthetic package: its fingerprint.txt is what the installer prints', () =>
  withTemp(async (dir) => {
    const pkg = join(dir, 'package');
    await makePackage(pkg, '1.0.0');
    await mkdir(join(dir, 'K'));
    await mkdir(join(dir, 'F'));
    const key = join(dir, 'K', 'clave.pem');
    const visit = join(dir, 'F', 'SIPGES-visita');
    const made = await writeKit({
      packageDir: pkg,
      key,
      visit,
      version: '1.0.0',
      commit: 'c0ffee',
    });
    assert.equal(made.created, true);
    const pem = await readFile(key, 'utf8');
    assert.match(pem, /^-----BEGIN PRIVATE KEY-----\n/);
    assert.deepEqual((await readdir(visit)).sort(), [
      'LEEME.txt',
      'fingerprint.txt',
      'release-1.0.0',
      'sipges-scripts.zip',
    ]);
    const fingerprint = (await readFile(join(visit, 'fingerprint.txt'), 'utf8')).trim();
    assert.equal(fingerprint, keyFingerprint(pem));
    assert.equal(made.fingerprint, fingerprint);
    const manifest = JSON.parse(
      await readFile(join(visit, 'release-1.0.0', 'release.json'), 'utf8'),
    );
    assert.equal(manifest.notes, NOTES);
    assert.equal(NOTES, 'Versión definitiva de la visita');
    const zip = await readFile(join(visit, 'sipges-scripts.zip'));
    for (const name of [
      'deploy/desktop/windows/install.ps1',
      'deploy/desktop/migration/snapshot.mjs',
      'deploy/desktop/migration/compare.mjs',
    ])
      assert.ok(zip.includes(Buffer.from(name)), `the zip lacks ${name}`);
    const leemeBytes = await readFile(join(visit, 'LEEME.txt'));
    assert.deepEqual([...leemeBytes.subarray(0, 3)], [0xef, 0xbb, 0xbf], 'LEEME.txt has a BOM');
    const text = leemeBytes.toString('utf8');
    assert.ok(text.includes('\r\n') && !/[^\r]\n/.test(text), 'LEEME.txt uses CRLF');
    assert.ok(text.includes(`-Release ${win32.join(visit, 'release-1.0.0')} -State`));

    // What install.ps1 -Release prints: update.mjs --trust-release-key on the kit's release.
    const state = join(dir, 'state');
    await makeState(state);
    const installed = node(
      updateCli,
      '--install',
      join(dir, 'app'),
      '--release',
      join(visit, 'release-1.0.0'),
      '--state',
      state,
      '--trust-release-key',
    );
    assert.deepEqual(
      [installed.status, installed.stdout, installed.stderr],
      [
        0,
        `Trusting the update key that signed this release (SHA-256 ${fingerprint}).\nInstalled 1.0.0\n`,
        '',
      ],
    );

    // A second kit reuses the key; the visit folder of the first one is never overwritten.
    await assert.rejects(
      writeKit({ packageDir: pkg, key, visit, version: '1.0.0', commit: 'c0ffee' }),
      /already exists; move it away first/,
    );
    const again = await writeKit({
      packageDir: pkg,
      key,
      visit: join(dir, 'F2'),
      version: '1.0.0',
      commit: 'c0ffee',
    });
    assert.deepEqual([again.created, again.fingerprint], [false, fingerprint]);
    assert.equal(await readFile(key, 'utf8'), pem);
  }));

test('a key that is not Ed25519 is refused before the visit folder is written', () =>
  withTemp(async (dir) => {
    const pkg = join(dir, 'package');
    await makePackage(pkg, '1.0.0');
    const key = join(dir, 'rsa.pem');
    await writeFile(
      key,
      generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({
        type: 'pkcs8',
        format: 'pem',
      }),
    );
    const visit = join(dir, 'SIPGES-visita');
    await assert.rejects(
      writeKit({ packageDir: pkg, key, visit, version: '1.0.0', commit: 'c0ffee' }),
      /is not an Ed25519 key/,
    );
    assert.equal(existsSync(visit), false);
  }));

test('CLI: refusals exit 1 with one line and write nothing', () =>
  withTemp(async (dir) => {
    const out = join(dir, 'usb');
    await mkdir(out);
    const cases = [
      [
        ['--version', '1.0.0', '--key', join(repo, 'clave.pem'), '--out', out],
        /^Error: --key .*clave\.pem is inside the repository .*: the signing key never goes into the repository\n$/,
      ],
      [
        ['--version', '1.0.0', '--key', join(out, 'clave.pem'), '--out', out],
        /^Error: --key .* and --out .* overlap: the signing key never travels on the visit USB\n$/,
      ],
      [
        ['--version', '1.0.0', '--key', join(dir, 'clave.pem'), '--out', join(repo, '.data')],
        /^Error: --out .* is inside the repository/,
      ],
      [
        ['--version', '1.0.0', '--key', join(dir, 'clave.pem'), '--out', join(dir, 'missing')],
        /^Error: --out .*missing is not an existing folder \(is the visit USB connected\?\)\n$/,
      ],
      [
        ['--version', '1.0.0', '--key', join(dir, 'nokey', 'clave.pem'), '--out', out],
        /^Error: the folder of --key .*nokey does not exist \(is the key USB connected\?\)\n$/,
      ],
      [
        ['--version', 'one', '--key', 'k', '--out', out],
        /^Error: Invalid semantic version: one\n$/,
      ],
    ];
    if (process.platform !== 'win32')
      cases.push([
        ['--version', '1.0.0', '--key', join(dir, 'clave.pem'), '--out', out],
        /^Error: the visit kit runs on Windows only: builder\.mjs builds for the system it runs on\n$/,
      ]);
    for (const [args, message] of cases) {
      const result = node(kit, ...args);
      assert.equal(result.status, 1, result.stderr);
      assert.equal(result.stdout, '');
      assert.match(result.stderr, message);
      assert.deepEqual(await readdir(dir), ['usb']);
      assert.deepEqual(await readdir(out), []);
      assert.equal(existsSync(join(repo, 'clave.pem')), false);
    }
  }));

test('CLI: --help prints the usage', () => {
  const result = node(kit, '--help');
  assert.equal(result.status, 0);
  assert.match(
    result.stdout,
    /^Usage: node deploy\/desktop\/windows\/visit-kit\.mjs --version <semver> --key /,
  );
  assert.equal(result.stderr, '');
});
