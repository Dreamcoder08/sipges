// The snapshot and comparison scripts of the data move (closure-roadmap T33), against a small
// fake of the SIPGES HTTP API filled with synthetic, recognisable values. They must print and
// store only counts and hashes, and report every difference, an MFA sign-in that no longer works
// (the old data key) and a record visible from another project.
/* global structuredClone */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import process from 'node:process';
import { Buffer } from 'node:buffer';
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { PassThrough } from 'node:stream';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { URL, URLSearchParams, fileURLToPath } from 'node:url';
import { clearTimeout, setTimeout } from 'node:timers';

const here = dirname(fileURLToPath(import.meta.url));
const snapshotCli = join(here, 'snapshot.mjs');
const compareCli = join(here, 'compare.mjs');

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const base32 = (text) => {
  let bits = '';
  for (const char of text) bits += BASE32.indexOf(char).toString(2).padStart(5, '0');
  return Buffer.from(bits.match(/.{8}/g).map((byte) => parseInt(byte, 2)));
};
const code = (secret, step) => {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const mac = createHmac('sha1', base32(secret)).update(counter).digest();
  const at = mac[19] & 15;
  return String((mac.readUInt32BE(at) & 0x7fffffff) % 1_000_000).padStart(6, '0');
};

const SECRET = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';
// In a body that is not valid JSON: a JSON parse error quotes the text around the bad byte.
const NOT_JSON_MARK = 'SINTNOJSON';
const PASSWORD = 'clave-sintetica-admin-001';
const DESKTOP_VERSION = '1.0.0-sintetico.1';

/** Synthetic content; every string here must stay out of the scripts' output and files. */
const fixture = () => ({
  accounts: [
    { username: 'admin', full_name: 'Persona Sintetica Uno', role: 'admin', active: 1 },
    {
      username: 'analista-sintetica',
      full_name: 'Persona Sintetica Dos',
      role: 'consulta',
      active: 1,
    },
  ],
  scopes: {
    'EMPRESA-SINTETICA/PRJ-ALFA-SINTETICO': {
      label: 'Proyecto Alfa Sintetico',
      records: {
        eventos: [
          { _id: 'EV-ALFA-0001', Titulo: 'VALOR-SECRETO-EVENTO-ALFA', Fecha: '2026-01-02' },
          { _id: 'EV-ALFA-0002', Titulo: 'VALOR-SECRETO-EVENTO-DOS', Lugar: 'LUGAR-SECRETO' },
          { _id: 'EV-COMUN-0001', Titulo: 'COMUN-SECRETO-ALFA' },
        ],
        actores: [{ _id: 'A-ALFA-0001', Nombre: 'ACTOR-SECRETO-ALFA', CampoRaro: 'X-SECRETO' }],
      },
      links: [{ id: 41, from: ['actores', 'A-ALFA-0001'], to: ['eventos', 'EV-ALFA-0001'] }],
      uploads: [
        { id: 'up-alfa-1', name: 'informe-secreto-alfa.txt', bytes: 'CONTENIDO-SECRETO-ALFA\n' },
      ],
      reviews: [{ id: 7, note: 'NOTA-REVISION-SECRETA', status: 'aprobado' }],
    },
    'EMPRESA-SINTETICA/PRJ-BETA-SINTETICO': {
      label: 'Proyecto Beta Sintetico',
      records: {
        demandas: [{ _id: 'D-BETA-0001', Texto: 'VALOR-SECRETO-DEMANDA-BETA' }],
        // The same id in both projects, each with its own content: not a leak.
        eventos: [{ _id: 'EV-COMUN-0001', Titulo: 'COMUN-SECRETO-BETA' }],
      },
      links: [],
      uploads: [
        { id: 'up-beta-1', name: 'acta-secreta-beta.txt', bytes: 'CONTENIDO-SECRETO-BETA\n' },
      ],
    },
  },
});
const SECRETS = (data) => [
  ...data.accounts.flatMap((a) =>
    a.username === 'admin' ? [a.full_name] : [a.username, a.full_name],
  ),
  ...Object.entries(data.scopes).flatMap(([scope, s]) => [
    scope,
    ...scope.split('/'),
    s.label,
    ...Object.values(s.records).flatMap((rows) =>
      rows.flatMap((row) => Object.entries(row).flatMap(([k, v]) => (k === '_id' ? [v] : [k, v]))),
    ),
    ...s.uploads.flatMap((u) => [u.id, u.name, u.bytes.trim()]),
    ...(s.reviews ?? []).map((r) => r.note),
  ]),
  PASSWORD,
  SECRET,
];

/**
 * Audit entries: 3 per project, then `extra` ones written later; ids are shared across projects
 * like a real trail.
 */
const auditOf = (data, extra = {}) => {
  let id = 0;
  const trail = {};
  for (const scope of Object.keys(data.scopes)) {
    trail[scope] = [];
    for (const action of ['create', 'create', 'update'])
      trail[scope].push({
        id: (id += 1),
        module: 'Eventos',
        action,
        detail: `DETALLE-SECRETO-${id}`,
      });
  }
  for (const scope of Object.keys(data.scopes))
    for (const action of extra[scope] ?? [])
      trail[scope].push({ id: (id += 1), module: 'auth', action, detail: 'DETALLE-SECRETO-LOGIN' });
  return trail;
};

