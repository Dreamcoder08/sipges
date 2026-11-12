// End-to-end rehearsal of the data move (closure-roadmap T33) and of the backup drill (T11),
// with synthetic data only, on Linux:
//
//   node deploy/desktop/migration/rehearse.mjs <source-commit> [--package <built package dir>]
//
// 1. A scratch git worktree of <source-commit> (the version installed on the laptop) under
//    .data/migration-rehearsal/<run>/old, checked out without its data/ folder, so the old API
//    can never read a repository dataset. Dependencies and the web app are built there like the
//    old Windows installer does.
// 2. The old API runs with the old launcher's environment on a scratch state folder (pglite,
//    uploads, data-key and admin-password made like install.ps1 makes them, api.log appended),
//    on a free loopback port (never 8000 or 18080). Synthetic data goes in through the public
//    HTTP API: two projects, records in several modules (one id shared by both projects), links,
//    uploads, an administrator with MFA and a second account without it; the audit trail follows.
// 3. snapshot.mjs; the old API stops; the state folder is copied.
// 4. The definitive package is built from this checkout (deploy/desktop/package/builder.mjs) or
//    taken from --package, signed with a throwaway in-memory key, and installed in managed mode
//    with deploy/desktop/linux/install.sh pointing at the COPY, under a scratch HOME.
// 5. The stable entry (run-current.mjs) starts it: the first start copies the folder, rehearses
//    the migration on a second copy, migrates, starts. compare.mjs must print no difference; the
//    original folder must be byte-identical; the second account still signs in.
// 6. Rule d: installer and start again; nothing new beside the folder; compare again.
// 7. T11: stop, copy the state folder, delete it, restore it from the copy, start, compare.
//
// The scratch worktree and the signed release copy are removed at the end; the state folders,
// snapshots and logs stay under .data/migration-rehearsal/<run> (ignored by Git) as evidence.
// Every process it starts is stopped and awaited on every way out: the end, an error, or SIGINT
// or SIGTERM (exit code 130; a second signal kills them at once).
/* global fetch, FormData */
import { Blob } from 'node:buffer';
import { spawn, spawnSync } from 'node:child_process';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { cp, lstat, mkdir, open, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import process from 'node:process';
import console from 'node:console';
import { freePort } from '../updater/boot.mjs';
import { createRelease } from '../updater/release.mjs';
import { sha256, signIn, totp, nextStep } from './client.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '../../..');
const FORBIDDEN_PORTS = new Set([8000, 18080]);
const ALFA = 'SINTETICA/PRJ-ALFA';
const BETA = 'SINTETICA/PRJ-BETA';
const ANALYST = 'analista-sintetica';

const say = (line) => console.log(line);

// The processes this rehearsal started and that have not ended yet.
const running = new Set();
let interrupted = null;
let handlingInterrupts = false;
const STOP_GRACE_MS = 30_000;

const ended = (child) => child.exitCode !== null || child.signalCode !== null;
const checkInterrupted = () => {
  if (interrupted) throw new Error(`interrupted by ${interrupted}`);
};
const step = (title) => {
  checkInterrupted();
  say(`\n== ${title}`);
};

/** Keeps the child in `running` until it ends; `child.ended` resolves with its exit code. */
function track(child) {
  running.add(child);
  child.ended = new Promise((resolveEnded) => {
    const done = () => {
      running.delete(child);
      resolveEnded(child.exitCode);
    };
    child.once('exit', done);
    // A process that could not be started emits no exit.
    child.once('error', () => {
      if (child.pid === undefined) done();
    });
  });
  return child;
}

/**
 * Stops a process this rehearsal started and waits until it is gone: SIGTERM, then SIGKILL
 * after the grace time. Returns its exit code (null when it ended by a signal). A process that
 * already ended, by a signal too, returns at once.
 */
export async function stop(child, { graceMs = STOP_GRACE_MS } = {}) {
  if (!ended(child)) {
    child.kill('SIGTERM');
    const gone = await Promise.race([
      child.ended.then(() => true),
      sleep(graceMs, false, { ref: false }),
    ]);
    if (!gone) child.kill('SIGKILL');
  }
  return child.ended;
}

/** Stops and awaits every process still running. */
export const stopAll = () => Promise.all([...running].map((child) => stop(child)));

/**
 * SIGINT or SIGTERM: every process this rehearsal started is stopped and awaited, the running
 * step fails and the clean-up runs; exit code 130. A second signal kills them at once and exits.
 */
export function handleInterrupts() {
  if (handlingInterrupts) return;
  handlingInterrupts = true;
  for (const signal of ['SIGINT', 'SIGTERM'])
    process.on(signal, () => {
      process.exitCode = 130;
      if (interrupted) {
        for (const child of running) child.kill('SIGKILL');
        process.exit(130);
      }
      interrupted = signal;
      say(`\n${signal}: stopping every process of the rehearsal`);
      void stopAll();
    });
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: 'inherit', ...options });
  if (result.error || result.status !== 0)
    throw new Error(
      `${command} ${args.join(' ')} failed (${result.error?.message ?? result.status})`,
    );
  return result;
}

