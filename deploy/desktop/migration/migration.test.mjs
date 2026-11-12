// The snapshot and comparison scripts of the data move (closure-roadmap T33), against a small
// fake of the SIPGES HTTP API filled with synthetic, recognisable values. They must print and
// store only counts and hashes, and report every difference, an MFA sign-in that no longer works
// (the old data key) and a record visible from another project.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import process from 'node:process';
import { Buffer } from 'node:buffer';
import { createHmac, randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { URL, URLSearchParams, fileURLToPath } from 'node:url';

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
const PASSWORD = 'clave-sintetica-admin-001';

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
  { audit = auditOf(data), mfaBroken = false, leak = false, leakShared = false } = {},
) {
  const sessions = new Set();
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://fake');
    const json = (status, body) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
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
      const offset = Number(url.searchParams.get('offset') ?? 0);
      const limit = Number(url.searchParams.get('limit') ?? 200);
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
    if (url.pathname === '/system/uploads')
      return json(
        200,
        scope.uploads.map((u) => ({
          id: u.id,
          original_name: u.name,
          sha256: 'x',
          size_bytes: u.bytes.length,
        })),
      );
    const download = /^\/system\/uploads\/([^/]+)\/download$/.exec(url.pathname);
    if (download) {
      const found = (
        leak ? Object.values(data.scopes).flatMap((s) => s.uploads) : scope.uploads
      ).find((u) => u.id === decodeURIComponent(download[1]));
      if (!found) return json(404, { detail: 'No encontrado' });
      res.writeHead(200, { 'content-type': 'text/plain' });
      return res.end(found.bytes);
    }
    if (url.pathname === '/system/export')
      return json(200, {
        format: 'sipges.tenant-export',
        version: 1,
        exported_at: new Date().toISOString(),
        data: {
          module_records: Object.values(scope.records).flat(),
          audit: audit[scopeName] ?? [],
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

function run(script, args) {
  const child = spawn(process.execPath, [script, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (d) => (stdout += d));
  child.stderr.on('data', (d) => (stderr += d));
  return once(child, 'exit').then(([status]) => ({ status, stdout, stderr }));
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
    taken = await run(snapshotCli, ['--url', first.url, ...login, '--out', out]);
  } finally {
    first.close();
  }
  assert.equal(taken.status, 0, taken.stderr);
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
    assert.match(compared.stdout, /^ {2}uploads: 1 -> 1, sha256 [0-9a-f]{12}… identical$/m);
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
