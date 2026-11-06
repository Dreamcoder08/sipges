import { createHash } from 'node:crypto';
import type { ParityCase } from '../types.ts';
import { NOT_IMPORTABLE, RECORD_MODULES } from '../write-routes.ts';

/**
 * Successful writes for write-proof.ts: every record module, and the routes the other contexts
 * test mainly through their refusals. Each API gets a row of its own, seeded here, since both
 * receive a case at once on one database.
 */
const SCOPE = 'SIPGES/PRJ-SECHURA';
const AT = '2026-10-01T08:00:00Z';
const sides = (name: string) => ({ ts: `${name}-TS`, go: `${name}-GO` });
const ids = (ts: number, go: number) => ({ ts: String(ts), go: String(go) });

const RULE_PUT = ids(910001, 910002);
const RULE_DELETE = ids(910003, 910004);
const CHANNEL_DELETE = ids(910005, 910006);
const NOTIFICATION = ids(910007, 910008);
const LOGOUT = sides('parity-logout-token');

const recordRows = RECORD_MODULES.flatMap(({ module }) =>
  ['PUT', 'DEL'].flatMap((kind) =>
    Object.values(sides(`WP-${kind}`)).map(
      (id) =>
        `('${SCOPE}', '${module}', '${id}', '{"Notas":"Sintético"}', 'interno', '${AT}', '${AT}')`,
    ),
  ),
);

const ruleRow = (id: string, name: string) =>
  `(${id}, '${SCOPE}', '${name}', true, 'Alertas', '{CREATE}', '[]',
    '[{"kind":"notify","title":"Paridad"}]', 'parity', '${AT}', '${AT}')`;

const sessionRow = (token: string) =>
  `('${createHash('sha256').update(token).digest('hex')}', 'parity-logout', '2099-01-01T00:00:00Z')`;

export const seed = `
INSERT INTO module_records (tenant_id, module, id, payload, marking, created_at, updated_at)
VALUES ${recordRows.join(',\n')};
INSERT INTO automation_rules (id, tenant_id, name, enabled, trigger_module, trigger_actions,
  conditions, actions, created_by, created_at, updated_at) OVERRIDING SYSTEM VALUE
VALUES ${[
  ruleRow(RULE_PUT.ts, 'Prueba escritura A'),
  ruleRow(RULE_PUT.go, 'Prueba escritura B'),
  ruleRow(RULE_DELETE.ts, 'Prueba escritura C'),
  ruleRow(RULE_DELETE.go, 'Prueba escritura D'),
].join(',\n')};
INSERT INTO integration_channels (id, tenant_id, kind, name, target_hint, sealed_config,
  created_by, created_at) OVERRIDING SYSTEM VALUE
VALUES (${CHANNEL_DELETE.ts}, '${SCOPE}', 'slack', 'Prueba borrado A', 'hooks.slack.com', 'sellado-sintetico', 'parity', '${AT}'),
       (${CHANNEL_DELETE.go}, '${SCOPE}', 'slack', 'Prueba borrado B', 'hooks.slack.com', 'sellado-sintetico', 'parity', '${AT}');
INSERT INTO notifications (id, tenant_id, title, created_at) OVERRIDING SYSTEM VALUE
VALUES (${NOTIFICATION.ts}, '${SCOPE}', 'Prueba lectura A', '${AT}'),
       (${NOTIFICATION.go}, '${SCOPE}', 'Prueba lectura B', '${AT}');
INSERT INTO users (username, full_name, password_hash, role)
VALUES ('parity-logout', 'Cierre sintético', 'sin-acceso', 'consulta');
INSERT INTO sessions (token_hash, username, expires_at)
VALUES ${sessionRow(LOGOUT.ts)}, ${sessionRow(LOGOUT.go)};`;

const BOUNDARY = 'writeproofboundary';
const ACTA =
  'Acta de reunión.\nLa comunidad presentó una demanda de empleo local en la asamblea.\n' +
  'El comité acordó una mesa de diálogo con la empresa.';
