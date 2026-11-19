// A portable Go for building the visit kit on the laptop (docs/deployment/desktop-visit.es.md,
// «Paso K»), installing nothing in the system:
//
//   node deploy\desktop\windows\portable-go.mjs --out C:\SIPGES-go
//
// portable-go.json pins the official go<version>.windows-amd64.zip from https://go.dev/dl/ by URL,
// size and SHA-256; its version is the go line of apps/api-go/go.mod (a test keeps them equal).
// It refuses an existing --out before downloading anything, downloads the zip into a staging folder
// beside --out, and unpacks it only when size and SHA-256 match the pin: a mismatching download is
// deleted and nothing is unpacked. The result is <out>\go (GOROOT); the last line printed is
// <out>\go\bin, which the runbook puts on the PATH of that PowerShell session only. Never Program
// Files, never the system PATH, never the registry; deleting <out> removes it. Needs Node only.
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createWriteStream, existsSync } from 'node:fs';
import { mkdir, readFile, rename, rm } from 'node:fs/promises';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';
import console from 'node:console';
import { nodeGet } from '../postgresql/bundle.mjs';

const here = dirname(fileURLToPath(import.meta.url));
export const PIN_FILE = join(here, 'portable-go.json');
const USAGE = 'Uso: node deploy\\desktop\\windows\\portable-go.mjs --out <carpeta nueva>';

/** <out>\go\bin: where go.exe lands. */
export const binPath = (out) => join(out, 'go', 'bin');

/** The pin, checked: a mistake here must stop, never download something else. */
export function checkPin(pin) {
  const problems = [];
  if (!/^\d+\.\d+\.\d+$/.test(pin.version ?? '')) problems.push('version no es <mayor>.<menor>.<parche>');
  if (pin.file !== `go${pin.version}.windows-amd64.zip`) problems.push('file no es go<version>.windows-amd64.zip');
  if (pin.url !== `https://go.dev/dl/${pin.file}`) problems.push('url no es https://go.dev/dl/<file>');
  if (!/^[0-9a-f]{64}$/.test(pin.sha256 ?? '')) problems.push('sha256 no son 64 dígitos hexadecimales');
  if (!Number.isInteger(pin.size) || pin.size <= 0) problems.push('size no es un tamaño en bytes');
  if (problems.length) throw new Error(`portable-go.json no es válido: ${problems.join('; ')}`);
  return pin;
}

export async function readPin(file = PIN_FILE) {
  return checkPin(JSON.parse(await readFile(file, 'utf8')));
}

export function parseArgs(args) {
  if (args.length === 1 && args[0] === '--help') return { out: undefined, help: true };
  if (args.length !== 2 || args[0] !== '--out' || !args[1]) throw new Error(USAGE);
  return { out: args[1], help: false };
}

/** Windows' own tar (bsdtar reads zip); unzip elsewhere (tests only). */
function extractCommand(zip, dir, platform) {
  if (platform === 'win32')
    return { file: join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe'), args: ['-x', '-f', zip, '-C', dir] };
  return { file: 'unzip', args: ['-q', zip, '-d', dir] };
}

/**
 * Downloads, verifies and unpacks the pinned Go into `out` (a new folder). Returns the bin path.
 * A failure leaves neither `out` nor the download behind. `fetchImpl` is for tests (a web
 * Response); the real run uses node:https through bundle.mjs's nodeGet.
 */
export async function installPortableGo({
  out,
  pin,
  fetchImpl,
  platform = process.platform,
  arch = process.arch,
  requireWindows = false,
  say = () => {},
}) {
  pin = checkPin(pin ?? (await readPin()));
  if (requireWindows && (platform !== 'win32' || arch !== 'x64'))
    throw new Error(`El Go fijado es para Windows x64; esta computadora es ${platform}-${arch}. Nada se descargó.`);
  if (existsSync(out))
    throw new Error(`${out} ya existe. El Go portable va a una carpeta nueva: si quedó de un intento anterior, borrala y repetí. Nada se descargó.`);
  const staging = `${out}.${randomUUID()}.partial`;
  await mkdir(staging, { recursive: true });
  let created = false;
  try {
    const zip = join(staging, pin.file);
    say(`Descargando Go ${pin.version} (${Math.round(pin.size / 1e6)} MB) de ${pin.url}`);
    const offline = (cause) =>
      new Error(`No se pudo descargar Go ${pin.version} de ${pin.url} (${cause}). Revisá la red y repetí el comando. Nada se descomprimió.`);
    let body;
    try {
      if (fetchImpl) {
        const response = await fetchImpl(pin.url, { redirect: 'follow' });
        if (!response.ok || !response.body) throw offline(`HTTP ${response.status}`);
        body = Readable.fromWeb(response.body);
      } else {
        body = await nodeGet(pin.url);
      }
    } catch (error) {
      if (error.message.startsWith('No se pudo descargar Go')) throw error;
      throw offline(error.cause?.code ?? error.code ?? error.message);
    }
    const hash = createHash('sha256');
    let bytes = 0;
    const tap = new Transform({
      transform(chunk, _encoding, done) {
        hash.update(chunk);
        bytes += chunk.length;
        done(null, chunk);
      },
    });
    try {
      await pipeline(body, tap, createWriteStream(zip, { flags: 'wx' }));
    } catch (error) {
      throw offline(`interrumpida: ${error.cause?.code ?? error.message}`);
    }
    const actual = hash.digest('hex');
    if (bytes !== pin.size || actual !== pin.sha256)
      throw new Error(
        `La descarga de ${pin.url} no es el Go ${pin.version} fijado: ${bytes} bytes con SHA-256 ${actual}, ` +
          `se esperaban ${pin.size} bytes con SHA-256 ${pin.sha256}. Se borró; no se descomprimió nada.`,
      );
    const unpacked = join(staging, 'unpacked');
    await mkdir(unpacked);
    const { file, args } = extractCommand(zip, unpacked, platform);
    const result = spawnSync(file, args, { encoding: 'utf8' });
    if (result.error || result.status !== 0)
      throw new Error(`No se pudo descomprimir ${zip} con ${file}: ${result.error?.message ?? (result.stderr || `código ${result.status}`).trim()}`);
    if (!existsSync(join(unpacked, 'go', 'bin', 'go.exe')))
      throw new Error(`El zip de Go ${pin.version} no trae go/bin/go.exe; no se usó.`);
    await mkdir(out);
    created = true;
    await rename(join(unpacked, 'go'), join(out, 'go'));
  } catch (error) {
    if (created) await rm(out, { recursive: true, force: true }).catch(() => {});
    throw error;
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
  say(`Go ${pin.version} portable listo en ${join(out, 'go')} (SHA-256 ${pin.sha256} verificado). No se instaló nada en el sistema.`);
  return binPath(out);
}

async function main(args) {
  const { out, help } = parseArgs(args);
  if (help) return console.log(USAGE);
  const bin = await installPortableGo({ out: resolve(out), requireWindows: true, say: console.log });
  console.log(bin);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(`Error: ${error.message}`);
    process.exitCode = 1;
  });
}