/** The process environment without any SIPGES_* name, with a scratch HOME. */
function cleanEnv(home, extra = {}) {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith('SIPGES_')),
  );
  delete env.XDG_DATA_HOME;
  return { ...env, HOME: home, ...extra };
}

async function port() {
  for (;;) {
    const found = await freePort();
    if (!FORBIDDEN_PORTS.has(found)) return found;
  }
}

async function waitReady(base, child, seconds) {
  for (let waited = 0; waited < seconds * 2; waited += 1) {
    checkInterrupted();
    if (ended(child))
      throw new Error(`the server exited with code ${child.exitCode ?? child.signalCode}`);
    try {
      const response = await fetch(`${base}/health/ready`);
      await response.arrayBuffer();
      if (response.status === 200) return waited / 2;
    } catch {
      // Not listening yet.
    }
    await sleep(500);
  }
  throw new Error(`${base} was not ready within ${seconds} s`);
}

/**
 * Starts a process with its output appended to `log`, tracked until it ends. With `ready`
 * (`{ base, seconds }`) it resolves only once `<base>/health/ready` answers 200 (`readyIn`
 * holds the seconds it took); a start that fails is stopped and awaited before it rejects.
 */
export async function startLogged(command, args, { cwd, env, log, ready }) {
  handleInterrupts();
  checkInterrupted();
  const output = await open(log, 'a', 0o600);
  const child = track(spawn(command, args, { cwd, env, stdio: ['ignore', output.fd, output.fd] }));
  void child.ended.then(() => output.close().catch(() => {}));
  if (ready)
    try {
      child.readyIn = await waitReady(ready.base, child, ready.seconds);
    } catch (error) {
      await stop(child);
      throw error;
    }
  return child;
}

/** Relative path -> SHA-256 of every file (content only), to prove a folder unchanged. */
async function tree(dir) {
  const out = {};
  const walk = async (path) => {
    for (const entry of (await readdir(path, { withFileTypes: true })).sort((a, b) =>
      a.name < b.name ? -1 : 1,
    )) {
      const full = join(path, entry.name);
      if (entry.isDirectory()) await walk(full);
      else out[relative(dir, full)] = sha256(await readFile(full));
    }
  };
  await walk(dir);
  return out;
}
const digest = (map) => sha256(JSON.stringify(map)).slice(0, 16);
const sizeOf = async (dir) => {
  let bytes = 0;
  const files = Object.keys(await tree(dir));
  for (const file of files) bytes += (await lstat(join(dir, file))).size;
  return { files: files.length, bytes };
};
/** Files and bytes of a folder with the command of the README, step 3 (Linux). */
const counted = (dir) =>
  spawnSync(
    'sh',
    ['-c', `find "$1" -type f -printf '%s\\n' | awk '{n++; s+=$1} END {print n, s}'`, 'sh', dir],
    {
      encoding: 'utf8',
    },
  ).stdout.trim();
const siblingsOf = async (state) =>
  (await readdir(dirname(state)))
    .filter((name) => name.startsWith(`${state.split('/').pop()}.`))
    .sort();

function check(condition, label) {
  if (!condition) throw new Error(`Check failed: ${label}`);
  say(`ok - ${label}`);
}