/** A fake of the routes the scripts read, with switches for the failures they must catch. */
async function fakeApi(
  data,
  {
    audit = auditOf(data),
    mfaBroken = false,
    leak = false,
    leakShared = false,
    noExport = false,
    noAccounts = false,
    // Rows a list answers at most, whatever limit is asked (an older or stricter version).
    listCap = Infinity,
    // A version that ignores ?offset= and answers the first page again.
    ignoreOffset = false,
    // GET /system/desktop/update, which only a managed install started by the desktop launcher
    // mounts: its status, null for a server without the route (the old version, answers 404),
    // 'html' for an answer that is not JSON, 'text' for a JSON body sent as text/plain,
    // 'redirect' for a redirect to a route that answers a valid status, 'forbidden' for 403.
    desktop = { installed: DESKTOP_VERSION },
    // `{ prefix, status }`: every path starting with `prefix` answers a redirect to the same
    // request under /elsewhere, which answers exactly what the path itself would (a front server
    // that hands data reads to another server).
    redirect = null,
    // Paths starting with this prefix close the connection without an answer.
    drop = null,
    // Paths starting with this prefix answer 200 with a body that is not valid JSON: the
    // synthetic marker, then a stray byte.
    notJson = null,
  } = {},
) {
  const sessions = new Set();
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://fake');
    const json = (status, body) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (redirect && url.pathname.startsWith(redirect.prefix)) {
      res.writeHead(redirect.status ?? 302, { location: `/elsewhere${req.url}` });
      return res.end();
    }
    if (url.pathname.startsWith('/elsewhere/')) url.pathname = url.pathname.slice(10);
    if (drop && url.pathname.startsWith(drop)) return req.socket.destroy();
    if (req.method === 'POST' && url.pathname === '/login') {
      let body = '';
      for await (const chunk of req) body += chunk;
      const form = new URLSearchParams(body);
      const step = Math.floor(Date.now() / 30000);
      const otpOk =
        !mfaBroken && [step - 1, step, step + 1].some((s) => code(SECRET, s) === form.get('otp'));
      if (form.get('username') !== 'admin' || form.get('password') !== PASSWORD || !otpOk)
        return json(401, { detail: 'Credenciales inválidas' });
      const token = randomBytes(8).toString('hex');
      sessions.add(token);
      res.setHeader('set-cookie', `sipges_session=${token}; HttpOnly; Path=/`);
      return json(200, { ok: true });
    }
    const token = /sipges_session=([0-9a-f]+)/.exec(req.headers.cookie ?? '')?.[1];
    if (!sessions.has(token)) return json(401, { detail: 'Unauthorized' });
    if (url.pathname === '/system/auth/scopes')
      return json(
        200,
        Object.entries(data.scopes).map(([scope, s]) => ({
          company_id: scope.split('/')[0],
          project_id: scope.split('/')[1],
          label: s.label,
        })),
      );
    const scopeName = req.headers['x-sipges-scope'];
    const scope = data.scopes[scopeName];
    if (!scope) return json(403, { detail: 'Seleccione un proyecto' });
    if (notJson && url.pathname.startsWith(notJson)) {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(`{"Titulo": ${NOT_JSON_MARK}\u0001}`);
    }
    // Like the real route: behind the session and the project scope (not scope-free).
    const valid = { installed: DESKTOP_VERSION, available: null, notes: null, dismissed: false };
    if (url.pathname === '/system/desktop/update-elsewhere') return json(200, valid);
    if (url.pathname === '/system/desktop/update' && desktop === 'redirect') {
      res.writeHead(302, { location: '/system/desktop/update-elsewhere' });
      return res.end();
    }
    if (url.pathname === '/system/desktop/update' && desktop === 'forbidden')
      return json(403, { detail: 'Requiere rol administrador' });
    if (url.pathname === '/system/desktop/update' && desktop === 'text') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      return res.end(JSON.stringify(valid));
    }
    if (url.pathname === '/system/desktop/update' && desktop === 'html') {
      res.writeHead(200, { 'content-type': 'text/html; charset=UTF-8' });
      return res.end('<!doctype html><html><head></head><body></body></html>');
    }
    if (url.pathname === '/system/desktop/update' && desktop)
      return json(200, {
        installed: desktop.installed,
        available: null,
        notes: null,
        dismissed: false,
      });
    if (url.pathname === '/system/auth/accounts' && noAccounts)
      return json(403, { detail: 'Requiere rol administrador' });
    if (url.pathname === '/system/auth/accounts')
      return json(
        200,
        data.accounts.map((a) => ({ ...a, created_at: '2026-01-01T00:00:00Z' })),
      );
    const record = /^\/api\/([a-z]+)(?:\/([^/]+))?$/.exec(url.pathname);
    if (record) {
      const [, slug, id] = record;
      if (!['eventos', 'actores', 'demandas', 'compromisos'].includes(slug))
        return json(404, { detail: 'Módulo no válido' });
      if (id) {
        const own = (scope.records[slug] ?? []).find((r) => r._id === decodeURIComponent(id));
        const leaked = leak
          ? Object.values(data.scopes)
              .flatMap((s) => s.records[slug] ?? [])
              .find((r) => r._id === decodeURIComponent(id))
          : undefined;
        const foreign = leakShared
          ? Object.entries(data.scopes)
              .filter(([name]) => name !== scopeName)
              .flatMap(([, s]) => s.records[slug] ?? [])
              .find((r) => r._id === decodeURIComponent(id))
          : undefined;
        const answer = (own && foreign) ?? own ?? leaked;
        return answer ? json(200, answer) : json(404, { detail: 'Registro no encontrado' });
      }
      const rows = (scope.records[slug] ?? []).map((r) => ({
        ...r,
        _updated_at: '2026-01-03T00:00:00Z',
      }));
      const offset = ignoreOffset ? 0 : Number(url.searchParams.get('offset') ?? 0);
      const limit = Math.min(Number(url.searchParams.get('limit') ?? 200), listCap);
      return json(200, rows.slice(offset, offset + limit));
    }
    if (url.pathname === '/system/links') {
      const ref = [url.searchParams.get('module'), url.searchParams.get('id')];
      const exists = (scope.records[ref[0]] ?? []).some((r) => r._id === ref[1]);
      if (!exists) return json(404, { detail: 'Registro no encontrado' });
      const touching = scope.links.filter(
        (l) =>
          (l.from[0] === ref[0] && l.from[1] === ref[1]) ||
          (l.to[0] === ref[0] && l.to[1] === ref[1]),
      );
      return json(200, {
        record: { module: ref[0], id: ref[1] },
        links: touching.map((l) => ({
          edge: {
            id: l.id,
            link_type: 'participa_en',
            source: l.from,
            target: l.to,
            note: 'NOTA-SECRETA',
          },
          direction: 'out',
          label: 'participa en',
          other: { module: l.to[0], id: l.to[1], title: 'TITULO-SECRETO' },
        })),
      });
    }
    // Like the real API: the list holds at most 500 (newest first there), one upload by its id.
    const uploadJson = (u) => ({
      id: u.id,
      original_name: u.name,
      sha256: 'x',
      size_bytes: u.bytes.length,
    });
    if (url.pathname === '/system/uploads') {
      const limit = Math.min(Number(url.searchParams.get('limit') ?? 200), 500);
      return json(200, scope.uploads.slice(0, 500).slice(0, limit).map(uploadJson));
    }
    const single = /^\/system\/uploads\/([^/]+)$/.exec(url.pathname);
    if (single) {
      const found = scope.uploads.find((u) => u.id === decodeURIComponent(single[1]));
      return found ? json(200, uploadJson(found)) : json(404, { detail: 'No encontrado' });
    }
    const download = /^\/system\/uploads\/([^/]+)\/download$/.exec(url.pathname);
    if (download) {
      const found = (
        leak ? Object.values(data.scopes).flatMap((s) => s.uploads) : scope.uploads
      ).find((u) => u.id === decodeURIComponent(download[1]));
      if (!found) return json(404, { detail: 'No encontrado' });
      res.writeHead(200, { 'content-type': 'text/plain' });
      return res.end(found.bytes);
    }
    if (url.pathname === '/system/export' && noExport)
      return json(403, { detail: 'Requiere rol administrador' });
    if (url.pathname === '/system/export')
      return json(200, {
        format: 'sipges.tenant-export',
        version: 1,
        exported_at: new Date().toISOString(),
        data: {
          // As stored: module, id and payload of every record, in every module.
          module_records: Object.entries(scope.records).flatMap(([slug, rows]) =>
            rows.map(({ _id, ...payload }) => ({
              tenant_id: scopeName,
              module: slug,
              id: _id,
              payload,
            })),
          ),
          audit: audit[scopeName] ?? [],
          // The stored row: a file changed on disk leaves it as it was.
          attachments: scope.uploads.map((u) => ({ id: u.id, original_name: u.name })),
          document_review: scope.reviews ?? [],
          preventive_actions: [],
        },
      });
    if (url.pathname === '/system/audit') {
      const limit = Math.min(Number(url.searchParams.get('limit') ?? 100), 500);
      const entries = [...(audit[scopeName] ?? [])].reverse().slice(0, limit);
      return json(
        200,
        entries.map((e) => ({ ...e, ts: '2026-01-04T00:00:00Z', record_id: 'EV-ALFA-0001' })),
      );
    }
    if (url.pathname === '/system/events') {
      const after = Number(req.headers['last-event-id'] ?? 0);
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(`event: ready\nid: ${after}\ndata: {}\n\n`);
      for (const e of (audit[scopeName] ?? []).filter((x) => x.id > after))
        res.write(
          `event: activity\nid: ${e.id}\ndata: ${JSON.stringify({ module: e.module, action: e.action })}\n\n`,
        );
      return; // left open, like the real stream
    }
    return json(404, { detail: 'Not Found' });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    close: () => {
      server.closeAllConnections();
      server.close();
    },
  };
}

/** Runs a script; one still running after `timeoutMs` is killed and reported with status null. */
function run(script, args, { timeoutMs = 60_000 } = {}) {
  const child = spawn(process.execPath, [script, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (d) => (stdout += d));
  child.stderr.on('data', (d) => (stderr += d));
  const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
  return once(child, 'exit').then(([status]) => {
    clearTimeout(timer);
    return { status, stdout, stderr };
  });
}

async function withTemp(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'sipges-migration-'));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function credentials(dir) {
  await writeFile(join(dir, 'password'), `${PASSWORD}\n`, { mode: 0o600 });
  await writeFile(join(dir, 'totp'), `${SECRET}\n`, { mode: 0o600 });
  return [
    '--user',
    'admin',
    '--password-file',
    join(dir, 'password'),
    '--totp-secret-file',
    join(dir, 'totp'),
  ];
}

const absent = (text, data, label) => {
  for (const secret of SECRETS(data))
    assert.ok(!text.includes(secret), `${label} contains the synthetic value ${secret}`);
};

/** Takes the snapshot of `before` and compares it with `after` (same data unless changed). */
async function snapshotThenCompare(parent, before, after = before, beforeOptions, afterOptions) {
  // A fresh folder per run: snapshot.mjs never overwrites an existing snapshot.
  const dir = await mkdtemp(join(parent, 'run-'));
  const login = await credentials(dir);
  const out = join(dir, 'before.json');
  const first = await fakeApi(before, beforeOptions);
  let taken;
  try {
    taken = await run(snapshotCli, ['--url', first.url, ...login, '--out', out], {
      timeoutMs: 20_000,
    });
  } finally {
    first.close();
  }
  assert.equal(taken.status, 0, `snapshot: ${taken.status} ${taken.stderr}`);
  const second = await fakeApi(after, afterOptions);
  try {
    const compared = await run(compareCli, ['--before', out, '--url', second.url, ...login]);
    return { taken, compared, file: await readFile(out, 'utf8') };
  } finally {
    second.close();
  }
}

