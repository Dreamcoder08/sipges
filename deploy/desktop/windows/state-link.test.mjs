// install.ps1 -Release … -State <folder> refuses a link, a junction or a path to the original
// %LOCALAPPDATA%\SIPGES before anything is written. PowerShell does not run here: these tests read
// the scripts, so they pin the guard's body and where it is called, not PowerShell semantics (what
// Get-Item reports for a junction, what realpathSync.native answers). The Windows drill runs it for
// real (deploy/desktop/windows/drill.mjs, .github/workflows/windows-desktop.yml).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { STATE_LINK_LINE } from './drill.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const read = async (file) => (await readFile(join(here, file), 'utf8')).replace(/^\uFEFF/, '');

/** The lines of `function <name> …{ … }` without its first and last line. */
function functionBody(text, name) {
  const lines = text.split(/\r?\n/);
  const starts = lines.filter((line) => line.startsWith(`function ${name} `));
  assert.equal(starts.length, 1, `function ${name} is defined once`);
  const start = lines.indexOf(starts[0]);
  const end = lines.findIndex((line, i) => i > start && line === '}');
  return lines.slice(start + 1, end);
}

const realpath = (variable) =>
  `(& node -p "require('fs').realpathSync.native(process.argv[1])" ${variable}) -join ''`;
const GUARD = [
  "    $original = Join-Path $env:LOCALAPPDATA 'SIPGES'",
  '    $item = Get-Item -LiteralPath $State -Force -ErrorAction SilentlyContinue',
  '    if ($item -and ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) {',
  `        Stop-Install "La carpeta de datos $State ${STATE_LINK_LINE}: pasa con -State la carpeta real de la copia, nunca un enlace a ella; no se cambió nada."`,
  '    }',
  // Only a first install: a rerun naming its recorded folder is still accepted.
  "    $first = -not (Test-Path -LiteralPath (Join-Path $AppRoot 'install.json'))",
  '    if ($first -and (Test-Path -LiteralPath $State) -and (Test-Path -LiteralPath $original)) {',
  `        $real = ${realpath('$State')}`,
  `        if ($real -and ($real -eq (${realpath('$original')}))) {`,
  '            Stop-Install "-State $State lleva a la carpeta de datos original ${original}: pasa con -State la carpeta real de la copia, nunca la original ni un enlace a ella; no se cambió nada."',
  '        }',
  '    }',
];
const WRITERS =
  /New-Item|Copy-Item|Remove-Item|Move-Item|Set-Content|Protect-Path|Initialize-State|Invoke-Checked|New-Shortcuts|WriteAllText|update\.mjs|\$script:State/;

test('install.ps1 refuses a -State that is a link, a junction or the original folder', async () => {
  const script = await read('install.ps1');
  // The whole body: two refusals, each ending the script with exit 1; nothing written.
  assert.deepEqual(functionBody(script, 'Assert-StateIsCopy'), GUARD);
  for (const line of GUARD) assert.doesNotMatch(line, WRITERS, line);
});

test('install.ps1 checks a given -State before the managed install reads, records or writes', async () => {
  const managed = functionBody(await read('install.ps1'), 'Install-Managed');
  const calls = managed.filter((line) => line.includes('Assert-StateIsCopy'));
  assert.deepEqual(
    calls,
    ['    if ($StateGiven) { Assert-StateIsCopy }'],
    'called once, on -State',
  );
  const guard = managed.indexOf(calls[0]);
  // Before the recorded state replaces $State on a rerun, and before anything is written.
  const recorded = managed.findIndex((line) => line.includes('Get-RecordedState'));
  assert.ok(recorded > guard, 'before Get-RecordedState');
  for (const [i, line] of managed.entries())
    if (WRITERS.test(line)) assert.ok(i > guard, `the guard runs before: ${line.trim()}`);
  for (const line of managed.slice(0, guard))
    assert.doesNotMatch(line, /\breturn\b|exit 0/, `nothing skips the guard: ${line.trim()}`);
});

test('the drill makes a junction to the original before the managed install and expects the refusal', async () => {
  const drill = await read('drill.mjs');
  const at = (text) => {
    const i = drill.indexOf(text);
    assert.ok(i > 0, `the drill has: ${text}`);
    return i;
  };
  const junction = at("'mklink', '/J'");
  const refusal = at('${junctionDir} ${STATE_LINK_LINE}');
  const removed = at("['/d', '/c', 'rmdir', junctionDir]");
  const install = at("['-Release', releaseN, '-State', moved]");
  assert.ok(junction < refusal && refusal < removed && removed < install, 'in that order');
  assert.ok(at('step(') < junction);
  assert.doesNotMatch(drill, /rmdir[^\n]*\/[sS]\b/, 'the junction is never removed recursively');
});
