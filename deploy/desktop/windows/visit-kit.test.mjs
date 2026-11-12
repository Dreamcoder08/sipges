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
import { createServer } from 'node:net';
import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join, posix, win32 } from 'node:path';
import { fileURLToPath } from 'node:url';
import { keyFingerprint } from '../updater/release.mjs';
import { makePackage, makeState, withTemp } from '../updater/verifier-helpers.mjs';
import {
  BUILD_FREE,
  KIT_FREE,
  LAPTOP_FREE_GB,
  NOTES,
  checklist,
  freeBytes,
  leeme,
  nodeRefusal,
  oldClones,
  opensCheckout,
  parseKitOptions,
  placeRefusal,
  pnpmRefusal,
  portAnswers,
  preflight,
  refusePaths,
  sameDrive,
  sipgesRefusal,
  spaceRefusal,
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

// ---------------------------------------------------------------------------------------------
// Built on the laptop itself (docs/deployment/desktop-visit.es.md, «Armar el kit en la laptop»):
// the refusals below run before anything is built; their probes are injected here.

const GiB = 1024 ** 3;
const LAPTOP = {
  checkout: 'C:\\SIPGES-kit',
  key: 'K:\\sipges-clave-actualizaciones.pem',
  out: 'F:\\',
  localAppData: 'C:\\Users\\Someone\\AppData\\Local',
  pathApi: win32,
};
const shortcut = (folder) =>
  `-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "${folder}\\deploy\\desktop\\windows\\start.ps1"`;

test('Node older than 24 is refused with the exact fix; 24 and later pass', () => {
  assert.equal(
    nodeRefusal('22.11.0'),
    'Node.js 22.11.0 es anterior a 24: el kit necesita Node.js 24 o posterior. Instalalo con «winget install OpenJS.NodeJS.LTS», abrí una terminal nueva y repetí el comando.',
  );
  assert.match(nodeRefusal('23.9.9') ?? 'accepted', /^Node\.js 23\.9\.9 es anterior a 24/);
  for (const version of ['24.0.0', '24.11.1', '26.1.0']) assert.equal(nodeRefusal(version), null);
});

test('pnpm missing or not 12 is refused with the exact fix; pnpm 12 passes', () => {
  assert.equal(
    pnpmRefusal(null),
    'Falta pnpm: instalalo con «npm install -g pnpm@12.11.2», abrí una terminal nueva y repetí el comando.',
  );
  assert.equal(
    pnpmRefusal('9.15.0'),
    'pnpm 9.15.0 no sirve: este repositorio usa pnpm 12. Instalalo con «npm install -g pnpm@12.11.2», abrí una terminal nueva y repetí el comando.',
  );
  assert.equal(pnpmRefusal('12.11.2'), null);
  assert.equal(pnpmRefusal('12.0.0'), null);
});

test('SIPGES answering on port 8000 is refused: the kit is not built while she works', () => {
  assert.equal(
    sipgesRefusal(true),
    'SIPGES está abierto: algo responde en http://127.0.0.1:8000. El kit no se arma mientras la usuaria trabaja: cerrá SIPGES por completo («SIPGES cerrado», sección 2 del runbook) y repetí el comando.',
  );
  assert.equal(sipgesRefusal(false), null);
});

test('free space: the package where it is built and its signed copy in --out; one drive adds both', () => {
  assert.equal(BUILD_FREE, GiB);
  assert.equal(KIT_FREE, GiB);
  const base = { checkout: 'C:\\SIPGES-kit', out: 'F:\\', sameDrive: false };
  assert.equal(spaceRefusal({ ...base, freeCheckout: GiB, freeOut: GiB }), null);
  assert.equal(
    spaceRefusal({ ...base, freeCheckout: 0.4 * GiB, freeOut: 8 * GiB }),
    'Falta espacio en el disco de este clon (C:\\SIPGES-kit): hay 0,4 GB libres y el kit necesita 1,0 GB para construir el paquete. Liberá espacio y repetí el comando.',
  );
  assert.equal(
    spaceRefusal({ ...base, freeCheckout: 8 * GiB, freeOut: 0.25 * GiB }),
    'Falta espacio en --out F:\\: hay 0,3 GB libres y el kit necesita 1,0 GB para la versión firmada. Usá otro USB o liberá espacio y repetí el comando.',
  );
  const local = { checkout: 'C:\\SIPGES-kit', out: 'C:\\SIPGES-kit-salida', sameDrive: true };
  assert.equal(
    spaceRefusal({ ...local, freeCheckout: 1.5 * GiB, freeOut: 1.5 * GiB }),
    'Falta espacio en el disco de C:\\SIPGES-kit y de --out C:\\SIPGES-kit-salida (el mismo disco): hay 1,5 GB libres y el kit necesita 2,0 GB (el paquete en este clon y su copia firmada en --out). Liberá espacio o usá --out en otro disco y repetí el comando.',
  );
  assert.equal(spaceRefusal({ ...local, freeCheckout: 2 * GiB, freeOut: 2 * GiB }), null);
});

test('the old clones are the folders whose start.ps1 the SIPGES shortcuts open', () => {
  assert.deepEqual(
    oldClones(
      `${shortcut('C:\\Users\\a\\sipges')}\r\n${shortcut('C:\\Users\\a\\sipges')}\r\n-NoProfile -File "C:\\x\\SIPGES-app\\start.ps1"\r\n`,
    ),
    ['C:\\Users\\a\\sipges'],
  );
  assert.deepEqual(oldClones(''), []);
});

test('the kit never writes in the old clone or a SIPGES folder of %LOCALAPPDATA%', () => {
  const clones = ['C:\\Users\\Someone\\sipges'];
  // Two USB drives, or one USB for the key and the kit in a laptop folder beside the clone.
  assert.equal(placeRefusal({ ...LAPTOP, clones }), null);
  assert.equal(placeRefusal({ ...LAPTOP, out: 'C:\\SIPGES-kit-salida', clones }), null);
  assert.equal(
    refusePaths({ ...LAPTOP, repo: LAPTOP.checkout, out: 'C:\\SIPGES-kit-salida' }),
    null,
    'a laptop folder outside the repository and %LOCALAPPDATA%\\SIPGES* is a valid --out',
  );
  assert.equal(
    placeRefusal({ ...LAPTOP, checkout: 'c:\\users\\someone\\SIPGES', clones }),
    'Los accesos directos «SIPGES» abren este clon (c:\\users\\someone\\SIPGES): es el clon viejo de la laptop y el kit no escribe en él. Cloná el commit definitivo en otra carpeta (C:\\SIPGES-kit) y corré el kit desde ahí.',
  );
  assert.equal(
    placeRefusal({ ...LAPTOP, checkout: 'C:\\Users\\Someone\\sipges\\kit', clones }),
    'Este clon (C:\\Users\\Someone\\sipges\\kit) está dentro del clon viejo C:\\Users\\Someone\\sipges, el que abren los accesos directos «SIPGES»: el kit no escribe en él. Cloná el commit definitivo en otra carpeta (C:\\SIPGES-kit) y corré el kit desde ahí.',
  );
  assert.equal(
    placeRefusal({
      ...LAPTOP,
      checkout: 'C:\\Users\\Someone\\AppData\\Local\\SIPGES-kit',
      clones,
    }),
    'Este clon (C:\\Users\\Someone\\AppData\\Local\\SIPGES-kit) está dentro de una carpeta SIPGES de %LOCALAPPDATA%, la de la instalación: el kit no escribe ahí. Cloná el commit definitivo en otra carpeta (C:\\SIPGES-kit) y corré el kit desde ahí.',
  );
  assert.equal(
    placeRefusal({ ...LAPTOP, key: 'C:\\Users\\Someone\\sipges\\.data\\k.pem', clones }),
    '--key C:\\Users\\Someone\\sipges\\.data\\k.pem está dentro del clon viejo C:\\Users\\Someone\\sipges: la clave va en su propio USB.',
  );
  assert.equal(
    placeRefusal({ ...LAPTOP, out: 'C:\\Users\\Someone\\sipges', clones }),
    '--out C:\\Users\\Someone\\sipges está dentro del clon viejo C:\\Users\\Someone\\sipges: el kit va al USB de la visita o a una carpeta aparte (C:\\SIPGES-kit-salida).',
  );
  assert.equal(
    placeRefusal({ ...LAPTOP, checkout: '/src/kit', key: '/k/k.pem', out: '/usb', clones: [], localAppData: null, pathApi: posix }),
    null,
  );
});

/** Probes that record their calls under a short name; `over` replaces some. */
const NAMES = {
  pnpmVersion: 'pnpm',
  installed: 'installed',
  clean: 'clean',
  shortcuts: 'shortcuts',
  sipgesAnswers: 'sipges',
  space: 'space',
};
function probes(over = {}) {
  const calls = [];
  const probe = (name, value) => async () => {
    calls.push(name);
    return value;
  };
  return {
    calls,
    probes: {
      nodeVersion: '24.11.1',
      pnpmVersion: probe('pnpm', '12.11.2'),
      installed: probe('installed', true),
      clean: probe('clean', true),
      shortcuts: probe('shortcuts', `${shortcut('C:\\Users\\Someone\\sipges')}\r\n`),
      sipgesAnswers: probe('sipges', false),
      space: probe('space', { freeCheckout: 8 * GiB, freeOut: 8 * GiB, sameDrive: false }),
      ...Object.fromEntries(
        Object.entries(over).map(([name, value]) => [
          name,
          name === 'nodeVersion' ? value : probe(NAMES[name], value),
        ]),
      ),
    },
  };
}
const ALL = ['pnpm', 'installed', 'clean', 'shortcuts', 'sipges', 'space'];

test('preflight: everything in order passes and asks every probe once', async () => {
  const { calls, probes: p } = probes();
  assert.equal(await preflight({ ...LAPTOP, probes: p }), null);
  assert.deepEqual(calls, ALL);
});

test('preflight: the first refusal wins and nothing after it is asked', async () => {
  for (const [over, message, asked] of [
    [{ nodeVersion: '22.11.0' }, /^Node\.js 22\.11\.0 es anterior a 24/, []],
    [{ pnpmVersion: null }, /^Falta pnpm/, ['pnpm']],
    [{ installed: false }, /^this checkout is not installed: run pnpm install --frozen-lockfile$/, ['pnpm', 'installed']],
    [{ clean: false }, /^this checkout has uncommitted changes/, ['pnpm', 'installed', 'clean']],
    [
      { shortcuts: `${shortcut('C:\\SIPGES-KIT')}\r\n` },
      /^Los accesos directos «SIPGES» abren este clon/,
      ['pnpm', 'installed', 'clean', 'shortcuts'],
    ],
    [{ sipgesAnswers: true }, /^SIPGES está abierto/, ALL.slice(0, 5)],
    [
      { space: { freeCheckout: GiB, freeOut: GiB, sameDrive: true } },
      /^Falta espacio en el disco de C:\\SIPGES-kit y de --out F:\\ \(el mismo disco\)/,
      ALL,
    ],
  ]) {
    const { calls, probes: p } = probes(over);
    assert.match((await preflight({ ...LAPTOP, probes: p })) ?? 'accepted', message);
    assert.deepEqual(calls, asked, JSON.stringify(over));
  }
});

test('the real probes: a listening port answers, a closed one does not; free space of a folder', async () => {
  // An ephemeral loopback port, never 8000.
  const server = createServer((socket) => socket.end());
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  const { port } = server.address();
  assert.equal(await portAnswers(port), true);
  await new Promise((done) => server.close(done));
  assert.equal(await portAnswers(port), false);
  await withTemp(async (dir) => {
    const free = freeBytes(dir);
    assert.ok(Number.isFinite(free) && free > 0, `free bytes ${free}`);
    await mkdir(join(dir, 'a'));
    assert.equal(sameDrive(dir, join(dir, 'a')), true);
  });
});

test('the runbook asks for the free space this kit and CI use', async () => {
  const runbook = await readFile(join(repo, 'docs/deployment/desktop-visit.es.md'), 'utf8');
  assert.ok(runbook.includes(`${LAPTOP_FREE_GB} GB libres`), `the runbook lacks «${LAPTOP_FREE_GB} GB libres»`);
  for (const line of [
    'git clone https://github.com/Dreamcoder08/sipges.git C:\\SIPGES-kit',
    'node deploy\\desktop\\windows\\visit-kit.mjs --version <versión> --key K:\\sipges-clave-actualizaciones.pem --out F:\\',
    'node deploy\\desktop\\windows\\visit-kit.mjs --version <versión> --key K:\\sipges-clave-actualizaciones.pem --out C:\\SIPGES-kit-salida',
  ])
    assert.ok(runbook.includes(line), `the runbook lacks ${line}`);
});

test('CLI: --help prints the usage', () => {
  const result = node(kit, '--help');
  assert.equal(result.status, 0);
  assert.match(
    result.stdout,
    /^Usage: node deploy\/desktop\/windows\/visit-kit\.mjs --version <semver> --key /,
  );
  assert.equal(result.stderr, '');
});