test('snapshot and compare print and store only counts and hashes, never a field value', () =>
  withTemp(async (dir) => {
    const data = fixture();
    const { taken, compared, file } = await snapshotThenCompare(dir, data);
    for (const [label, text] of [
      ['snapshot output', taken.stdout + taken.stderr],
      ['snapshot file', file],
      ['compare output', compared.stdout + compared.stderr],
    ])
      absent(text, data, label);
    assert.match(taken.stdout, /^Projects: 2$/m);
    assert.match(
      taken.stdout,
      /^project 1 \[[0-9a-f]{8}\]: records 4 \(actores 1, eventos 3\), links 1, uploads 1, audit 3$/m,
    );
    assert.match(taken.stdout, /^Accounts: 2$/m);
    assert.equal(compared.status, 0, compared.stdout + compared.stderr);
    assert.match(compared.stdout, /^Sign-in: ok \(password and MFA code\)$/m);
    assert.match(
      compared.stdout,
      /^Isolation: \d+ probes, no record or upload of one project visible in another$/m,
    );
    assert.match(compared.stdout, /^RESULT: no difference$/m);
    // Counts per project and module, and upload content hashes, are what is printed.
    assert.match(compared.stdout, /^ {2}eventos: 3 -> 3, every field identical$/m);
    // Keyed like every other value: a known file's SHA-256 never shows.
    assert.match(compared.stdout, /^ {2}uploads: 1 -> 1, content [0-9a-f]{12}… identical$/m);
    // Other tables of the project export: row hashes; the audit is compared entry by entry.
    assert.match(compared.stdout, /^ {2}export document_review: 1 -> 1, identical$/m);
    assert.doesNotMatch(compared.stdout, /export (audit|module_records|preventive_actions)/);
  }));

test('compare reports a changed row of another exported table', () =>
  withTemp(async (dir) => {
    const before = fixture();
    const after = fixture();
    after.scopes['EMPRESA-SINTETICA/PRJ-ALFA-SINTETICO'].reviews[0].status = 'rechazado';
    const { compared } = await snapshotThenCompare(dir, before, after);
    assert.equal(compared.status, 1);
    assert.match(
      compared.stdout,
      /^ {2}export document_review: 1 -> 1, 1 row missing or changed, 1 row new or changed$/m,
    );
    assert.ok(!compared.stdout.includes('rechazado'));
    assert.match(compared.stdout, /^RESULT: 1 difference$/m);
  }));

test('compare reports a changed field by module and hashes only, and fails', () =>
  withTemp(async (dir) => {
    const before = fixture();
    const after = fixture();
    after.scopes['EMPRESA-SINTETICA/PRJ-ALFA-SINTETICO'].records.eventos[1].Lugar =
      'OTRO-VALOR-SECRETO';
    after.scopes['EMPRESA-SINTETICA/PRJ-BETA-SINTETICO'].uploads[0].bytes = 'CONTENIDO-CAMBIADO\n';
    const { compared } = await snapshotThenCompare(dir, before, after);
    assert.equal(compared.status, 1);
    absent(compared.stdout + compared.stderr, after, 'compare output');
    assert.ok(!compared.stdout.includes('OTRO-VALOR-SECRETO'));
    assert.match(
      compared.stdout,
      /^ {2}eventos: 3 -> 3, record \[[0-9a-f]{8}\] field \[[0-9a-f]{8}\] differs$/m,
    );
    assert.match(compared.stdout, /^ {2}uploads: 1 -> 1, upload \[[0-9a-f]{8}\] content differs$/m);
    assert.match(compared.stdout, /^RESULT: 2 differences$/m);
  }));

test('rule b: an MFA sign-in that no longer works after the move fails the comparison', () =>
  withTemp(async (dir) => {
    const data = fixture();
    const { compared } = await snapshotThenCompare(dir, data, data, {}, { mfaBroken: true });
    assert.equal(compared.status, 1);
    assert.match(compared.stdout + compared.stderr, /Sign-in failed \(status 401\)/);
    assert.doesNotMatch(compared.stdout, /RESULT: no difference/);
  }));

test('rule c: a record or upload of one project visible in another fails the comparison', () =>
  withTemp(async (dir) => {
    const data = fixture();
    const { compared } = await snapshotThenCompare(dir, data, data, {}, { leak: true });
    assert.equal(compared.status, 1);
    absent(compared.stdout + compared.stderr, data, 'compare output');
    assert.match(
      compared.stdout,
      /^Isolation: \d+ probes, 6 visible in another project \(records 4, uploads 2\)$/m,
    );
    assert.match(compared.stdout, /^RESULT: 1 difference$/m);
  }));

test("rule c: an id both projects have, answered with the other project's content, is a leak", () =>
  withTemp(async (dir) => {
    const data = fixture();
    const { compared } = await snapshotThenCompare(dir, data, data, {}, { leakShared: true });
    assert.equal(compared.status, 1);
    absent(compared.stdout + compared.stderr, data, 'compare output');
    assert.match(
      compared.stdout,
      /^Isolation: \d+ probes, 2 visible in another project \(records 2, uploads 0\)$/m,
    );
  }));

test('audit entries added after the snapshot are listed explicitly; a missing one fails', () =>
  withTemp(async (dir) => {
    const data = fixture();
    const alfa = 'EMPRESA-SINTETICA/PRJ-ALFA-SINTETICO';
    const added = auditOf(data, { [alfa]: ['login', 'migrate'] });
    const kept = await snapshotThenCompare(dir, data, data, {}, { audit: added });
    assert.equal(kept.compared.status, 0, kept.compared.stdout);
    assert.match(
      kept.compared.stdout,
      /^ {2}audit: 3 -> 5, 3 kept unchanged, added: #7 auth\/login, #8 auth\/migrate$/m,
    );
    assert.match(
      kept.compared.stdout,
      /^RESULT: no difference \(2 audit entries added, listed above\)$/m,
    );
    absent(kept.compared.stdout, data, 'compare output');

    const lost = auditOf(data);
    lost[alfa].splice(1, 1);
    const missing = await snapshotThenCompare(dir, data, data, {}, { audit: lost });
    assert.equal(missing.compared.status, 1);
    assert.match(missing.compared.stdout, /^ {2}audit: 3 -> 2, 2 kept unchanged, 1 missing$/m);
  }));

test('the audit trail is read in full past the 500 entries one page shows', () =>
  withTemp(async (dir) => {
    const data = fixture();
    const alfa = 'EMPRESA-SINTETICA/PRJ-ALFA-SINTETICO';
    const long = auditOf(data, { [alfa]: Array.from({ length: 600 }, () => 'login') });
    const { taken, compared } = await snapshotThenCompare(
      dir,
      data,
      data,
      { audit: long },
      { audit: long },
    );
    assert.match(taken.stdout, /^project 1 \[[0-9a-f]{8}\]: .*audit 603$/m);
    assert.equal(compared.status, 0, compared.stdout);
    assert.match(compared.stdout, /^ {2}audit: 603 -> 603, 603 kept unchanged$/m);
  }));

test('T33: a changed JSON field type is a difference', () =>
  withTemp(async (dir) => {
    const scope = 'EMPRESA-SINTETICA/PRJ-ALFA-SINTETICO';
    const before = fixture();
    const after = fixture();
    before.scopes[scope].records.eventos[0].Participantes = '12';
    after.scopes[scope].records.eventos[0].Participantes = 12;
    const { compared } = await snapshotThenCompare(dir, before, after);
    assert.equal(compared.status, 1, compared.stdout);
    assert.doesNotMatch(compared.stdout, /RESULT: no difference/);
    assert.match(
      compared.stdout,
      /^ {2}eventos: 3 -> 3, record \[[0-9a-f]{8}\] field \[[0-9a-f]{8}\] differs$/m,
    );
    // Hashes are hex and hold "12" by chance (the value 12 itself): look outside them only.
    const unhashed = (compared.stdout + compared.stderr)
      .replace(/\[[0-9a-f]{8}\]/g, '[hash]')
      .replace(/[0-9a-f]{12}…/g, 'hash…');
    assert.doesNotMatch(unhashed, /[0-9a-f]{8}/, 'every hash was masked');
    absent(unhashed, after, 'compare output');
  }));

test('T33: unchecked upload 501 cannot produce a successful comparison', () =>
  withTemp(async (dir) => {
    const scope = 'EMPRESA-SINTETICA/PRJ-ALFA-SINTETICO';
    const before = fixture();
    before.scopes[scope].uploads = Array.from({ length: 501 }, (_, i) => ({
      id: `upload-${i}`,
      name: `synthetic-${i}.txt`,
      bytes: `synthetic-file-${i}`,
    }));
    const after = structuredClone(before);
    after.scopes[scope].uploads[500].bytes = 'CORRUPTED-CONTENT';
    const { taken, compared } = await snapshotThenCompare(dir, before, after);
    assert.equal(compared.status, 1, compared.stdout);
    assert.doesNotMatch(compared.stdout, /RESULT: no difference/);
    assert.match(taken.stdout, /^project 1 \[[0-9a-f]{8}\]: .*uploads 501, audit 3$/m);
    assert.match(
      compared.stdout,
      /^ {2}uploads: 501 -> 501, upload \[[0-9a-f]{8}\] content differs$/m,
    );
    absent(compared.stdout + compared.stderr, after, 'compare output');
  }));

