// The Go mode of start-managed.ps1 (go-rust-stack T72c, T72d3, docs/adr/0036). PowerShell does
// not run here: like halt-scripts.test.mjs these tests read the script and pin how it chooses
// between the Go launcher and the TypeScript one, and what the Go launcher is given. The workflow's go-mode job runs
// it for real on Windows (deploy/desktop/windows/go-drill.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GO_NOT_MOVED_LINE, GO_MISSING_LINE, imageName, nextVersion, parseOptions, postmasterPort, withoutNode } from './go-drill.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const read = async (file) => (await readFile(join(here, file), 'utf8')).replace(/^\uFEFF/, '');
const code = (text) => text.split(/\r?\n/).filter((line) => line.trim() && !line.trim().startsWith('#'));

function functionBody(text, name) {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((line) => line.startsWith(`function ${name} `) || line.startsWith(`function ${name}(`));
  assert.ok(start >= 0, `function ${name} is defined`);
  const end = lines.findIndex((line, i) => i > start && line === '}');
  return lines.slice(start + 1, end).join('\n');
}

test('start-managed.ps1 chooses the launcher once, before reusing or starting a server', async () => {
  const script = await read('start-managed.ps1');
  assert.equal(code(script)[0], 'param([switch]$Go)', '-Go stays an optional switch');
  const choices = code(script).filter((line) => line.includes('Start-Launcher') && !line.startsWith('function '));
  assert.deepEqual(choices, ['    $launcher = if ($UseGo) { Start-GoServer $GoServer } else { Start-Launcher }']);
  // Go whenever the install can run it; -Go only adds the refusal when it cannot.
  const choose = [
    '    $GoServer = Get-GoServer',
    '    $UseGo = -not $GoServer.Reason',
    '    if ($Go -and -not $UseGo) { Show-Failure $GoServer.Reason }',
    '    if (Test-Server) {',
  ].join('\n');
  assert.ok(script.includes(choose), 'the Go checks run first, before any server is reused or started');
  assert.equal(functionBody(script, 'Start-Launcher').includes('sipges-desktop'), false, 'the TypeScript path is untouched');
});

test('start-managed.ps1 starts the Go launcher of the install with its releases folder and bundled PostgreSQL', async () => {
  const script = await read('start-managed.ps1');
  const start = functionBody(script, 'Start-GoServer');
  for (const line of [
    '    $env:SIPGES_PG_BIN = $Server.PgBin',
    `    $command = '"{0}" --install "{1}" --releases "{2}" >> "{3}" 2>&1' -f $Server.Exe, $Root,`,
    "        (Join-Path $Root 'releases'), $Log",
  ])
    assert.ok(start.includes(line), line);
  assert.equal(/--port|8000|node/.test(start), false, 'sipges-desktop serves on its default 127.0.0.1:8000, without Node');
  const resolve = functionBody(script, 'Get-GoServer');
  for (const part of ["'go\\sipges-desktop.exe'", "'postgresql\\bin'", "'current.json'", "'install.json'", '.stateDir'])
    assert.ok(resolve.includes(part), part);
});

test('start-managed.ps1 keeps data only in PGlite, and versions without Go, on the TypeScript launcher', async () => {
  const script = await read('start-managed.ps1');
  const resolve = functionBody(script, 'Get-GoServer');
  assert.ok(resolve.includes(`return @{ Reason = '${GO_MISSING_LINE}' }`));
  assert.ok(resolve.includes(`return @{ Reason = '${GO_NOT_MOVED_LINE}' }`));
  // PGlite holds data (anything in pglite\) and pg18\ has no cluster: the data were not moved.
  assert.ok(resolve.includes("Get-ChildItem -LiteralPath (Join-Path $state 'pglite') -Force -ErrorAction SilentlyContinue"));
  assert.ok(resolve.includes("Test-Path -LiteralPath (Join-Path $state 'pg18\\PG_VERSION')"));
  assert.equal(/Start-Process|New-Item|Remove-Item|Set-Content|Show-Failure/.test(resolve), false, 'it changes and shows nothing');
});

test('go-drill.mjs: options, the cluster port in postmaster.pid, image names', () => {
  const now = new Date('2026-11-18T01:02:03Z');
  const options = parseOptions([], { now, tmp: join('/', 'tmp') });
  assert.equal(options.version, '0.0.9-go.20261118010203');
  assert.equal(options.work, resolve(join('/', 'tmp', 'sipges-go-drill-20261118010203')));
  assert.equal(options.logs, join(options.work, 'logs'));
  assert.throws(() => parseOptions(['--work']), /Invalid options/);
  assert.throws(() => parseOptions(['--old-commit', 'x']), /Invalid options/);
  assert.equal(postmasterPort('1234\r\nC:\\pg18\r\n1763420000\r\n54321\r\n\r\n127.0.0.1\r\n'), 54321);
  assert.equal(postmasterPort('1234\n/pg18\n'), null);
  assert.equal(imageName('"api.exe","4242","Console","1","20,000 K"\r\n'), 'api.exe');
  assert.equal(imageName('INFO: No tasks are running which match the specified criteria.'), null);
});

// Review R4: a SIPGES already answering is reused only in the mode asked for, on every path that
// opens it (already running, a second click, its own start): Open-App checks who serves first.
test('start-managed.ps1 reuses a running SIPGES only in the install\'s mode', async () => {
  const script = await read('start-managed.ps1');
  assert.ok(functionBody(script, 'Open-App').startsWith('    Assert-ServedMode\n'), 'Open-App checks the runtime first');
  const assertMode = functionBody(script, 'Assert-ServedMode');
  assert.ok(assertMode.includes("if ($UseGo -and $image -ne 'api') { Show-Failure 'SIPGES ya está abierto sin el modo Go. Ciérrelo antes de abrirlo en modo Go.' }"));
  assert.ok(assertMode.includes("if (-not $UseGo -and $image -eq 'api') { Show-Failure 'SIPGES ya está abierto en modo Go. Ciérrelo antes de abrirlo sin el modo Go.' }"));
  const image = functionBody(script, 'Get-ServerImage');
  assert.ok(image.includes('Get-NetTCPConnection -LocalPort 8000 -State Listen'));
  assert.ok(image.includes('(Get-Process -Id $owner -ErrorAction Stop).ProcessName'));
});

test('go-drill.mjs: the update version and a PATH without Node', () => {
  assert.equal(nextVersion('0.0.9-go.20261118010203'), '0.0.10-go.20261118010203');
  assert.equal(nextVersion('1.2.3'), '1.2.4');
  assert.throws(() => nextVersion('1.2'), /Invalid version/);
  const env = { Path: 'C:\\Windows;C:\\node24;;C:\\Go\\bin', OTHER: 'x' };
  const hasNode = (dir) => dir === 'C:\\node24';
  assert.deepEqual(withoutNode(env, hasNode), { Path: 'C:\\Windows;C:\\Go\\bin', OTHER: 'x' });
  assert.deepEqual(withoutNode({ PATH: 'C:\\node24' }, hasNode), { PATH: '' });
});
