import type { ParityCase } from '../types.ts';

const SHA = 'a'.repeat(64);

/**
 * Synthetic rows of the management context in DEFAULT_TENANT and OTHER_TENANT (see
 * ../fixtures.ts): alerts, preventive actions and `Compromisos` records with fixed timestamps
 * (fractional seconds pin the `iso` truncation) and due dates far in the past or future, so the
 * Lima "today" never changes the answer. OTHER_TENANT's rows carry "AJENA", and an alert and
 * action of another project id inside DEFAULT_TENANT must not be counted either. One restricted
 * commitment separates the administrator's view from the read-only account's.
 */
export const seed = `
INSERT INTO digital_alert_reviews (tenant_id, id, project_id, created_at, source_url, source_type,
  excerpt, sha256, level, score, method, themes, signals, suggestions, semantic_active, status,
  analyst_note, reviewed_at) VALUES
  ('SIPGES/PRJ-SECHURA', 'MGMT-AL-1', 'PRJ-SECHURA', '2026-01-05 10:00:00.123+00', 'https://example.org/mgmt/1', 'web',
   'Señal sintética', '${SHA}', 'Alta', 80, 'sintético', '[]', '[]', '[]', false, 'Pendiente de verificación', '', NULL),
  ('SIPGES/PRJ-SECHURA', 'MGMT-AL-2', 'PRJ-SECHURA', '2026-01-06 10:00:00+00', 'https://example.org/mgmt/2', 'rss',
   'Señal sintética', '${SHA}', 'Media', 45, 'sintético', '[]', '[]', '[]', false, 'Corroborado', '', '2026-01-07 08:30:00.5-05'),
  ('SIPGES/PRJ-SECHURA', 'MGMT-AL-X', 'OTRO-PRJ', '2026-01-08 10:00:00+00', 'https://example.org/mgmt/x', 'web',
   'Fila AJENA', '${SHA}', 'Alta', 99, 'sintético', '[]', '[]', '[]', false, 'Pendiente de verificación', '', NULL),
  ('PARITY/OTRO', 'MGMT-AL-AJENA', 'OTRO', '2026-01-09 10:00:00+00', 'https://example.org/mgmt/ajena', 'web',
   'Fila AJENA', '${SHA}', 'Alta', 99, 'sintético', '[]', '[]', '[]', false, 'Pendiente de verificación', '', NULL);
INSERT INTO preventive_actions (tenant_id, id, project_id, alert_id, title, responsible, due_date,
  description, status, progress, created_at, updated_at) VALUES
  ('SIPGES/PRJ-SECHURA', 'MGMT-AC-1', 'PRJ-SECHURA', 'MGMT-AL-1', 'Mesa de diálogo', 'Equipo A', '2001-01-10', '',
   'Pendiente', 20, '2026-01-05 00:00:00+00', '2026-01-06 07:08:09.999+00'),
  ('SIPGES/PRJ-SECHURA', 'MGMT-AC-2', 'PRJ-SECHURA', 'MGMT-AL-1', '=Revisar <acuerdos> & "actas"', 'Equipo B', '2001-01-05', '',
   'En ejecución', 50, '2026-01-05 00:00:00+00', '2026-01-05 00:00:00+00'),
  ('SIPGES/PRJ-SECHURA', 'MGMT-AC-3', 'PRJ-SECHURA', 'MGMT-AL-2', 'Informe', 'Equipo A', '2999-12-31', '',
   'Completada', 100, '2026-01-05 00:00:00+00', '2026-01-05 00:00:00+00'),
  ('SIPGES/PRJ-SECHURA', 'MGMT-AC-4', 'PRJ-SECHURA', 'MGMT-AL-2', 'Seguimiento', 'Equipo C', '2999-01-01', '',
   'Cancelada', 0, '2026-01-05 00:00:00+00', '2026-01-05 00:00:00+00'),
  ('SIPGES/PRJ-SECHURA', 'MGMT-AC-X', 'OTRO-PRJ', 'MGMT-AL-X', 'Fila AJENA', 'Equipo AJENO', '2001-01-01', '',
   'Pendiente', 0, '2026-01-05 00:00:00+00', '2026-01-05 00:00:00+00'),
  ('PARITY/OTRO', 'MGMT-AC-AJENA', 'OTRO', 'MGMT-AL-AJENA', 'Fila AJENA', 'Equipo AJENO', '2001-01-01', '',
   'Pendiente', 0, '2026-01-05 00:00:00+00', '2026-01-05 00:00:00+00');
INSERT INTO module_records (tenant_id, module, id, payload, created_at, updated_at, marking) VALUES
  ('SIPGES/PRJ-SECHURA', 'Compromisos', 'MGMT-C-1', '{"Responsable": "Comité", "Estado": "Vencido", "Plazo": "2001-02-01"}',
   '2026-01-10 00:00:00+00', '2026-01-10 00:00:00+00', 'interno'),
  ('SIPGES/PRJ-SECHURA', 'Compromisos', 'MGMT-C-2', '{"Responsable": 7.5, "Estado": "Pendiente", "Fecha_Limite": "2999-01-01"}',
   '2026-01-09 00:00:00+00', '2026-01-09 00:00:00+00', 'interno'),
  ('SIPGES/PRJ-SECHURA', 'Compromisos', 'MGMT-C-3', '{"Responsable": {"b": 1, "a": [true], "10": null}, "Estado": "", "Plazo": "Próxima reunión"}',
   '2026-01-09 00:00:00+00', '2026-01-09 00:00:00+00', 'interno'),
  ('SIPGES/PRJ-SECHURA', 'Compromisos', 'MGMT-C-R', '{"Responsable": "Reservado", "Estado": "VENCIDA"}',
   '2026-01-11 00:00:00+00', '2026-01-11 00:00:00+00', 'restringido'),
  ('PARITY/OTRO', 'Compromisos', 'MGMT-C-AJENA', '{"Responsable": "AJENO", "Estado": "Vencido"}',
   '2026-01-10 00:00:00+00', '2026-01-10 00:00:00+00', 'interno');
`;

const OVERVIEW = '/system/management/overview';
const CSV = '/system/management/report.csv';

/**
 * The CSV holds `generated_at` (the wall clock to the second) and the runner has no shared
 * clock, so its 200 body cannot be diffed deterministically: the Go integration tests pin those
 * bytes with a fixed clock, and here the CSV route is compared on its gates only.
 */
export const cases: readonly ParityCase[] = [
  {
    name: 'management: overview of the active project',
    method: 'GET',
    path: OVERVIEW,
    auth: 'admin',
    normalize: ['generated_at'],
  },
  {
    name: 'management: overview as the read-only role (no restricted commitment)',
    method: 'GET',
    path: OVERVIEW,
    auth: 'consulta',
    normalize: ['generated_at'],
  },
  { name: 'management: overview without a session', method: 'GET', path: OVERVIEW },
  { name: 'management: CSV report without a session', method: 'GET', path: CSV },
  {
    name: 'management: overview of an ungranted project',
    method: 'GET',
    path: OVERVIEW,
    auth: 'admin',
    headers: { 'x-sipges-scope': 'PARITY/OTRO' },
  },
  {
    name: 'management: CSV report of an ungranted project',
    method: 'GET',
    path: CSV,
    auth: 'admin',
    headers: { 'x-sipges-scope': 'PARITY/OTRO' },
  },
  {
    name: 'management: project_id of another project',
    method: 'GET',
    path: `${OVERVIEW}?project_id=OTRO`,
    auth: 'consulta',
  },
];