test('T33: more uploads than the list shows, without the export, is not fully checked', () =>
  withTemp(async (dir) => {
    const scope = 'EMPRESA-SINTETICA/PRJ-ALFA-SINTETICO';
    const data = fixture();
    data.scopes[scope].uploads = Array.from({ length: 501 }, (_, i) => ({
      id: `upload-${i}`,
      name: `synthetic-${i}.txt`,
      bytes: `synthetic-file-${i}`,
    }));
    const { taken, compared } = await snapshotThenCompare(
      dir,
      data,
      data,
      { noExport: true },
      { noExport: true },
    );
    assert.match(taken.stdout, /uploads 500 \(not fully checked\)/);
    assert.equal(compared.status, 1, compared.stdout);
    assert.match(compared.stdout, /^ {2}uploads: not fully checked/m);
    assert.match(compared.stdout, /^RESULT: not fully checked/m);
  }));

test('T33: a historical audit detail change is a difference', () =>
  withTemp(async (dir) => {
    const scope = 'EMPRESA-SINTETICA/PRJ-ALFA-SINTETICO';
    const data = fixture();
    const before = auditOf(data, { [scope]: Array.from({ length: 600 }, () => 'login') });
    const after = structuredClone(before);
    after[scope][0].detail = 'CHANGED-HISTORICAL-DETAIL';
    const { compared } = await snapshotThenCompare(
      dir,
      data,
      data,
      { audit: before },
      { audit: after },
    );
    assert.equal(compared.status, 1, compared.stdout);
    assert.doesNotMatch(compared.stdout, /RESULT: no difference/);
    assert.match(compared.stdout, /^ {2}audit: 603 -> 603, 602 kept unchanged, 1 changed$/m);
    assert.ok(!compared.stdout.includes('CHANGED-HISTORICAL-DETAIL'));
  }));

test('T33: a long audit trail without the export is not fully checked', () =>
  withTemp(async (dir) => {
    const scope = 'EMPRESA-SINTETICA/PRJ-ALFA-SINTETICO';
    const data = fixture();
    const audit = auditOf(data, { [scope]: Array.from({ length: 600 }, () => 'login') });
    const { compared } = await snapshotThenCompare(
      dir,
      data,
      data,
      { audit, noExport: true },
      { audit, noExport: true },
    );
    assert.equal(compared.status, 1, compared.stdout);
    assert.match(compared.stdout, /^ {2}audit: not fully checked/m);
    assert.match(compared.stdout, /^RESULT: not fully checked/m);
  }));

const ALFA = 'EMPRESA-SINTETICA/PRJ-ALFA-SINTETICO';
const manyEvents = (n) =>
  Array.from({ length: n }, (_, i) => ({
    _id: `EV-MUCHOS-${String(i).padStart(4, '0')}`,
    Titulo: `TITULO-SINTETICO-${i}`,
  }));

test('T33 follow-up: a list that answers fewer rows than asked is read to the end', () =>
  withTemp(async (dir) => {
    const before = fixture();
    before.scopes[ALFA].records.eventos = manyEvents(450);
    const after = structuredClone(before);
    after.scopes[ALFA].records.eventos[300].Titulo = 'TITULO-CAMBIADO';
    const capped = { listCap: 200 };
    const { taken, compared } = await snapshotThenCompare(dir, before, after, capped, capped);
    assert.match(
      taken.stdout,
      /^project 1 \[[0-9a-f]{8}\]: records 451 \(actores 1, eventos 450\),/m,
    );
    assert.equal(compared.status, 1, compared.stdout);
    assert.match(
      compared.stdout,
      /^ {2}eventos: 450 -> 450, record \[[0-9a-f]{8}\] field \[[0-9a-f]{8}\] differs$/m,
    );
    assert.match(compared.stdout, /^RESULT: 1 difference$/m);
  }));

test('T33 follow-up: a list that ignores the offset is not fully checked', () =>
  withTemp(async (dir) => {
    const data = fixture();
    data.scopes[ALFA].records.eventos = manyEvents(600);
    const stuck = { ignoreOffset: true };
    const { taken, compared } = await snapshotThenCompare(dir, data, data, stuck, stuck);
    assert.match(
      taken.stdout,
      /^project 1 \[[0-9a-f]{8}\]: records \d+ \([^)]*\) \(not fully checked\),/m,
    );
    assert.equal(compared.status, 1, compared.stdout);
    assert.match(compared.stdout, /^ {2}records: not fully checked \(/m);
    assert.match(compared.stdout, /^RESULT: not fully checked \(1 part, listed above\)$/m);
    absent(compared.stdout + compared.stderr, data, 'compare output');
  }));

test('T33 follow-up: records the export holds but no list shows are not fully checked', () =>
  withTemp(async (dir) => {
    const data = fixture();
    // A module the lists of this version do not answer (404), present in the export.
    data.scopes[ALFA].records.narrativas = [{ _id: 'N-ALFA-0001', Texto: 'NARRATIVA-SECRETA' }];
    const { taken, compared } = await snapshotThenCompare(dir, data);
    assert.match(taken.stdout, /records 4 \(actores 1, eventos 3\) \(not fully checked\)/);
    assert.equal(compared.status, 1, compared.stdout);
    assert.match(
      compared.stdout,
      /^ {2}records: not fully checked \(1 record in the project export not read through the lists\)$/m,
    );
    assert.match(compared.stdout, /^RESULT: not fully checked/m);
    absent(compared.stdout + compared.stderr, data, 'compare output');
  }));

test('T33 follow-up: an export readable on neither side is printed and fails the comparison', () =>
  withTemp(async (dir) => {
    const data = fixture();
    const none = { noExport: true };
    const { compared } = await snapshotThenCompare(dir, data, data, none, none);
    assert.equal(compared.status, 1, compared.stdout);
    assert.match(
      compared.stdout,
      /^ {2}export: not checked \(the project export is not readable on either side\)$/m,
    );
    assert.match(compared.stdout, /^RESULT: not fully checked \(2 parts, listed above\)$/m);
    assert.doesNotMatch(compared.stdout, /RESULT: no difference/);
  }));

test('T33 follow-up: accounts readable on neither side are printed and fail the comparison', () =>
  withTemp(async (dir) => {
    const data = fixture();
    const none = { noAccounts: true };
    const { taken, compared } = await snapshotThenCompare(dir, data, data, none, none);
    assert.match(taken.stdout, /^Accounts: not readable$/m);
    assert.equal(compared.status, 1, compared.stdout);
    assert.match(compared.stdout, /^Accounts: not checked \(not readable on either side\)$/m);
    assert.match(compared.stdout, /^RESULT: not fully checked \(1 part, listed above\)$/m);
  }));

test('T33 follow-up: the snapshot never holds the plain SHA-256 of an upload; changed bytes still differ', () =>
  withTemp(async (dir) => {
    const before = fixture();
    const after = structuredClone(before);
    after.scopes[ALFA].uploads[0].bytes = 'CONTENIDO-CAMBIADO\n';
    const { taken, compared, file } = await snapshotThenCompare(dir, before, after);
    for (const scope of Object.values(before.scopes))
      for (const upload of scope.uploads) {
        const plain = createHash('sha256').update(upload.bytes).digest('hex');
        for (const [label, text] of [
          ['snapshot file', file],
          ['snapshot output', taken.stdout],
          ['compare output', compared.stdout],
        ])
          for (const piece of [plain, plain.slice(0, 12)])
            assert.ok(!text.includes(piece), `${label} holds the plain SHA-256 of an upload`);
      }
    assert.equal(JSON.parse(file).version, 4);
    assert.equal(compared.status, 1, compared.stdout);
    assert.match(compared.stdout, /^ {2}uploads: 1 -> 1, upload \[[0-9a-f]{8}\] content differs$/m);
  }));

test('T33 follow-up: compare refuses a snapshot of an older format before signing in', () =>
  withTemp(async (dir) => {
    const api = await fakeApi(fixture());
    try {
      const login = await credentials(dir);
      for (const version of [1, 2]) {
        const old = join(dir, `old-${version}.json`);
        await writeFile(
          old,
          JSON.stringify({
            format: 'sipges.migration-snapshot',
            version,
            salt: '00',
            projects: [],
          }),
        );
        const compared = await run(compareCli, ['--before', old, '--url', api.url, ...login]);
        assert.equal(compared.status, 1, `version ${version}`);
        assert.equal(compared.stdout, '');
        assert.match(
          compared.stderr,
          /^Error: .+ was made by an older snapshot\.mjs; take it again with this one before the move\n$/,
        );
      }
    } finally {
      api.close();
    }
  }));

// ---------------------------------------------------------------------------------------------
// Which server answers. The old version keeps answering /health on the same port, so before
// comparing compare.mjs asks for GET /system/desktop/update, which only a managed install started
// by the desktop launcher mounts (apps/api/src/app.ts), and prints the version it reports. A
// refusal is its own RESULT and exit code: never "no difference".

/** Every file and folder under `dir`, with the content of each file. */
async function tree(dir) {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  const out = {};
  for (const entry of entries) {
    const path = join(entry.parentPath, entry.name).slice(dir.length);
    out[path] = entry.isFile() ? await readFile(join(entry.parentPath, entry.name), 'utf8') : 'dir';
  }
  return out;
}

