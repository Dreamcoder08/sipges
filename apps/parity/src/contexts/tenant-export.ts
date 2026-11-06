import type { ParityCase } from '../types.ts';

/**
 * GET /system/export (T54). The file name keeps these cases late in the run, so the export also
 * holds the rows every earlier case wrote. Bigints come back as text and jsonb through JSON.parse:
 * postgres.js's reading, which the Go reader follows.
 * `absent` and `present` make the isolation an assertion: two APIs agreeing is not enough.
 */
const OWN = 'SIPGES/PRJ-SECHURA';
const OTHER = 'PARITY/OTRO'; // not imported: ../fixtures.ts reads these seeds
const OWN_MARK = 'EXPORT-PROPIO-SINTETICO';
const OTHER_MARK = 'EXPORT-AJENO-SINTETICO';
const route = 'tenant export';
const PATH = '/system/export';

const rows = (tenant: string, mark: string, tag: string) => `
INSERT INTO module_records (tenant_id, module, id, payload, created_at, updated_at, marking) VALUES
  ('${tenant}', 'Eventos', 'PARITY-EXPORT-${tag}-1',
   '{"b":1.50,"10":"${mark}","2":"<dos> & \\u2028","a":{"z":1e300,"y":[1,2.0,null,true]},"k":-0.0,"big":9007199254740993}',
   '2026-03-04 05:06:07.123456+00', '2026-03-04 05:06:07+00', 'restringido'),
  ('${tenant}', 'Eventos', 'PARITY-EXPORT-${tag}-2', '{}', '2026-03-04 05:06:07.999999+00', '2026-03-04 05:06:07+00', 'interno');
INSERT INTO audit (tenant_id, ts, module, record_id, action, detail, event_payload) VALUES
  ('${tenant}', '2026-03-04 05:06:07.5+00', 'Eventos', 'PARITY-EXPORT-${tag}-1', 'CREATE', '${mark}', '{"a":[{"b":null}]}');
INSERT INTO attachments (tenant_id, id, storage_key, original_name, content_type, size_bytes, sha256, linked_module,
    record_module, linked_record_id, document_type, author, verification, notes, project_id, project_name, created_at) VALUES
  ('${tenant}', 'PARITY-EXPORT-${tag}', 'clave-${tag}', '${mark}.pdf', 'application/pdf', 9007199254740993, 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'Eventos',
   'Eventos', 'PARITY-EXPORT-${tag}-1', 'informe', 'autor', 'verificado', '', 'proyecto', 'nombre', '2026-03-04 05:06:07+00');
INSERT INTO record_versions (tenant_id, module, record_id, operation, payload, actor, at, marking) VALUES
  ('${tenant}', 'Eventos', 'PARITY-EXPORT-${tag}-1', 'CREATE', '{"nota":"${mark}"}', 'autor', '2026-03-04 05:06:07+00', 'interno');
INSERT INTO record_links (tenant_id, link_type, source_module, source_id, target_module, target_id, note, created_by, created_at) VALUES
  ('${tenant}', 'relacionado', 'Eventos', 'PARITY-EXPORT-${tag}-1', 'Eventos', 'PARITY-EXPORT-${tag}-2', '${mark}', 'autor',
   '2026-03-04 05:06:07+00');
INSERT INTO automation_rules (tenant_id, name, enabled, trigger_module, trigger_actions, conditions, actions, created_by,
    created_at, updated_at) VALUES
  ('${tenant}', '${mark}', false, '*', '{CREATE,"UP DATE"}', '[]', '[]', 'autor', '2026-03-04 05:06:07+00',
   '2026-03-04 05:06:07.5+00');
INSERT INTO notifications (tenant_id, title, created_at) VALUES ('${tenant}', '${mark}', '2026-03-04 05:06:07+00');
`;

export const seed = `${rows(OWN, OWN_MARK, 'P')}${rows(OTHER, OTHER_MARK, 'A')}`;

const NORMALIZE = ['exported_at'];

export const cases: readonly ParityCase[] = [
  {
    name: `${route}: only the caller's project`,
    method: 'GET',
    path: PATH,
    auth: 'admin',
    normalize: NORMALIZE,
    present: [OWN_MARK, OWN],
    absent: [OTHER_MARK, OTHER],
  },
  {
    name: `${route}: the session's project by query`,
    method: 'GET',
    path: `${PATH}?project_id=PRJ-SECHURA`,
    auth: 'admin',
    normalize: NORMALIZE,
    present: [OWN_MARK],
    absent: [OTHER_MARK, OTHER],
  },
  { name: `${route}: HEAD`, method: 'HEAD', path: PATH, auth: 'admin' },
  { name: `${route}: without a session`, method: 'GET', path: PATH },
  { name: `${route}: read-only role`, method: 'GET', path: PATH, auth: 'consulta' },
  { name: `${route}: an analyst must choose first`, method: 'GET', path: PATH, auth: 'multi' },
  {
    name: `${route}: an analyst's chosen project`,
    method: 'GET',
    path: PATH,
    auth: 'multi',
    headers: { 'x-sipges-scope': OWN },
  },
  {
    name: `${route}: another project`,
    method: 'GET',
    path: PATH,
    auth: 'admin',
    headers: { 'x-sipges-scope': OTHER },
    absent: [OTHER_MARK],
  },
  {
    name: `${route}: query project_id of another project`,
    method: 'GET',
    path: `${PATH}?project_id=OTRO`,
    auth: 'admin',
    absent: [OTHER_MARK],
  },
  { name: `${route}: trailing slash`, method: 'GET', path: `${PATH}/`, auth: 'admin' },
  {
    name: `${route}: POST is not a route`,
    method: 'POST',
    path: PATH,
    auth: 'admin',
    sameOrigin: true,
    body: { json: {} },
  },
];
