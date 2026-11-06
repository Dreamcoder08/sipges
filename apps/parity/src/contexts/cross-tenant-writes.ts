import type { ParityCase } from '../types.ts';

/**
 * Writes that name another project's row (T54). Every body is valid, so each case passes
 * validation and reaches the store's tenant check: the isolation audit's probes stopped at 422
 * before it. `present` pins the 404 on both APIs, and `absent` that nothing of the row comes back.
 * The ids exist only in OTHER_TENANT (see ../fixtures.ts).
 */
const OTHER = 'PARITY/OTRO'; // not imported: ../fixtures.ts reads these seeds
const LINK = 970_001;
const ALERT = 'PARITY-XT-ALERTA';
const SECRET = 'XT-AJENO-SINTETICO';
const route = 'cross-tenant write';

export const seed = `
INSERT INTO module_records (tenant_id, module, id, payload, marking, created_at, updated_at) VALUES
  ('${OTHER}', 'Actores', 'PARITY-XT-1', '{"nota":"${SECRET}"}', 'interno', '2026-01-02 00:00:00+00', '2026-01-02 00:00:00+00'),
  ('${OTHER}', 'Actores', 'PARITY-XT-2', '{}', 'interno', '2026-01-02 00:00:00+00', '2026-01-02 00:00:00+00'),
  ('${OTHER}', 'Fuentes', 'PARITY-XT-F', '{}', 'interno', '2026-01-02 00:00:00+00', '2026-01-02 00:00:00+00');
INSERT INTO record_links (id, tenant_id, link_type, source_module, source_id, target_module, target_id, note,
  created_by, created_at, evidence_source_id) OVERRIDING SYSTEM VALUE VALUES
  (${LINK}, '${OTHER}', 'aliado_de', 'Actores', 'PARITY-XT-1', 'Actores', 'PARITY-XT-2', '${SECRET}', 'autor',
   '2026-01-02 00:00:00+00', 'PARITY-XT-F');
INSERT INTO digital_alert_reviews (tenant_id, id, project_id, created_at, source_url, source_type,
  excerpt, sha256, level, score, method, themes, signals, suggestions, semantic_active, status,
  analyst_note) VALUES
  ('${OTHER}', '${ALERT}', 'OTRO', '2026-01-02 00:00:00+00', '', 'Documento', '${SECRET}',
   repeat('a', 64), 'Baja', 1, 'rules', '[]', '[]', '[]', false, 'En seguimiento', '');
`;

const write = (
  name: string,
  method: 'PUT' | 'PATCH' | 'POST',
  path: string,
  json: unknown,
  detail: string,
): ParityCase => ({
  name: `${route}: ${name}`,
  method,
  path,
  auth: 'admin',
  sameOrigin: true,
  body: { json },
  present: [detail],
  absent: [SECRET],
});

export const cases: readonly ParityCase[] = [
  write(
    "another project's link evidence",
    'PUT',
    `/system/links/${LINK}/evidence`,
    { evidence: null },
    'Registro no encontrado',
  ),
  write(
    "PATCH of another project's alert",
    'PATCH',
    `/system/intelligence/territorial-alerts/${ALERT}`,
    { status: 'Descartado' },
    'Evaluación no encontrada',
  ),
  write(
    "an action on another project's alert",
    'POST',
    '/system/prevention/actions',
    { alert_id: ALERT, title: 'Plan nuevo', responsible: 'Equipo', due_date: '2027-02-28' },
    'Alerta no pertenece al proyecto indicado',
  ),
];