/** Snapshot from a managed fake, then compare --out against a fake with `afterOptions`. */
async function compareAgainst(parent, afterOptions) {
  const dir = await mkdtemp(join(parent, 'run-'));
  const login = await credentials(dir);
  const before = join(dir, 'before.json');
  const first = await fakeApi(fixture());
  try {
    const taken = await run(snapshotCli, ['--url', first.url, ...login, '--out', before]);
    assert.equal(taken.status, 0, taken.stderr);
  } finally {
    first.close();
  }
  const files = await tree(dir);
  const second = await fakeApi(fixture(), afterOptions);
  try {
    const out = join(dir, 'after.json');
    const compared = await run(compareCli, [
      '--before',
      before,
      '--url',
      second.url,
      ...login,
      '--out',
      out,
    ]);
    return { compared, written: existsSync(out), unchanged: files, now: await tree(dir) };
  } finally {
    second.close();
  }
}

test('F1: the old server (no managed-install route) is refused: not compared, exit 2, nothing written', () =>
  withTemp(async (dir) => {
    const { compared, written, unchanged, now } = await compareAgainst(dir, { desktop: null });
    assert.equal(compared.status, 2, compared.stdout + compared.stderr);
    assert.equal(compared.stderr, '');
    assert.equal(
      compared.stdout,
      [
        'Sign-in: ok (password and MFA code)',
        'Managed install: no (GET /system/desktop/update answered 404); the server on this port is not the new version installed with install.ps1 -Release',
        'RESULT: not compared (not the managed install)',
        '',
      ].join('\n'),
    );
    assert.doesNotMatch(compared.stdout, /no difference/);
    assert.equal(written, false, '--out must not be written when nothing was compared');
    assert.deepEqual(now, unchanged);
  }));

test('F1: a 200 answer that is not JSON (an HTML page) is not the managed install', () =>
  withTemp(async (dir) => {
    const { compared, written } = await compareAgainst(dir, { desktop: 'html' });
    assert.equal(compared.status, 2, compared.stdout + compared.stderr);
    assert.match(
      compared.stdout,
      /^Managed install: no \(GET \/system\/desktop\/update answered 200, not JSON\); the server on this port is not the new version installed with install\.ps1 -Release$/m,
    );
    assert.match(compared.stdout, /^RESULT: not compared \(not the managed install\)\n$/m);
    assert.doesNotMatch(compared.stdout, /no difference/);
    assert.equal(written, false);
  }));

test('F1: a managed install that does not report its version is refused: exit 2, nothing written', () =>
  withTemp(async (dir) => {
    for (const installed of [null, '', 42, 'x'.repeat(300), 'bad version\n']) {
      const { compared, written, unchanged, now } = await compareAgainst(dir, {
        desktop: { installed },
      });
      assert.equal(compared.status, 2, `${JSON.stringify(installed)}: ${compared.stdout}`);
      assert.equal(compared.stderr, '');
      assert.equal(
        compared.stdout,
        [
          'Sign-in: ok (password and MFA code)',
          'Managed install: version not readable (GET /system/desktop/update reports no installed version)',
          'RESULT: not compared (installed version not readable)',
          '',
        ].join('\n'),
      );
      assert.equal(written, false);
      assert.deepEqual(now, unchanged);
    }
  }));

test('F1 preserved: the managed install with the same data prints its version and no difference, exit 0', () =>
  withTemp(async (dir) => {
    const { compared, written } = await compareAgainst(dir, {});
    assert.equal(compared.status, 0, compared.stdout + compared.stderr);
    assert.match(compared.stdout, /^Sign-in: ok \(password and MFA code\)\nManaged install: version 1\.0\.0-sintetico\.1\n/);
    assert.match(compared.stdout, /^RESULT: no difference\n$/m);
    assert.equal(written, true);
  }));

// ---------------------------------------------------------------------------------------------
// E7: the password typed at «Contraseña:» is not shown. Raw mode on the terminal (Windows console
// and Linux tty alike, Node's stdlib only): nothing typed is echoed, Enter ends it.

/** A fake terminal: input that records its raw mode, output that records what is shown. */
function fakeTerminal() {
  const input = new PassThrough();
  input.isTTY = true;
  input.isRaw = false;
  const modes = [];
  input.setRawMode = (mode) => {
    modes.push(mode);
    input.isRaw = mode;
    return input;
  };
  const output = new PassThrough();
  let shown = '';
  output.on('data', (chunk) => (shown += chunk));
  return { input, output, modes, shown: () => shown };
}

test('E7: the password prompt hides what is typed and restores the terminal', async () => {
  const { readHidden } = await import('./client.mjs');
  const term = fakeTerminal();
  const answer = readHidden('Contraseña: ', term);
  term.input.write('clave-sintetica-x');
  term.input.write('\u007f\b'); // two kinds of backspace erase "-x"
  term.input.write('y\u001b[A'); // an arrow key is ignored
  term.input.write('\r');
  assert.equal(await answer, 'clave-sinteticay');
  assert.equal(term.shown(), 'Contraseña: \n');
  assert.deepEqual(term.modes, [true, false]);
  assert.equal(term.input.isRaw, false);
});

test('E7: Ctrl+C at the password prompt cancels and restores the terminal', async () => {
  const { readHidden } = await import('./client.mjs');
  const term = fakeTerminal();
  const answer = readHidden('Contraseña: ', term);
  term.input.write('abc\u0003');
  await assert.rejects(answer, /^Error: Cancelado \(Ctrl\+C\)$/);
  assert.deepEqual(term.modes, [true, false]);
  assert.ok(!term.shown().includes('abc'));
});

test('E7 preserved: credentials ask the password hidden, then the MFA code; no terminal gives empty answers', async () => {
  const { credentials: ask } = await import('./client.mjs');
  const term = fakeTerminal();
  const saved = process.env.SIPGES_MIGRATION_PASSWORD;
  delete process.env.SIPGES_MIGRATION_PASSWORD;
  try {
    const answered = ask({ '--url': 'http://127.0.0.1:1' }, term);
    term.input.write('clave-sintetica-z\r');
    const deadline = Date.now() + 5000;
    while (!term.shown().includes('Código MFA')) {
      assert.ok(Date.now() < deadline, `no MFA prompt; shown: ${JSON.stringify(term.shown())}`);
      await new Promise((r) => setTimeout(r, 5));
    }
    term.input.write('123456\n');
    const got = await answered;
    assert.equal(got.password, 'clave-sintetica-z');
    assert.equal(got.otp, '123456');
    assert.equal(got.username, 'admin');
    assert.ok(!term.shown().includes('clave-sintetica-z'), term.shown());
    assert.ok(term.shown().startsWith('Contraseña: \nCódigo MFA (vacío si no tiene): '));
    const piped = new PassThrough();
    const none = await ask({ '--url': 'http://127.0.0.1:1' }, { input: piped, output: new PassThrough() });
    assert.deepEqual([none.password, none.otp], ['', undefined]);
  } finally {
    if (saved !== undefined) process.env.SIPGES_MIGRATION_PASSWORD = saved;
  }
});

test('F1: a redirect is not the managed install, even to a route that would answer: exit 2', () =>
  withTemp(async (dir) => {
    const { compared, written } = await compareAgainst(dir, { desktop: 'redirect' });
    assert.equal(compared.status, 2, compared.stdout + compared.stderr);
    assert.equal(
      compared.stdout,
      [
        'Sign-in: ok (password and MFA code)',
        'Managed install: no (GET /system/desktop/update answered 302); the server on this port is not the new version installed with install.ps1 -Release',
        'RESULT: not compared (not the managed install)',
        '',
      ].join('\n'),
    );
    assert.equal(written, false);
  }));

// ---------------------------------------------------------------------------------------------
// Rule 1 (rc3): no request of the migration client follows a redirect. A server that reports the
// managed version while sending data reads elsewhere must never come out as "no difference".

test('rc3 rule 1: compare refuses a redirect on any request: not compared, exit 2, nothing written', () =>
  withTemp(async (dir) => {
    for (const [redirect, line] of [
      [{ prefix: '/api/', status: 302 }, 'redirect: GET /api/eventos answered 302, not followed'],
      [
        { prefix: '/system/uploads/', status: 307 },
        'redirect: GET /system/uploads/<id> answered 307, not followed',
      ],
      [{ prefix: '/login', status: 307 }, 'redirect: POST /login answered 307, not followed'],
    ]) {
      const { compared, written } = await compareAgainst(dir, { redirect });
      const label = `${redirect.prefix}: ${compared.stdout}${compared.stderr}`;
      assert.equal(compared.status, 2, label);
      assert.equal(compared.stdout.split('\n').at(-2), `RESULT: not compared (${line})`, label);
      assert.doesNotMatch(compared.stdout, /no difference|identical/, label);
      assert.equal(written, false, label);
      absent(compared.stdout + compared.stderr, fixture(), 'compare output');
    }
  }));