/** Like install.ps1 (Save-Secret): base64 of random bytes, written without a newline. */
async function oldStateFolder(state) {
  await mkdir(join(state, 'pglite'), { recursive: true, mode: 0o700 });
  await mkdir(join(state, 'uploads'), { recursive: true, mode: 0o700 });
  await writeFile(join(state, 'data-key'), randomBytes(32).toString('base64'), { mode: 0o600 });
  const password = randomBytes(24)
    .toString('base64')
    .replace(/\+/g, 'A')
    .replace(/\//g, 'B')
    .replace(/=/g, '');
  await writeFile(join(state, 'admin-password'), password, { mode: 0o600 });
}

/** The old worktree without data/: index from the commit, every other file checked out. */
function oldWorktree(commit, dir) {
  run('git', ['-C', repo, 'worktree', 'add', '--detach', '--no-checkout', dir, commit]);
  run('git', ['-C', dir, 'read-tree', 'HEAD']);
  const listed = spawnSync('git', ['-C', dir, 'ls-files', '-z'], { encoding: 'buffer' });
  if (listed.status !== 0) throw new Error('git ls-files failed');
  const files = listed.stdout
    .toString('utf8')
    .split('\0')
    .filter((file) => file && !file.startsWith('data/'));
  run('git', ['-C', dir, 'checkout-index', '-z', '--stdin'], {
    input: `${files.join('\0')}\0`,
    stdio: ['pipe', 'inherit', 'inherit'],
  });
}

const json = (body) => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

async function expectOk(response, label) {
  const text = await response.text();
  if (response.status !== 200) throw new Error(`${label}: status ${response.status}`);
  return text ? JSON.parse(text) : null;
}

/** Synthetic records per project; EV-COMUN-001 exists in both with different content. */
const RECORDS = {
  [ALFA]: [
    [
      'eventos',
      {
        ID_Evento: 'EV-ALFA-001',
        Titulo: 'Reunión sintética Ñandú',
        Fecha: '2026-03-01',
        Lugar: 'Caserío Ficticio Uno',
        Participantes: 12,
      },
    ],
    [
      'eventos',
      {
        ID_Evento: 'EV-ALFA-002',
        Titulo: 'Taller ficticio',
        Estado: 'Abierto',
        Etiquetas: ['agua', 'camino'],
      },
    ],
    ['eventos', { ID_Evento: 'EV-COMUN-001', Titulo: 'Evento común, versión Alfa' }],
    [
      'actores',
      { ID_Actor: 'A-ALFA-001', Nombre: 'Asociación Ficticia Los Álamos', Tipo: 'Organización' },
    ],
    ['actores', { ID_Actor: 'A-ALFA-002', Nombre: 'Comité Inventado', Tipo: 'Comunidad' }],
    [
      'demandas',
      { ID_Demanda: 'D-ALFA-001', Texto: 'Mejorar el camino ficticio', Prioridad: 'Alta' },
    ],
    [
      'compromisos',
      {
        ID_Compromiso: 'C-ALFA-001',
        Texto: 'Mantenimiento sintético',
        Responsable: 'Equipo Ficticio',
      },
    ],
    ['fuentes', { ID_Fuente: 'F-ALFA-001', Titulo: 'Acta sintética', Tipo: 'Acta' }],
    ['alertas', { ID_Alerta: 'AL-ALFA-001', Titulo: 'Alerta sintética', Nivel: 'Media' }],
  ],
  [BETA]: [
    ['eventos', { ID_Evento: 'EV-BETA-001', Titulo: 'Visita ficticia', Fecha: '2026-04-15' }],
    ['eventos', { ID_Evento: 'EV-COMUN-001', Titulo: 'Evento común, versión Beta' }],
    [
      'actores',
      { ID_Actor: 'A-BETA-001', Nombre: 'Junta Vecinal Imaginaria', Tipo: 'Organización' },
    ],
    ['demandas', { ID_Demanda: 'D-BETA-001', Texto: 'Agua potable ficticia', Prioridad: 'Media' }],
  ],
};
const LINKS = {
  [ALFA]: [
    ['plantea', ['actores', 'A-ALFA-001'], ['demandas', 'D-ALFA-001']],
    ['participa_en', ['actores', 'A-ALFA-002'], ['eventos', 'EV-ALFA-001']],
    ['sustenta', ['fuentes', 'F-ALFA-001'], ['compromisos', 'C-ALFA-001']],
    ['responde_a', ['compromisos', 'C-ALFA-001'], ['demandas', 'D-ALFA-001']],
  ],
  [BETA]: [['plantea', ['actores', 'A-BETA-001'], ['demandas', 'D-BETA-001']]],
};
const UPLOADS = {
  [ALFA]: [
    [
      'acta-sintetica-alfa.txt',
      'compromisos',
      'C-ALFA-001',
      'Acta sintética: ñandú, camión, acción.\n',
    ],
    [
      'lista-sintetica-alfa.csv',
      'eventos',
      'EV-ALFA-001',
      'nombre,cargo\nPersona Ficticia,Vocal\n',
    ],
  ],
  [BETA]: [['informe-sintetico-beta.txt', 'demandas', 'D-BETA-001', 'Informe sintético Beta.\n']],
};

async function seed(base, state, work) {
  const totpState = join(work, 'totp-state.json');
  const password = (await readFile(join(state, 'admin-password'), 'utf8')).trim();
  const first = await signIn({ base, username: 'admin', password });
  const setup = await expectOk(
    await first.call('/system/auth/totp/setup', { method: 'POST' }),
    'MFA setup',
  );
  await expectOk(
    await first.call(
      '/system/auth/totp/enable',
      json({ code: totp(setup.secret, await nextStep(totpState)) }),
    ),
    'MFA enable',
  );
  const secretFile = join(work, 'admin-totp-secret');
  await writeFile(secretFile, `${setup.secret}\n`, { mode: 0o600 });
  const admin = await signIn({
    base,
    username: 'admin',
    password,
    totpSecret: setup.secret,
    totpState,
  });
  for (const [scope, label] of [
    [ALFA, 'Proyecto Alfa (sintético)'],
    [BETA, 'Proyecto Beta (sintético)'],
  ]) {
    const [company_id, project_id] = scope.split('/');
    await expectOk(
      await admin.call(
        '/system/auth/scopes',
        json({ company_id, project_id, label, username: 'admin' }),
      ),
      `create ${scope}`,
    );
  }
  for (const [scope, rows] of Object.entries(RECORDS))
    for (const [slug, payload] of rows)
      await expectOk(
        await admin.call(`/api/${slug}`, { scope, ...json({ payload }) }),
        `create ${slug}`,
      );
  await expectOk(
    await admin.call('/api/eventos/EV-ALFA-001', {
      scope: ALFA,
      ...json({ payload: { ...RECORDS[ALFA][0][1], Participantes: 14 } }),
      method: 'PUT',
    }),
    'update EV-ALFA-001',
  );
  for (const [scope, links] of Object.entries(LINKS))
    for (const [link_type, [sm, sid], [tm, tid]] of links)
      await expectOk(
        await admin.call('/system/links', {
          scope,
          ...json({
            link_type,
            source: { module: sm, id: sid },
            target: { module: tm, id: tid },
            note: 'Vínculo sintético',
          }),
        }),
        `link ${link_type}`,
      );
  for (const [scope, uploads] of Object.entries(UPLOADS))
    for (const [name, module, id, text] of uploads) {
      const form = new FormData();
      form.set('file', new Blob([text], { type: 'text/plain' }), name);
      form.set('linked_module', module);
      form.set('linked_record_id', id);
      await expectOk(
        await admin.call('/system/uploads', { scope, method: 'POST', body: form }),
        `upload ${name}`,
      );
    }
  const analystPassword = `Analista-${randomBytes(9).toString('base64url')}`;
  await writeFile(join(work, 'analyst-password'), `${analystPassword}\n`, { mode: 0o600 });
  await expectOk(
    await admin.call('/system/auth/accounts', {
      scope: ALFA,
      ...json({
        username: ANALYST,
        full_name: 'Analista Sintética',
        password: analystPassword,
        role: 'analista',
      }),
    }),
    'create account',
  );
  const [company_id, project_id] = ALFA.split('/');
  await expectOk(
    await admin.call('/system/auth/grants', json({ username: ANALYST, company_id, project_id })),
    'grant',
  );
  // The second account enrolls MFA too: without it every scoped route answers 403, and the
  // access check below would compare refusals instead of the projects it can open.
  const analystTotpState = join(work, 'analyst-totp-state.json');
  const analystFirst = await signIn({ base, username: ANALYST, password: analystPassword });
  const analystSetup = await expectOk(
    await analystFirst.call('/system/auth/totp/setup', { method: 'POST' }),
    'second account MFA setup',
  );
  await expectOk(
    await analystFirst.call(
      '/system/auth/totp/enable',
      json({ code: totp(analystSetup.secret, await nextStep(analystTotpState)) }),
    ),
    'second account MFA enable',
  );
  const analyst = {
    password: analystPassword,
    totpSecret: analystSetup.secret,
    totpState: analystTotpState,
  };
  return { secretFile, totpState, password, analystPassword: analyst };
}

/**
 * The second account's check: it signed in and opened at least one project before the move, and
 * after it signs in and opens the same number of projects.
 */
export const sameAccess = (before, after) =>
  before.status === 200 &&
  before.projects >= 1 &&
  after.status === 200 &&
  after.projects === before.projects;

async function analystSignsIn(base, { password, totpSecret, totpState }) {
  const session = await signIn({ base, username: ANALYST, password, totpSecret, totpState });
  const scopes = await session.call('/system/auth/scopes');
  const text = await scopes.text();
  return {
    status: scopes.status,
    projects: scopes.status === 200 ? JSON.parse(text).length : null,
  };
}

/**
 * Runs snapshot.mjs or compare.mjs and prints its output. Asynchronous on purpose: a blocked
 * event loop would leave this process's idle keep-alive sockets to a server that closed them.
 */
async function script(name, args) {
  checkInterrupted();
  const child = track(
    spawn(process.execPath, [join(here, name), ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
    }),
  );
  let output = '';
  child.stdout.on('data', (chunk) => (output += chunk));
  child.stderr.on('data', (chunk) => (output += chunk));
  const status = await child.ended;
  for (const line of output.trimEnd().split('\n')) say(`  | ${line}`);
  return status;
}

const LOGIN = (secrets, state) => [
  '--user',
  'admin',
  '--password-file',
  join(state, 'admin-password'),
  '--totp-secret-file',
  secrets.secretFile,
  '--totp-state',
  secrets.totpState,
];

async function main(args) {
  const commit = args[0];
  if (
    !commit ||
    commit.startsWith('--') ||
    (args.length !== 1 && !(args.length === 3 && args[1] === '--package'))
  )
    throw new Error(
      'Usage: node deploy/desktop/migration/rehearse.mjs <source-commit> [--package <dir>]',
    );
  if (process.platform !== 'linux')
    throw new Error('The rehearsal runs on Linux; Windows steps are in README.md');
  handleInterrupts();
  const resolved = spawnSync('git', ['-C', repo, 'rev-parse', '--verify', `${commit}^{commit}`], {
    encoding: 'utf8',
  });
  if (resolved.status !== 0) throw new Error(`Unknown commit: ${commit}`);
  const sha = resolved.stdout.trim();
  const runId = new Date()
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d+Z$/, 'Z');
  const work = join(repo, '.data', 'migration-rehearsal', `${runId}-${sha.slice(0, 8)}`);
  const oldDir = join(work, 'old');
  const home = join(work, 'home');
  const originalState = join(work, 'laptop', 'SIPGES');
  const movedState = join(work, 'managed', 'SIPGES');
  const appRoot = join(work, 'managed', 'SIPGES-app');
  await mkdir(home, { recursive: true, mode: 0o700 });
  await mkdir(dirname(movedState), { recursive: true, mode: 0o700 });
  say(`Rehearsal ${runId}: source ${sha} (${commit}); work folder ${relative(repo, work)}`);
  let launcher;
  let releaseDir = null;
  let old = null;
  try {
    step('1. Old version in a scratch worktree, without data/');
    old = oldDir;
    oldWorktree(sha, old);
    check(
      (await readdir(old)).includes('data') === false,
      'the scratch worktree has no data/ folder',
    );
    run('pnpm', ['install', '--frozen-lockfile', '--prefer-offline'], {
      cwd: old,
      env: cleanEnv(home),
    });
    run('pnpm', ['--filter', '@sipges/web', 'build'], { cwd: old, env: cleanEnv(home) });

    step('2. Old API on a scratch state folder, synthetic data through the public API');
    await oldStateFolder(originalState);
    const oldPort = await port();
    const oldBase = `http://127.0.0.1:${oldPort}`;
    const secret = async (name) => (await readFile(join(originalState, name), 'utf8')).trim();
    // The old launcher's environment (start.ps1), plus a port: its default 8000 is never used here.
    const oldApi = await startLogged(process.execPath, ['apps/api/src/main.ts'], {
      cwd: old,
      log: join(originalState, 'api.log'),
      ready: { base: oldBase, seconds: 180 },
      env: cleanEnv(home, {
        SIPGES_DATA_KEY: await secret('data-key'),
        SIPGES_ADMIN_PASSWORD: await secret('admin-password'),
        SIPGES_COOKIE_SECURE: '0',
        SIPGES_HOST: '127.0.0.1',
        SIPGES_PORT: String(oldPort),
        SIPGES_PGLITE_DIR: join(originalState, 'pglite'),
        SIPGES_UPLOAD_DIR: join(originalState, 'uploads'),
        SIPGES_WEB_DIR: join(old, 'apps', 'web', 'dist'),
      }),
    });
    say(`old API ready in ${oldApi.readyIn} s on port ${oldPort}`);
    const secrets = await seed(oldBase, originalState, work);
    const analystBefore = await analystSignsIn(oldBase, secrets.analystPassword);
    check(
      analystBefore.status === 200 && analystBefore.projects >= 1,
      `the second account signs in on the old version and opens ${analystBefore.projects} project(s) (scopes status ${analystBefore.status})`,
    );

    step('3. Snapshot of the old version, stop, copy the state folder');
    const before = join(work, 'before.json');
    check(
      (await script('snapshot.mjs', [
        '--url',
        oldBase,
        '--out',
        before,
        ...LOGIN(secrets, originalState),
      ])) === 0,
      'snapshot.mjs exit 0',
    );
    check((await stop(oldApi)) !== null, 'the old API stopped');
    const original = await tree(originalState);
    say(`original state folder: ${Object.keys(original).length} files, digest ${digest(original)}`);
    await cp(originalState, movedState, {
      recursive: true,
      preserveTimestamps: true,
      errorOnExist: true,
      force: false,
    });
    check(digest(await tree(movedState)) === digest(original), 'the copy equals the original');

    step('4. Definitive package, signed release, managed install pointing at the copy');
    let packageDir = args[2] ? resolve(args[2]) : null;
    if (!packageDir) {
      const version = `0.0.6-rehearsal.${runId.slice(0, 8)}${runId.slice(9, 15)}`;
      packageDir = join(repo, '.data', 'desktop-packages', `sipges-${version}`);
      run(
        process.execPath,
        [
          join(repo, 'deploy/desktop/package/builder.mjs'),
          '--version',
          version,
          '--out',
          packageDir,
        ],
        { cwd: repo },
      );
    }
    releaseDir = join(work, 'release');
    const { privateKey } = generateKeyPairSync('ed25519');
    await createRelease({
      packageDir,
      releaseDir,
      privateKey,
      notes: 'Ensayo sintético del traslado de datos.',
    });
    const newPort = await port();
    const newBase = `http://127.0.0.1:${newPort}`;
    const desktopEnv = cleanEnv(home, {
      SIPGES_DESKTOP_STATE: movedState,
      SIPGES_DESKTOP_ROOT: appRoot,
      SIPGES_DESKTOP_PORT: String(newPort),
    });
    run('sh', [join(repo, 'deploy/desktop/linux/install.sh'), '--managed', releaseDir], {
      env: desktopEnv,
    });
    const installed = JSON.parse(await readFile(join(appRoot, 'current.json'), 'utf8'));
    say(`installed ${installed.version}`);

    // A start that does not get ready is stopped and awaited inside startLogged, so the
    // launcher is never left running unreferenced.
    const startManaged = async () => {
      const child = await startLogged(
        process.execPath,
        [join(appRoot, 'run-current.mjs'), '--port', String(newPort)],
        {
          cwd: appRoot,
          env: cleanEnv(home),
          log: join(appRoot, 'launcher.log'),
          ready: { base: newBase, seconds: 600 },
        },
      );
      say(`managed version ready in ${child.readyIn} s on port ${newPort}`);
      return child;
    };
    const launcherEvents = async () =>
      (await readFile(join(appRoot, 'launcher.log'), 'utf8'))
        .split('\n')
        .filter((line) => line.startsWith('{'))
        .map((line) => JSON.parse(line));
    const compare = async (label) => {
      const status = await script('compare.mjs', [
        '--before',
        before,
        '--url',
        newBase,
        ...LOGIN(secrets, movedState),
      ]);
      check(status === 0, `compare.mjs: no difference (${label})`);
    };

    step('5. First start of the managed version on the copy, then the comparison');
    launcher = await startManaged();
    const first = (await launcherEvents()).filter((e) => e.event === 'first_start');
    check(
      first.length === 1 && first[0].preUpdateCopy?.includes('.pre-update-'),
      'the first start took its own dated pre-update copy',
    );
    check(
      digest(await tree(first[0].preUpdateCopy)) === digest(original),
      'the pre-update copy equals the old state folder',
    );
    const around = await siblingsOf(movedState);
    say(`beside the moved folder: ${around.join(', ')}`);
    await compare('first start');
    const analyst = await analystSignsIn(newBase, secrets.analystPassword);
    check(
      sameAccess(analystBefore, analyst),
      `the second account signs in with its old password and opens the same ${analyst.projects} project(s) (scopes status ${analyst.status})`,
    );
    check(
      digest(await tree(originalState)) === digest(original),
      'the original state folder is byte-identical',
    );

    step('6. Rule d: installer and start again on the moved folder');
    check((await stop(launcher)) === 0, 'the managed version stopped with code 0');
    run('sh', [join(repo, 'deploy/desktop/linux/install.sh'), '--managed', releaseDir], {
      env: desktopEnv,
    });
    launcher = await startManaged();
    check(
      (await launcherEvents()).filter((e) => e.event === 'first_start').length === 1,
      'no second first start',
    );
    check(
      JSON.stringify(await siblingsOf(movedState)) === JSON.stringify(around),
      'nothing new beside the moved folder',
    );
    await compare('second run');

    step('7. T11 drill: the numbered procedure of deploy/desktop/README.md, Back up and restore');
    // Step 1: `pkill -f run-current.mjs` sends this SIGTERM; here only to this rehearsal's pid,
    // so no other SIPGES on this computer is touched.
    check((await stop(launcher)) === 0, 'step 1: SIPGES stopped (code 0)');
    const answers = await fetch(`${newBase}/health`).then(
      () => true,
      () => false,
    );
    check(!answers, 'step 1: /health no longer answers');
    const backup = join(work, 'external-drive', `SIPGES-${runId.slice(0, 8)}`);
    await mkdir(dirname(backup), { recursive: true, mode: 0o700 });
    run('cp', ['-a', movedState, backup]);
    say('step 2: cp -a <state folder> <external disk>/SIPGES-<date>');
    const [live, copied] = [counted(movedState), counted(backup)];
    const walked = await sizeOf(movedState);
    check(
      live === copied && live === `${walked.files} ${walked.bytes}`,
      `step 3: the copy has the same files and bytes (${live})`,
    );
    launcher = await startManaged();
    say('step 4: SIPGES opened again');
    check((await stop(launcher)) === 0, 'step 5: SIPGES stopped (code 0)');
    const backedUp = await tree(backup);
    await rm(movedState, { recursive: true });
    check(
      !(await readdir(dirname(movedState))).includes('SIPGES'),
      'step 6: the state folder is gone (standing for a lost disk)',
    );
    run('cp', ['-a', backup, movedState]);
    check(
      digest(await tree(movedState)) === digest(backedUp),
      'step 7: copied back with cp -a; the restored folder equals the backup',
    );
    launcher = await startManaged();
    await compare('step 8, after the restore');
    check(
      sameAccess(analystBefore, await analystSignsIn(newBase, secrets.analystPassword)),
      'the second account signs in after the restore and opens the same projects',
    );
    check((await stop(launcher)) === 0, 'the managed version stopped with code 0');
    check(
      digest(await tree(originalState)) === digest(original),
      'the original state folder is still byte-identical',
    );
    say('\nREHEARSAL PASSED');
  } finally {
    // Every process this run started, whether or not a variable still names it.
    await stopAll();
    if (releaseDir) await rm(releaseDir, { recursive: true, force: true });
    if (old) {
      const removed = spawnSync('git', ['-C', repo, 'worktree', 'remove', '--force', old], {
        encoding: 'utf8',
      });
      say(
        removed.status === 0
          ? `removed the scratch worktree ${relative(repo, old)}`
          : `could not remove the scratch worktree: ${removed.stderr.trim()}`,
      );
    }
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(
      `REHEARSAL FAILED: ${error.message}${error.cause ? ` (${error.cause.message})` : ''}`,
    );
    process.exitCode = interrupted ? 130 : 1;
  });
}
