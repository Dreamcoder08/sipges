// Records the TypeScript prevention write routes' answers on synthetic requests, for the Go port's
// pinned test (../http/writes_fixtures_test.go). Each request runs through the real
// preventionRoutes and createPreventionService (apps/api/src/contexts/prevention) with a fixed
// clock, a counting randomHex and an in-memory store that logs what the SQL store would write. Run
// from the repository root after changing either side:
//
//   node apps/api-go/internal/prevention/testdata/writes.mjs          # rewrites writes.json
//   node apps/api-go/internal/prevention/testdata/writes.mjs --check  # exit 1 when it drifted
//
// Every plan and alert is synthetic: no real record is read.
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { format, resolveConfig } from 'prettier';
import { createPreventionService } from '../../../../api/src/contexts/prevention/application/prevention-service.ts';
import { preventionRoutes } from '../../../../api/src/contexts/prevention/http/prevention-routes.ts';

const OUT = fileURLToPath(new URL('./writes.json', import.meta.url));
const AT = '2026-11-03T12:00:00.123Z';
const CREATED = '2026-01-01T00:00:00.000Z';
const scope = { companyId: 'SIPGES', projectId: 'PRJ-SINT' };

const ALERTS = {
  'ALERT-OK': 'Corroborado',
  'ALERT-SEG': 'En seguimiento',
  'ALERT-NEW': 'Descartado',
};
const RECEIPTS = {
  'EV-1': { attachmentId: 'EV-1', fileName: 'acta.pdf', sha256: 'ab'.repeat(32) },
};
const STORED = { 'PREV-OPEN': 'Pendiente', 'PREV-RUN': 'En ejecución', 'PREV-CANCEL': 'Cancelada' };

const stored = (id, status) => ({
  id,
  projectId: scope.projectId,
  alertId: 'ALERT-OK',
  title: 'Plan sintético',
  responsible: 'Equipo',
  dueDate: '2027-01-01',
  description: '',
  status,
  progress: 0,
  createdAt: new Date(CREATED),
  updatedAt: new Date(CREATED),
  history: [],
  block: null,
});

/** The store of ports.ts in memory; `log` holds what each call would write. */
const memoryStore = (log) => ({
  async create(_tenant, action, logId) {
    log.push({
      op: 'create',
      action: { ...action, createdAt: action.createdAt.toISOString() },
      logId,
    });
    return {
      ...action,
      title: action.title.toWellFormed(), // what the row returns: Node sends U+FFFD
      status: 'Pendiente',
      progress: 0,
      updatedAt: action.createdAt,
      block: null,
      history: [],
    };
  },
  async update(_tenant, id, guard, change) {
    if (!(id in STORED)) return null;
    const current = stored(id, STORED[id]);
    const refused = guard(current);
    if (refused !== null) return { ok: false, error: refused };
    log.push({
      op: 'update',
      id,
      change: {
        ...change,
        createdAt: change.createdAt.toISOString(),
        block:
          change.block === undefined
            ? 'unchanged'
            : change.block && { ...change.block, since: change.block.since.toISOString() },
      },
    });
    return { ok: true, action: { ...current, status: change.status, progress: change.progress } };
  },
});

/** A counting stand-in for crypto-random hex: 1, 2, 3, … left-padded with F. */
const countingHex = () => {
  let n = 0;
  return (length) => (++n).toString(16).toUpperCase().padStart(length, 'F').slice(-length);
};