test('rc3 rule 1: snapshot refuses a redirect: non-zero exit, the redirect named, no file', () =>
  withTemp(async (dir) => {
    const login = await credentials(dir);
    const out = join(dir, 'before.json');
    const api = await fakeApi(fixture(), { redirect: { prefix: '/api/', status: 302 } });
    let taken;
    try {
      taken = await run(snapshotCli, ['--url', api.url, ...login, '--out', out]);
    } finally {
      api.close();
    }
    assert.notEqual(taken.status, 0, taken.stdout + taken.stderr);
    assert.equal(taken.stdout, '');
    assert.equal(taken.stderr, 'Error: GET /api/eventos answered 302, a redirect (not followed)\n');
    assert.equal(existsSync(out), false, 'no snapshot file may be left');
  }));

// Rule 2 (rc3): a comparison that did not happen (server not reachable, connection dropped) is
// "not compared" with exit code 2, never the 1 of a comparison that found differences.

test('rc3 rule 2: an unreachable server or a dropped connection is not compared, exit 2', () =>
  withTemp(async (dir) => {
    const dropped = await compareAgainst(dir, { drop: '/system/links' });
    assert.equal(dropped.compared.status, 2, dropped.compared.stdout + dropped.compared.stderr);
    assert.match(
      dropped.compared.stdout,
      /^Managed install: version 1\.0\.0-sintetico\.1\nRESULT: not compared \(the server could not be reached or the connection dropped: [^\n]+\)\n$/m,
    );
    assert.equal(dropped.written, false);

    const run2 = await mkdtemp(join(dir, 'gone-'));
    const login = await credentials(run2);
    const before = join(run2, 'before.json');
    const api = await fakeApi(fixture());
    try {
      assert.equal(
        (await run(snapshotCli, ['--url', api.url, ...login, '--out', before])).status,
        0,
      );
    } finally {
      api.close();
    }
    const closed = createServer();
    closed.listen(0, '127.0.0.1');
    await once(closed, 'listening');
    const gone = `http://127.0.0.1:${closed.address().port}`;
    closed.close();
    await once(closed, 'close');
    const compared = await run(compareCli, ['--before', before, '--url', gone, ...login]);
    assert.equal(compared.status, 2, compared.stdout + compared.stderr);
    assert.equal(
      compared.stdout,
      'RESULT: not compared (the server could not be reached or the connection dropped: fetch failed, ECONNREFUSED)\n',
    );
    assert.match(compared.stderr, /^Error: fetch failed\n$/);
  }));

test('F1: a valid JSON body sent as text/plain is not the managed install: exit 2', () =>
  withTemp(async (dir) => {
    const { compared, written } = await compareAgainst(dir, { desktop: 'text' });
    assert.equal(compared.status, 2, compared.stdout + compared.stderr);
    assert.match(
      compared.stdout,
      /^Managed install: no \(GET \/system\/desktop\/update answered 200, not JSON\);/m,
    );
    assert.match(compared.stdout, /^RESULT: not compared \(not the managed install\)\n$/m);
    assert.equal(written, false);
  }));

test('F1: a 403 (no project scope, or not an administrator) has its own text: exit 2', () =>
  withTemp(async (dir) => {
    const { compared, written } = await compareAgainst(dir, { desktop: 'forbidden' });
    assert.equal(compared.status, 2, compared.stdout + compared.stderr);
    assert.equal(
      compared.stdout,
      [
        'Sign-in: ok (password and MFA code)',
        'Managed install: not asked (GET /system/desktop/update answered 403: this account has no project scope or is not an administrator)',
        'RESULT: not compared (no project scope for this account)',
        '',
      ].join('\n'),
    );
    assert.doesNotMatch(compared.stdout, /no difference/);
    assert.equal(written, false);
  }));

// ---------------------------------------------------------------------------------------------
// rc4 follow-ups of the independent review: the remaining redirect statuses, a redirect during
// the isolation probes, the option errors that stop before signing in, an --out that exists, and
// a 200 answer whose body is not JSON (its parse error would quote part of the body).

test('rc4: a redirect on an isolation probe is not compared, exit 2, the record id masked', () =>
  withTemp(async (dir) => {
    const { compared } = await compareAgainst(dir, {
      redirect: { prefix: '/api/eventos/', status: 302 },
    });
    const label = compared.stdout + compared.stderr;
    assert.equal(compared.status, 2, label);
    // The probes come last: the per-module lines were printed, the Isolation line never was.
    assert.match(compared.stdout, /^Accounts: 2 -> 2, identical$/m, label);
    assert.doesNotMatch(compared.stdout, /^Isolation:/m, label);
    assert.equal(
      compared.stdout.split('\n').at(-2),
      'RESULT: not compared (redirect: GET /api/eventos/<id> answered 302, not followed)',
      label,
    );
    assert.equal(
      compared.stderr,
      'Error: GET /api/eventos/<id> answered 302, a redirect (not followed)\n',
    );
    assert.doesNotMatch(compared.stdout, /no difference/);
    absent(label, fixture(), 'compare output');
  }));

test('rc4: 301, 303 and 308 are refused like 302 and 307, on a read and on the sign-in', () =>
  withTemp(async (dir) => {
    for (const status of [301, 303, 308])
      for (const [prefix, route] of [
        ['/system/links', 'GET /system/links'],
        ['/login', 'POST /login'],
      ]) {
        const { compared, written } = await compareAgainst(dir, { redirect: { prefix, status } });
        const label = `${status} ${prefix}: ${compared.stdout}${compared.stderr}`;
        assert.equal(compared.status, 2, label);
        assert.equal(
          compared.stdout.split('\n').at(-2),
          `RESULT: not compared (redirect: ${route} answered ${status}, not followed)`,
          label,
        );
        assert.doesNotMatch(
          compared.stdout + compared.stderr,
          /no difference|identical|sign-in failed/i,
          label,
        );
        assert.equal(written, false, label);
      }
  }));

test('rc4: a --password-file that does not exist stops before signing in: exit 1, no RESULT', () =>
  withTemp(async (dir) => {
    const { FORMAT, FORMAT_VERSION } = await import('./snapshot.mjs');
    const before = join(dir, 'before.json');
    await writeFile(
      before,
      JSON.stringify({ format: FORMAT, version: FORMAT_VERSION, salt: '00', projects: [] }),
    );
    // Nothing listens on port 1: no request is needed to refuse the option.
    const compared = await run(compareCli, [
      '--before',
      before,
      '--url',
      'http://127.0.0.1:1',
      '--password-file',
      join(dir, 'missing-password'),
      '--otp',
      '123456',
    ]);
    assert.equal(compared.status, 1, compared.stdout + compared.stderr);
    assert.equal(compared.stdout, '');
    assert.match(compared.stderr, /^Error: ENOENT: [^\n]+\n$/);
  }));

test('rc4: an --out file that already exists is kept: not compared, exit 2', () =>
  withTemp(async (dir) => {
    const login = await credentials(dir);
    const before = join(dir, 'before.json');
    const out = join(dir, 'after.json');
    const kept = 'contenido-sintetico-previo\n';
    const api = await fakeApi(fixture());
    try {
      const taken = await run(snapshotCli, ['--url', api.url, ...login, '--out', before]);
      assert.equal(taken.status, 0, taken.stderr);
      await writeFile(out, kept);
      const compared = await run(compareCli, [
        '--before',
        before,
        '--url',
        api.url,
        ...login,
        '--out',
        out,
      ]);
      assert.equal(compared.status, 2, compared.stdout + compared.stderr);
      assert.match(
        compared.stdout.split('\n').at(-2),
        /^RESULT: not compared \(error: EEXIST: [^\n]+\)$/,
      );
      assert.match(compared.stderr, /^Error: EEXIST: [^\n]+\n$/);
      assert.equal(await readFile(out, 'utf8'), kept);
    } finally {
      api.close();
    }
  }));

test('rc4: a 200 answer that is not valid JSON is named by its route, never quoted: compare exit 2', () =>
  withTemp(async (dir) => {
    for (const [notJson, route] of [
      ['/api/eventos/', 'GET /api/eventos/<id>'],
      ['/api/eventos', 'GET /api/eventos'],
    ]) {
      const { compared } = await compareAgainst(dir, { notJson });
      const label = `${notJson}: ${compared.stdout}${compared.stderr}`;
      const why = `${route} answered 200 with a body that is not valid JSON`;
      assert.equal(compared.status, 2, label);
      assert.equal(
        compared.stdout.split('\n').at(-2),
        `RESULT: not compared (error: ${why})`,
        label,
      );
      assert.equal(compared.stderr, `Error: ${why}\n`, label);
      assert.ok(!label.includes(NOT_JSON_MARK), `the body was quoted: ${label}`);
      assert.doesNotMatch(compared.stdout, /no difference/, label);
      absent(label, fixture(), 'compare output');
    }
  }));

