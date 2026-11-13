// What install.ps1 and start-managed.ps1 do around a halted update. PowerShell does not run here:
// these tests read the scripts, so they pin exact function bodies and the order of top-level
// statements, but cannot prove PowerShell semantics (what Test-Path answers, that `exit` in a
// function ends the script, how a mutex behaves). The Windows drill runs them for real
// (deploy/desktop/windows/drill.mjs, .github/workflows/windows-desktop.yml).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HALT_LINE, PENDING_LINE, haltFallbackNamed, HALT_FALLBACK_GENERIC } from './drill.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const read = async (file) => (await readFile(join(here, file), 'utf8')).replace(/^\uFEFF/, '');

/** The lines of `function <name> …{ … }` without its first and last line. */
function functionBody(text, name) {
  const lines = text.split(/\r?\n/);
  const starts = lines.filter(
    (line) => line.startsWith(`function ${name} `) || line.startsWith(`function ${name}(`),
  );
  assert.equal(starts.length, 1, `function ${name} is defined once`);
  const start = lines.indexOf(starts[0]);
  const end = lines.findIndex((line, i) => i > start && line === '}');
  return lines.slice(start + 1, end).join('\n');
}

/**
 * The statements outside every function with their line number and brace depth (0: not inside
 * an if, try or any other block). Braces inside strings are not expected at the top level.
 */
function topLevel(text) {
  const out = [];
  let inside = false;
  let depth = 0;
  text.split(/\r?\n/).forEach((line, i) => {
    if (line.startsWith('function ')) inside = true;
    else if (inside && line === '}') inside = false;
    else if (!inside && line.trim() && !line.trim().startsWith('#')) {
      out.push({ line, i, depth });
      depth += (line.match(/\{/g) ?? []).length - (line.match(/\}/g) ?? []).length;
    }
  });
  return out;
}

const GUARD = [
  "    $journal = Join-Path $AppRoot 'update-journal.json'",
  '    if (Test-Path -LiteralPath $journal) {',
  `        Stop-Install "${PENDING_LINE} ($journal); no se cambió nada. No borres ni muevas ninguna carpeta de SIPGES. Abre SIPGES desde su acceso directo para que termine de recuperarla; si dice que no se inició, sigue «Si una actualización se detiene a medias» en deploy\\desktop\\README.es.md."`,
  '    }',
].join('\n');

test('install.ps1 stops with exit 1 and a Spanish message while an update journal exists', async () => {
  const script = await read('install.ps1');
  // The whole body: no early return, no other condition, nothing created, moved or deleted.
  assert.equal(functionBody(script, 'Assert-NoPendingUpdate'), GUARD);
  assert.equal(
    functionBody(script, 'Stop-Install'),
    ['    Write-Host $Message -ForegroundColor Red', '    Restore-OutputEncoding', '    exit 1'].join(
      '\n',
    ),
  );
  // The section it names exists in the Spanish README.
  const readme = await readFile(join(here, '..', 'README.es.md'), 'utf8');
  assert.match(readme, /^### Si una actualización se detiene a medias$/m);
});

test('install.ps1 checks for the journal before anything is created, in both modes', async () => {
  const script = await read('install.ps1');
  const statements = topLevel(script);
  const calls = statements.filter(({ line }) => line.includes('Assert-NoPendingUpdate'));
  assert.equal(calls.length, 1, 'called once, at the top level');
  const [guard] = calls;
  assert.deepEqual([guard.line, guard.depth], ['Assert-NoPendingUpdate', 0], 'not inside a block');
  // $AppRoot is set once, at the top level and before the call, and never changed afterwards.
  const assignments = script.split(/\r?\n/).filter((line) => /\$(script:)?AppRoot\s*=[^=]/.test(line));
  assert.deepEqual(assignments, ["$AppRoot = Join-Path $env:LOCALAPPDATA 'SIPGES-app'"]);
  const appRoot = statements.find(({ line }) => line === assignments[0]);
  assert.ok(appRoot && appRoot.depth === 0 && appRoot.i < guard.i, '$AppRoot is set first');
  // Nothing before the call ends the script with success or skips it.
  for (const { line } of statements.filter(({ i }) => i < guard.i))
    assert.doesNotMatch(line, /\bexit 0\b|\breturn\b|Install-Managed|Initialize-State/, line);
  const writers =
    /Install-Managed|Initialize-State|New-Shortcuts|Install-Pnpm|Invoke-Checked|New-Item|Copy-Item|Protect-Path|Set-Location/;
  const later = statements.filter(({ line }) => writers.test(line));
  assert.ok(later.some(({ line }) => line.trim() === 'Install-Managed'));
  assert.ok(later.some(({ line }) => line === 'Initialize-State'));
  for (const { line, i } of later) assert.ok(guard.i < i, `the guard runs before: ${line}`);
});

test('preserved: install.ps1 without a journal still installs the signed release and the state', async () => {
  const script = await read('install.ps1');
  const managed = functionBody(script, 'Install-Managed');
  assert.ok(
    managed.includes(
      "& node (Join-Path $Updater 'update.mjs') --install $AppRoot --release $source --state $State --trust-release-key",
    ),
  );
  assert.ok(managed.includes('    Initialize-State'));
  assert.ok(managed.includes("New-Shortcuts (Join-Path $AppRoot 'start.ps1')"));
  assert.equal(managed.includes('update-journal.json'), false, 'one guard, outside');
});

const FALLBACK = [
  '    try {',
  "        $stateDir = (Get-Content -LiteralPath (Join-Path $Root 'install.json') -Raw -Encoding UTF8 | ConvertFrom-Json).stateDir",
  '        if (($stateDir -is [string]) -and [System.IO.Path]::IsPathRooted($stateDir)) {',
  '            return $HaltNamed -f (Split-Path -Leaf $stateDir), (Split-Path -Parent $stateDir), $stateDir',
  '        }',
  '    } catch { }',
  '    return $HaltGeneric',
].join('\n');

test('start-managed.ps1: with no launcher notice the halt text names the recorded state folder', async () => {
  const script = await read('start-managed.ps1');
  assert.equal(script.includes('%LOCALAPPDATA%\\SIPGES)'), false, 'the old fixed folder is gone');
  assert.equal(functionBody(script, 'Get-HaltFallback'), FALLBACK);
  const halt = functionBody(script, 'Show-Halt');
  assert.ok(halt.includes('if ([string]::IsNullOrWhiteSpace($notice)) { $notice = Get-HaltFallback }'));
  const statements = topLevel(script);
  const named = statements.filter(({ line }) => line.startsWith('$HaltNamed = '));
  const generic = statements.filter(({ line }) => line.startsWith('$HaltGeneric = '));
  assert.equal(named.length, 1);
  assert.equal(generic.length, 1);
  const literal = (line) => /^\$Halt\w+ = '([^']+)'$/.exec(line)?.[1];
  // What -f makes of the named text for a synthetic state folder.
  const state = 'C:\\Users\\synthetic\\AppData\\Local\\SIPGES-datos';
  const shown = literal(named[0].line)
    .replace('{0}', 'SIPGES-datos')
    .replace('{1}', 'C:\\Users\\synthetic\\AppData\\Local')
    .replace('{2}', state);
  assert.equal(
    shown,
    `SIPGES no se inició: una actualización falló y sus datos no se pudieron restaurar. No borre nada. Restaure la copia de seguridad previa a la actualización ${haltFallbackNamed(state)} o contacte con soporte.`,
  );
  assert.equal(
    literal(generic[0].line),
    `SIPGES no se inició: una actualización falló y sus datos no se pudieron restaurar. No borre nada. Restaure la copia de seguridad previa a la actualización ${HALT_FALLBACK_GENERIC} o contacte con soporte.`,
  );
  for (const text of [shown, literal(generic[0].line)]) {
    assert.ok(text.startsWith(HALT_LINE), 'the drill and Show-Halt find it by its start');
    assert.ok(text.includes('.pre-update-'));
  }
});