const REPORT_BODY = [
  `--${BOUNDARY}`,
  'Content-Disposition: form-data; name="file"; filename="acta.txt"',
  'Content-Type: application/octet-stream',
  '',
  ACTA,
  `--${BOUNDARY}--`,
  '',
].join('\r\n');

const write = (
  name: string,
  method: ParityCase['method'],
  path: string,
  extra: Partial<ParityCase> = {},
): ParityCase => ({
  name: `write proof: ${name}`,
  method,
  path,
  auth: 'admin',
  sameOrigin: true,
  ...extra,
});

const recordCases = RECORD_MODULES.flatMap(({ slug }): ParityCase[] => [
  write(`create in ${slug}`, 'POST', `/api/${slug}`, {
    body: { json: { payload: { Notas: 'Sintético {api}' } } },
    normalize: ['id'],
    perApi: true,
  }),
  write(`update in ${slug}`, 'PUT', `/api/${slug}/{id}`, {
    vary: { id: sides('WP-PUT') },
    body: { json: { payload: { Notas: 'Sintético cambiado' } } },
  }),
  write(`delete in ${slug}`, 'DELETE', `/api/${slug}/{id}`, { vary: { id: sides('WP-DEL') } }),
  ...(NOT_IMPORTABLE.includes(slug)
    ? []
    : [
        write(`import into ${slug}`, 'POST', `/system/import/${slug}`, {
          perApi: true,
          oneAtATime: true,
          body: { json: { rows: [{ Notas: 'Importado {api}' }], dry_run: false } },
        }),
      ]),
]);

const channel = {
  kind: 'slack',
  name: 'Canal escrito {api}',
  settings: { url: 'https://hooks.slack.com/services/T000/B000/sintetico' },
};

export const cases: readonly ParityCase[] = [
  ...recordCases,
  write('update a rule', 'PUT', '/system/automations/rules/{id}', {
    vary: { id: RULE_PUT },
    body: {
      json: {
        name: 'Prueba escrita {id}',
        enabled: false,
        module: 'Alertas',
        actions: ['UPDATE'],
        conditions: [],
        steps: [{ kind: 'notify', title: 'Paridad' }],
      },
    },
    normalize: ['id', 'name', 'updated_at'],
  }),
  write('delete a rule', 'DELETE', '/system/automations/rules/{id}', { vary: { id: RULE_DELETE } }),
  write('create a channel', 'POST', '/system/automations/channels', {
    perApi: true,
    body: { json: channel },
    normalize: ['id', 'created_at'],
  }),
  write('delete a channel', 'DELETE', '/system/automations/channels/{id}', {
    vary: { id: CHANNEL_DELETE },
  }),
  write('mark a notification read', 'POST', '/system/notifications/read', {
    vary: { id: NOTIFICATION },
    body: { raw: '{"ids":[{id}]}' },
  }),
  {
    name: 'write proof: end a session',
    method: 'POST',
    path: '/logout',
    sameOrigin: true,
    vary: { token: LOGOUT },
    headers: { cookie: 'sipges_session={token}' },
  },
  write('update a media feed', 'PUT', '/system/v4/media/feeds/{feed}', {
    vary: { feed: { ts: '32111', go: '32112' }, w: { ts: 'ts', go: 'go' } },
    body: {
      json: {
        name: 'Diario escrito {w}',
        url: 'https://escrito-{w}.example/rss',
        authorization_note: 'Nota',
        enabled: false,
      },
    },
    normalize: ['id', 'name', 'url', 'updated_at', 'updated_by'],
  }),
  write('render a report', 'POST', '/system/document-lab/report.docx', {
    headers: { 'content-type': `multipart/form-data; boundary=${BOUNDARY}` },
    body: { raw: REPORT_BODY },
    // The file carries its own timestamps: the status and type are the promise here.
    compareLines: '^$',
  }),
  write('poll the media feeds', 'POST', '/system/v4/media/poll', {
    oneAtATime: true,
    normalize: ['report'],
  }),
];