test('rc4: snapshot names a 200 answer that is not valid JSON by its route: non-zero exit, no file', () =>
  withTemp(async (dir) => {
    const login = await credentials(dir);
    for (const [notJson, route] of [
      ['/api/eventos', 'GET /api/eventos'],
      ['/system/uploads/', 'GET /system/uploads/<id>'],
    ]) {
      const out = join(dir, `before-${notJson.replaceAll('/', '-')}.json`);
      const api = await fakeApi(fixture(), { notJson });
      let taken;
      try {
        taken = await run(snapshotCli, ['--url', api.url, ...login, '--out', out]);
      } finally {
        api.close();
      }
      const label = `${notJson}: ${taken.stdout}${taken.stderr}`;
      assert.notEqual(taken.status, 0, label);
      assert.equal(taken.stdout, '', label);
      assert.equal(
        taken.stderr,
        `Error: ${route} answered 200 with a body that is not valid JSON\n`,
        label,
      );
      assert.ok(!label.includes(NOT_JSON_MARK), `the body was quoted: ${label}`);
      assert.equal(existsSync(out), false, label);
    }
  }));

// Owner's decision (2026-11-18, option 2): a bigint column of the export compares by value. The
// TypeScript API on PGlite sends size_bytes as a JSON number, the Go API (and the TypeScript API on
// PostgreSQL) as a digit string; the visit's "before" comes from the installed TypeScript version.
test('an exported bigint column compares by value: 1234 equals "1234", nothing else is relaxed', async () => {
  const { exportRowHash, FORMAT_VERSION } = await import('./snapshot.mjs');
  const { keyed } = await import('./client.mjs');
  const h = keyed('00');
  const row = (size, extra = {}) => ({ id: 'U-1', size_bytes: size, sha256: 'a'.repeat(64), ...extra });
  assert.equal(exportRowHash(h, 'attachments', row(1234)), exportRowHash(h, 'attachments', row('1234')));
  assert.notEqual(exportRowHash(h, 'attachments', row(1234)), exportRowHash(h, 'attachments', row('1235')));
  assert.notEqual(exportRowHash(h, 'attachments', row(1234)), exportRowHash(h, 'attachments', row(1234.5)));
  // Only the declared bigint columns: a number and a string elsewhere still differ.
  assert.notEqual(
    exportRowHash(h, 'attachments', row(1234, { notes: 7 })),
    exportRowHash(h, 'attachments', row(1234, { notes: '7' })),
  );
  assert.notEqual(exportRowHash(h, 'record_links', { id: 1 }), exportRowHash(h, 'record_links', { id: '1' }));
  // Snapshots hashed the old way are refused, never compared.
  assert.equal(FORMAT_VERSION, 4);
});

// go-rust-stack T72d3: sipges-desktop --snapshot and --compare are snapshot.mjs and compare.mjs
// in Go. Against the same synthetic API they must write the same file (format 4, byte for byte
// with the same salt), print the same lines and exit with the same codes, so a Node snapshot
// taken before the visit compares against the Go one after, and the other way round.
const goModule = join(here, '..', '..', '..', 'apps', 'api-go');
let goBuild;
/** Builds sipges-desktop once; null when Go is not on PATH (the test is then skipped). */
function goDesktop() {
  goBuild ??= (async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sipges-go-desktop-'));
    const bin = join(dir, process.platform === 'win32' ? 'sipges-desktop.exe' : 'sipges-desktop');
    const child = spawn('go', ['build', '-o', bin, './cmd/sipges-desktop'], {
      cwd: goModule,
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (d) => (stderr += d));
    const [status] = await Promise.race([
      once(child, 'exit'),
      once(child, 'error').then(() => [null]),
    ]);
    if (status === null) return null;
    assert.equal(status, 0, `go build: ${stderr}`);
    process.once('exit', () => rm(dir, { recursive: true, force: true }));
    return bin;
  })();
  return goBuild;
}