test('start-managed.ps1 keeps waiting while its launcher runs, up to 5 minutes', async () => {
  const script = await read('start-managed.ps1');
  const statements = topLevel(script);
  assert.deepEqual(
    statements.filter(({ line }) => /^\s*\$WaitSeconds\s*=/.test(line)).map(({ line }) => line),
    ['$WaitSeconds = 300'],
  );
  // The first click: the box only after the launcher ended or the 5 minutes passed.
  const loop = [
    '    $deadline = (Get-Date).AddSeconds($WaitSeconds)',
    '    while (-not (Test-Server)) {',
    '        # Release before the message box so later clicks are not held by an open dialog.',
    '        if ($launcher.HasExited) {',
    '            $booting.ReleaseMutex()',
    '            if ($launcher.ExitCode -eq $HaltExitCode) { Show-Halt }',
    '            Show-Failure "SIPGES se cerró al arrancar. Revisa $Log."',
    '        }',
    '        if ((Get-Date) -gt $deadline) {',
    '            $booting.ReleaseMutex()',
    '            Show-Failure "SIPGES no arrancó en $WaitSeconds segundos. Revisa $Log."',
    '        }',
    '        Start-Sleep -Seconds 1',
    '    }',
  ].join('\n');
  assert.ok(script.includes(loop), 'the first click waits for the launcher');
  // A second click never starts a second launcher: it waits as long as the first one does and
  // ends when the first ended without a server.
  assert.ok(
    script.includes(
      ['    if (-not $created) {', '        Wait-Other $booting', '        Open-App', '        exit 0', '    }'].join('\n'),
    ),
  );
  assert.equal(
    functionBody(script, 'Wait-Other'),
    [
      '    $deadline = (Get-Date).AddSeconds($WaitSeconds)',
      '    while (-not (Test-Server)) {',
      '        # Free: the other start ended without a server (it showed its own message). Abandoned',
      '        # (that start was killed) counts as free and is now held here.',
      '        $ended = $false',
      '        try { $ended = $Mutex.WaitOne(0) } catch { $ended = $true }',
      '        if ($ended) {',
      '            $Mutex.ReleaseMutex()',
      '            Show-Failure "SIPGES no arrancó. Revisa $Log."',
      '        }',
      '        if ((Get-Date) -gt $deadline) { Show-Failure "SIPGES no arrancó en $WaitSeconds segundos. Revisa $Log." }',
      '        Start-Sleep -Seconds 1',
      '    }',
    ].join('\n'),
  );
  assert.equal(script.includes('Wait-Server'), false);
  assert.equal((script.match(/Start-Launcher/g) ?? []).length, 2, 'defined once, called once');
});

test('preserved: start-managed.ps1 still shows the launcher notice first and exits 3', async () => {
  const script = await read('start-managed.ps1');
  const halt = functionBody(script, 'Show-Halt');
  assert.ok(halt.includes('Where-Object { $_ -like $HaltPrefix } | Select-Object -Last 1'));
  assert.ok(halt.includes('Show-Message $notice'));
  assert.ok(halt.includes('exit $HaltExitCode'));
  assert.ok(script.includes('$HaltExitCode = 3'));
  assert.ok(script.includes(`$HaltPrefix = '${HALT_LINE}*'`));
  assert.equal((script.match(/ExitCode -eq \$HaltExitCode/g) ?? []).length, 2);
});
