// Stable entry of a managed desktop install. The installers copy this file into the install root
// (outside versions/) and the shortcut starts it, so the shortcut keeps working after updates:
//
//   node <root>/run-current.mjs [--releases <dir>] [--port <port>]
//
// It reads <root>/current.json and runs that version's updater/launcher.mjs with
// `--install <root>` and the same options, then ends with the launcher's exit code (3: an update
// could not be rolled back and nothing was started; the launcher printed what to restore).
// A first SIGINT or SIGTERM is passed on and the launcher stops SIPGES gracefully; a second one is
// passed on too and the launcher kills the server at once. If the launcher is still there 5 s
// later it is killed; its server and boot children end with their pipe from it.
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { setTimeout } from 'node:timers';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';
import console from 'node:console';

const root = dirname(fileURLToPath(import.meta.url));

function currentLauncher() {
  let pointer;
  try {
    pointer = JSON.parse(readFileSync(join(root, 'current.json'), 'utf8'));
  } catch {
    return null;
  }
  if (typeof pointer?.path !== 'string') return null;
  const dir = isAbsolute(pointer.path) ? pointer.path : join(root, ...pointer.path.split('/'));
  return join(dir, 'updater', 'launcher.mjs');
}

const launcher = currentLauncher();
if (!launcher) {
  console.error(
    `SIPGES no está instalado en ${root}: falta current.json. Vuelva a ejecutar el instalador.`,
  );
  process.exit(1);
}
const child = spawn(process.execPath, [launcher, '--install', root, ...process.argv.slice(2)], {
  stdio: 'inherit',
  windowsHide: true,
});
const FORCE_GRACE_MS = 5_000;
let signals = 0;
for (const signal of ['SIGINT', 'SIGTERM'])
  process.on(signal, () => {
    signals += 1;
    child.kill(signal);
    if (signals === 2) setTimeout(() => child.kill('SIGKILL'), FORCE_GRACE_MS).unref();
  });
child.on('error', (error) => {
  console.error(`SIPGES no pudo arrancar ${launcher}: ${error.message}`);
  process.exitCode = 1;
});
child.on('exit', (code, signal) => {
  process.exitCode = code ?? (signal ? 1 : 0);
});