/** Runs sipges-desktop <mode> like `run` runs a script. */
function runGo(bin, mode, args, { timeoutMs = 60_000 } = {}) {
  const child = spawn(bin, [mode, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (d) => (stdout += d));
  child.stderr.on('data', (d) => (stderr += d));
  const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
  return once(child, 'exit').then(([status]) => {
    clearTimeout(timer);
    return { status, stdout, stderr };
  });
}

/** A snapshot file with its time of day and hashes masked: what the format itself is. */
const shape = (text) =>
  text.replace(/"takenAt": "[^"]+"/, '"takenAt": "T"').replace(/[0-9a-f]{64}|[0-9a-f]{32}/g, 'H');
const sameFile = (a, b) => assert.equal(a.replace(/"takenAt": "[^"]+"/, ''), b.replace(/"takenAt": "[^"]+"/, ''));

test('T72d3: Node and Go snapshots of one API are the same file; either compares with either', async (t) => {
  const bin = await goDesktop();
  if (!bin) return t.skip('go is not on PATH');
  await withTemp(async (dir) => {
    const login = await credentials(dir);
    const api = await fakeApi(fixture());
    try {
      const out = (name) => join(dir, name);
      const node = await run(snapshotCli, ['--url', api.url, ...login, '--out', out('node.json')]);
      const go = await runGo(bin, '--snapshot', ['--url', api.url, ...login, '--out', out('go.json')]);
      assert.equal(node.status, 0, node.stderr);
      assert.equal(go.status, 0, go.stderr);
      const mask = (text) =>
        text
          .replace(/^SIPGES snapshot at .*$/m, '')
          .replace(/\[[0-9a-f]{8}\]/g, '[h]')
          .replace(/^Written: .*$/m, '');
      assert.equal(mask(go.stdout), mask(node.stdout));
      assert.match(go.stdout, /^Written: .*go\.json$/m);
      const [nodeFile, goFile] = [await readFile(out('node.json'), 'utf8'), await readFile(out('go.json'), 'utf8')];
      assert.equal(shape(goFile), shape(nodeFile), 'the same keys, order, layout and values');
      absent(goFile + go.stdout + go.stderr, fixture(), 'the Go snapshot');

      // The same salt (the --before file's): byte-identical after-files, identical output.
      for (const [label, before] of [['Node', 'node.json'], ['Go', 'go.json']]) {
        const n = await run(compareCli, ['--before', out(before), '--url', api.url, ...login, '--out', out(`${before}.node-after`)]);
        const g = await runGo(bin, '--compare', ['--before', out(before), '--url', api.url, ...login, '--out', out(`${before}.go-after`)]);
        assert.equal(n.status, 0, `compare.mjs on the ${label} snapshot: ${n.stdout}${n.stderr}`);
        assert.equal(g.status, 0, `--compare on the ${label} snapshot: ${g.stdout}${g.stderr}`);
        assert.equal(g.stdout, n.stdout, `the ${label} snapshot compared by both`);
        assert.match(g.stdout, /^RESULT: no difference$/m);
        sameFile(await readFile(out(`${before}.go-after`), 'utf8'), await readFile(out(`${before}.node-after`), 'utf8'));
        sameFile(await readFile(out(`${before}.go-after`), 'utf8'), await readFile(out(before), 'utf8'));
      }
    } finally {
      api.close();
    }
  });
});

/** compare.mjs and --compare on one Node snapshot of `before`, each against a fresh `after` API. */
async function compareBoth(parent, bin, before, after, beforeOptions, afterOptions, extra = []) {
  const dir = await mkdtemp(join(parent, 'both-'));
  const login = await credentials(dir);
  const file = join(dir, 'before.json');
  const first = await fakeApi(before, beforeOptions);
  try {
    const taken = await run(snapshotCli, ['--url', first.url, ...login, '--out', file]);
    assert.equal(taken.status, 0, taken.stderr);
  } finally {
    first.close();
  }
  const results = [];
  for (const go of [false, true]) {
    const api = await fakeApi(after, afterOptions);
    try {
      const args = ['--before', file, '--url', api.url, ...login, ...extra];
      results.push(go ? await runGo(bin, '--compare', args) : await run(compareCli, args));
    } finally {
      api.close();
    }
  }
  return { node: results[0], go: results[1] };
}

test('T72d3: a planted difference, gap or refusal is reported identically by Node and Go', async (t) => {
  const bin = await goDesktop();
  if (!bin) return t.skip('go is not on PATH');
  const alfa = 'EMPRESA-SINTETICA/PRJ-ALFA-SINTETICO';
  const changed = fixture();
  changed.scopes[alfa].records.eventos[1].Lugar = 'OTRO-VALOR-SECRETO';
  changed.scopes['EMPRESA-SINTETICA/PRJ-BETA-SINTETICO'].uploads[0].bytes = 'CONTENIDO-CAMBIADO\n';
  const typed = fixture();
  typed.scopes[alfa].records.eventos[0].Fecha = 20260102;
  const lost = auditOf(fixture());
  lost[alfa].splice(1, 1);
  const many = fixture();
  many.scopes[alfa].records.eventos = Array.from({ length: 30 }, (_, i) => ({
    _id: `EV-MUCHOS-${String(i).padStart(4, '0')}`,
    Titulo: `TITULO-SECRETO-${i}`,
  }));
  const long = auditOf(fixture(), { [alfa]: Array.from({ length: 600 }, () => 'login') });
  const cases = [
    ['a changed field and upload', fixture(), changed, {}, {}, 1],
    ['a field whose JSON type changed', fixture(), typed, {}, {}, 1],
    ['audit entries added', fixture(), fixture(), {}, { audit: auditOf(fixture(), { [alfa]: ['login', 'migrate'] }) }, 0],
    ['an audit entry missing', fixture(), fixture(), {}, { audit: lost }, 1],
    ['a leak between projects', fixture(), fixture(), {}, { leak: true }, 1],
    ['a shared id answered with the other content', fixture(), fixture(), {}, { leakShared: true }, 1],
    ['no export on either side', fixture(), fixture(), { noExport: true }, { noExport: true }, 1],
    ['the export on one side only', fixture(), fixture(), {}, { noExport: true }, 1],
    ['no accounts on either side', fixture(), fixture(), { noAccounts: true }, { noAccounts: true }, 1],
    ['a list that ignores its offset, proved by the export', many, many, {}, { ignoreOffset: true }, 0],
    ['a list that ignores its offset, no export', many, many, { noExport: true }, { ignoreOffset: true, noExport: true }, 1],
    ['a list capped below the page', many, many, { listCap: 7 }, { listCap: 7 }, 0],
    ['a trail past one page without the export', fixture(), fixture(), { audit: long, noExport: true }, { audit: long, noExport: true }, 1],
    ['the old server', fixture(), fixture(), {}, { desktop: null }, 2],
    ['an HTML answer', fixture(), fixture(), {}, { desktop: 'html' }, 2],
    ['JSON sent as text', fixture(), fixture(), {}, { desktop: 'text' }, 2],
    ['a 403 on the managed route', fixture(), fixture(), {}, { desktop: 'forbidden' }, 2],
    ['no installed version', fixture(), fixture(), {}, { desktop: { installed: '' } }, 2],
    ['a redirect on the managed route', fixture(), fixture(), {}, { desktop: 'redirect' }, 2],
    ['a redirect on a read', fixture(), fixture(), {}, { redirect: { prefix: '/system/links', status: 307 } }, 2],
    ['a body that is not JSON', fixture(), fixture(), {}, { notJson: '/system/links' }, 2],
    ['an MFA sign-in that no longer works', fixture(), fixture(), {}, { mfaBroken: true }, 1],
  ];
  await withTemp(async (dir) => {
    for (const [label, before, after, beforeOptions, afterOptions, status] of cases) {
      const { node, go } = await compareBoth(dir, bin, before, after, beforeOptions, afterOptions);
      assert.equal(node.status, status, `${label}: compare.mjs ${node.stdout}${node.stderr}`);
      assert.equal(go.status, status, `${label}: --compare ${go.stdout}${go.stderr}`);
      assert.equal(go.stdout, node.stdout, `${label}: the same lines`);
      assert.equal(go.stderr, node.stderr, `${label}: the same errors`);
      absent(go.stdout + go.stderr, after, `${label}: --compare output`);
    }
    const dropped = await compareBoth(dir, bin, fixture(), fixture(), {}, { drop: '/system/links' });
    assert.equal(dropped.go.status, 2, dropped.go.stdout + dropped.go.stderr);
    assert.equal(dropped.go.stdout, dropped.node.stdout);
    assert.equal(dropped.go.stderr, dropped.node.stderr);
    assert.match(
      dropped.go.stdout,
      /^Managed install: version 1\.0\.0-sintetico\.1\nRESULT: not compared \(the server could not be reached or the connection dropped: [^\n]+\)\n$/m,
    );
    const closed = createServer();
    closed.listen(0, '127.0.0.1');
    await once(closed, 'listening');
    const gone = `http://127.0.0.1:${closed.address().port}`;
    closed.close();
    await once(closed, 'close');
    const login = await credentials(dir);
    const file = join(dir, 'reach.json');
    const api = await fakeApi(fixture());
    try {
      assert.equal((await run(snapshotCli, ['--url', api.url, ...login, '--out', file])).status, 0);
    } finally {
      api.close();
    }
    const nodeGone = await run(compareCli, ['--before', file, '--url', gone, ...login]);
    const goGone = await runGo(bin, '--compare', ['--before', file, '--url', gone, ...login]);
    assert.equal(goGone.status, 2);
    assert.equal(goGone.stdout, nodeGone.stdout);
    assert.equal(goGone.stderr, nodeGone.stderr);
    const limited = await compareBoth(dir, bin, many, many, {}, {}, ['--probe-limit', '3']);
    assert.equal(limited.go.stdout, limited.node.stdout, '--probe-limit');
    assert.match(limited.go.stdout, /^Isolation: \d+ probes, no record/m);
  });
});

test('T72d3: Go refuses what compare.mjs refuses before signing in, with the same exit code', async (t) => {
  const bin = await goDesktop();
  if (!bin) return t.skip('go is not on PATH');
  await withTemp(async (dir) => {
    const old = join(dir, 'old.json');
    await writeFile(old, JSON.stringify({ format: 'sipges.migration-snapshot', version: 3, salt: '00' }));
    for (const args of [
      ['--before', old, '--url', 'http://127.0.0.1:9'],
      ['--url', 'http://127.0.0.1:9'],
      ['--before', old, '--url', 'http://127.0.0.1:9', '--probe-limit', '-1'],
      ['--before', old, '--bogus', 'x'],
    ]) {
      const node = await run(compareCli, args);
      const go = await runGo(bin, '--compare', args);
      assert.equal(go.status, node.status, args.join(' '));
      assert.equal(go.stdout, node.stdout, args.join(' '));
      assert.equal(go.stderr, node.stderr, args.join(' '));
    }
    const help = await runGo(bin, '--compare', ['--help']);
    assert.equal(help.status, 0);
    assert.match(help.stdout, /^Usage: sipges-desktop --compare --before/);
    const snap = await runGo(bin, '--snapshot', ['--url', 'http://127.0.0.1:9']);
    assert.equal(snap.status, 1);
    assert.equal(snap.stderr, 'Error: --url and --out are required\n');
  });
});

test('T72d3 follow-up: an edited --before shape gets the exit code compare.mjs gives it', async (t) => {
  const bin = await goDesktop();
  if (!bin) return t.skip('go is not on PATH');
  await withTemp(async (dir) => {
    const login = await credentials(dir);
    const file = join(dir, 'before.json');
    const api = await fakeApi(fixture());
    try {
      assert.equal((await run(snapshotCli, ['--url', api.url, ...login, '--out', file])).status, 0);
      const original = JSON.parse(await readFile(file, 'utf8'));
      const firstRecord = (s) => {
        const rows = Object.values(s.projects[0].modules).find((r) => Object.keys(r).length);
        return [rows, Object.keys(rows)[0]];
      };
      // JavaScript's default parameters read a missing map as empty (a difference, exit 1);
      // a null or a missing list it must iterate stops the comparison (not compared, exit 2).
      const edits = [
        ['a record that is a number', 1, (s) => { const [rows, k] = firstRecord(s); rows[k] = 5; }],
        ['a record without fields', 1, (s) => { const [rows, k] = firstRecord(s); delete rows[k].fields; }],
        ['a project without links', 1, (s) => { delete s.projects[0].links; }],
        ['the only upload a number (its content has no slice)', 2, (s) => { const u = s.projects[0].uploads; u[Object.keys(u)[0]] = 5; }],
        ['a project without uploads', 2, (s) => { delete s.projects[0].uploads; }],
        ['an audit without entries', 2, (s) => { delete s.projects[0].audit.entries; }],
        ['a record whose fields are null', 2, (s) => { const [rows, k] = firstRecord(s); rows[k].fields = null; }],
      ];
      for (const [label, status, edit] of edits) {
        const edited = structuredClone(original);
        edit(edited);
        const path = join(dir, `${label.replaceAll(' ', '-')}.json`);
        await writeFile(path, JSON.stringify(edited));
        const node = await run(compareCli, ['--before', path, '--url', api.url, ...login]);
        const go = await runGo(bin, '--compare', ['--before', path, '--url', api.url, ...login]);
        assert.equal(node.status, status, `${label}: compare.mjs ${node.stdout}${node.stderr}`);
        assert.equal(go.status, status, `${label}: --compare ${go.stdout}${go.stderr}`);
        if (status === 1) assert.equal(go.stdout, node.stdout, `${label}: the same lines`);
        else assert.match(go.stdout, /^RESULT: not compared \(error: /m, label);
      }
    } finally {
      api.close();
    }
  });
});