const J = JSON.stringify;
const POST = '/system/prevention/actions';
const plan = {
  alert_id: 'ALERT-OK',
  title: 'Plan válido',
  responsible: 'Equipo',
  due_date: '2027-02-28',
};
const change = { status: 'En ejecución', progress: 10 };
const closing = {
  status: 'Completada',
  progress: 100,
  note: 'Hecho',
  evidence_attachment_id: 'EV-1',
};
const creates = {
  valid: J(plan),
  'with its project and description': J({
    ...plan,
    project_id: 'PRJ-SINT',
    description: 'Detalle',
  }),
  'followed alert': J({ ...plan, alert_id: 'ALERT-SEG' }),
  'emoji title counts code points': J({ ...plan, title: '😀😀😀😀😀' }),
  'lone surrogate title counts one': `{"alert_id":"ALERT-OK","title":"ab\\ud800cd","responsible":"Equipo","due_date":"2027-02-28"}`,
  'title of 200 characters': J({ ...plan, title: 'x'.repeat(200) }),
  'unknown keys are dropped': J({ ...plan, extra: 1 }),
  'leap day': J({ ...plan, due_date: '2028-02-29' }),
  'alert missing': J({ ...plan, alert_id: 'ALERT-NADA' }),
  'alert unverified': J({ ...plan, alert_id: 'ALERT-NEW' }),
  'alert id of 80 code points over 80 units': J({ ...plan, alert_id: '😀'.repeat(41) }),
  'empty body': '',
  'not JSON': '{',
  'an array': '[]',
  null: 'null',
  'a string': '"x"',
  'empty object': '{}',
  'every field of the wrong type': J({
    project_id: 1,
    alert_id: 2,
    title: 3,
    responsible: 4,
    due_date: 5,
    description: 6,
  }),
  'null fields': J({
    project_id: null,
    alert_id: null,
    title: null,
    responsible: null,
    due_date: null,
  }),
  'short strings': J({ ...plan, project_id: '', alert_id: '', title: 'abcd', responsible: 'a' }),
  'long strings': J({
    project_id: 'x'.repeat(121),
    alert_id: 'x'.repeat(81),
    title: 'x'.repeat(201),
    responsible: 'x'.repeat(151),
    due_date: '2027-02-28',
    description: 'x'.repeat(2001),
  }),
  'arrays have a length': J({ ...plan, title: [], responsible: [1, 2, 3] }),
  'objects have a length': J({ ...plan, title: { length: 'abc' }, alert_id: { length: 0 } }),
  'object lengths read as numbers': J({
    ...plan,
    title: { length: '0x10' },
    responsible: { length: [1] },
    alert_id: { length: null },
  }),
  'impossible date': J({ ...plan, due_date: '2027-02-29' }),
  'month 13': J({ ...plan, due_date: '2027-13-01' }),
  'short date': J({ ...plan, due_date: '2027-2-28' }),
  'date with time': J({ ...plan, due_date: '2027-02-28T00:00:00Z' }),
  'date with a line feed': J({ ...plan, due_date: '2027-02-28\n' }),
  'empty date': J({ ...plan, due_date: '' }),
  'infinite title': '{"alert_id":"A","title":1e400,"responsible":"Equipo","due_date":"2027-02-28"}',
};
const updates = {
  progress: ['PREV-OPEN', J(change)],
  'pending at zero': ['PREV-OPEN', J({ status: 'Pendiente', progress: 0 })],
  'minus zero progress': ['PREV-OPEN', '{"status":"Pendiente","progress":-0}'],
  'blocked by': [
    'PREV-RUN',
    J({ ...change, blocked_by: ' Autoridad ', blocked_reason: ' Espera ' }),
  ],
  'blocked by without a reason': ['PREV-RUN', J({ ...change, blocked_by: 'Otro' })],
  'cleared block': ['PREV-RUN', J({ ...change, blocked_by: '  ' })],
  'closing clears the block': ['PREV-RUN', J({ ...closing, blocked_by: 'Otro' })],
  'completed with a receipt': ['PREV-RUN', J(closing)],
  'cancelled with a note': [
    'PREV-RUN',
    J({ status: 'Cancelada', progress: 40, note: 'Ya no aplica' }),
  ],
  'cancelled stays cancelled': [
    'PREV-CANCEL',
    J({ status: 'Cancelada', progress: 0, note: 'Sigue' }),
  ],
  'evidence url in capitals': [
    'PREV-OPEN',
    J({ ...change, evidence_url: 'HTTPS://example.org/a' }),
  ],
  'receipt with spaces': ['PREV-RUN', J({ ...closing, evidence_attachment_id: ' EV-1 ' })],
  'long note in the audit': ['PREV-RUN', J({ ...change, note: '😀'.repeat(300) })],
  'unknown status': ['PREV-OPEN', J({ status: 'Otro', progress: 0 })],
  'completed under 100': ['PREV-OPEN', J({ status: 'Completada', progress: 99 })],
  'pending with progress': ['PREV-OPEN', J({ status: 'Pendiente', progress: 1 })],
  'bad evidence url': ['PREV-OPEN', J({ ...change, evidence_url: 'ftp://example.org' })],
  'evidence url with a long s': [
    'PREV-OPEN',
    J({ ...change, evidence_url: 'httpſ://example.org' }),
  ],
  'id over 80 units': ['😀'.repeat(41), J(change)],
  'bad status beats the long id': ['😀'.repeat(41), J({ status: 'Otro', progress: 0 })],
  'completed without a receipt': [
    'PREV-RUN',
    J({ status: 'Completada', progress: 100, note: 'x' }),
  ],
  'blank receipt': ['PREV-RUN', J({ ...closing, evidence_attachment_id: '   ' })],
  'unknown receipt': ['PREV-RUN', J({ ...closing, evidence_attachment_id: 'EV-2' })],
  'a receipt on progress is checked too': [
    'PREV-RUN',
    J({ ...change, evidence_attachment_id: 'EV-2' }),
  ],
  'unknown blocker': ['PREV-RUN', J({ ...change, blocked_by: 'Nadie' })],
  'missing plan': ['PREV-NADA', J(change)],
  reactivating: ['PREV-CANCEL', J(change)],
  'closing without a note': ['PREV-RUN', J({ status: 'Cancelada', progress: 0, note: '   ' })],
  'empty object': ['PREV-OPEN', '{}'],
  'not JSON': ['PREV-OPEN', '{'],
  'wrong types': [
    'PREV-OPEN',
    J({
      status: 1,
      progress: '2',
      note: 3,
      evidence_url: 4,
      evidence_attachment_id: 5,
      blocked_by: 6,
      blocked_reason: 7,
    }),
  ],
  'null optionals': [
    'PREV-OPEN',
    J({ ...change, note: null, evidence_url: null, blocked_by: null, blocked_reason: null }),
  ],
  'fractional progress': ['PREV-OPEN', J({ status: 'Pendiente', progress: 1.5 })],
  'negative progress': ['PREV-OPEN', J({ status: 'En ejecución', progress: -1 })],
  'progress over 100': ['PREV-OPEN', J({ status: 'En ejecución', progress: 101 })],
  'huge progress': ['PREV-OPEN', '{"status":"En ejecución","progress":1e20}'],
  'huge negative progress': ['PREV-OPEN', '{"status":"En ejecución","progress":-1e20}'],
  'infinite progress': ['PREV-OPEN', '{"status":"En ejecución","progress":1e400}'],
  'long strings': [
    'PREV-OPEN',
    J({
      ...change,
      note: 'x'.repeat(2001),
      evidence_url: 'x'.repeat(2001),
      evidence_attachment_id: 'x'.repeat(121),
      blocked_by: 'x'.repeat(41),
      blocked_reason: 'x'.repeat(501),
    }),
  ],
};

const scenarios = [];
const run = async (name, method, path, body) => {
  const log = [];
  const service = createPreventionService({
    store: memoryStore(log),
    alerts: {
      status: async (_scope, id) => (id.length > 80 ? null : (ALERTS[id] ?? null)),
    },
    evidence: { find: async (_scope, id) => RECEIPTS[id] ?? null },
    clock: { now: () => new Date(AT) },
    randomHex: countingHex(),
  });
  const routes = preventionRoutes(service);
  const app = new routes.constructor();
  app.use('*', async (c, next) => {
    c.set('scope', scope);
    c.set('identity', { username: 'sint.usuario' });
    await next();
  });
  app.route('/', routes);
  app.onError((_error, c) => c.json({ detail: 'Internal Server Error' }, 500));
  const response = await app.request(path, {
    method,
    body,
    headers: { 'content-type': 'application/json' },
  });
  scenarios.push({
    name,
    method,
    path,
    body,
    status: response.status,
    response: await response.text(),
    log,
  });
};

for (const [name, body] of Object.entries(creates))
  await run(`create: ${name}`, 'POST', POST, body);
for (const [name, [id, body]] of Object.entries(updates))
  await run(`update: ${name}`, 'PATCH', `${POST}/${encodeURIComponent(id)}`, body);

// Formatted as `pnpm lint` (prettier --check) expects.
const text = await format(JSON.stringify({ at: AT, created: CREATED, scenarios }), {
  ...(await resolveConfig(OUT)),
  filepath: OUT,
});
if (process.argv.includes('--check')) {
  if (readFileSync(OUT, 'utf8') !== text) {
    console.error('writes.json drifted: rerun without --check');
    process.exit(1);
  }
} else writeFileSync(OUT, text);
