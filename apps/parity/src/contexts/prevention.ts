import type { ParityCase } from '../types.ts';

/**
 * Prevention, read-only (T19). seed.ts creates verified alerts and plans in the default and the
 * second project through the TypeScript API; this seed adds, in OTHER_TENANT (see
 * ../fixtures.ts), a plan with the default project's project id, so only row-level security keeps
 * it out. Its rows carry "AJENA" so a leak is plain in a mismatch report.
 */
export const seed = `
INSERT INTO digital_alert_reviews (tenant_id, id, project_id, created_at, source_url, source_type,
  excerpt, sha256, level, score, method, themes, signals, suggestions, semantic_active, status,
  analyst_note) VALUES
  ('PARITY/OTRO', 'AJENA-ALERT', 'PRJ-SECHURA', '2026-01-02 00:00:00+00', '', 'Documento', 'Fila AJENA',
   repeat('a', 64), 'Baja', 1, 'rules', '[]', '[]', '[]', false, 'En seguimiento', '');
INSERT INTO preventive_actions (tenant_id, id, project_id, alert_id, title, responsible, due_date,
  description, status, progress, created_at, updated_at, blocked_by, blocked_reason, blocked_since) VALUES
  ('PARITY/OTRO', 'AJENA-PLAN', 'PRJ-SECHURA', 'AJENA-ALERT', 'Plan AJENA', 'AJENA', '2020-01-01', '',
   'En ejecución', 50, '2026-01-02 00:00:00+00', '2026-01-02 00:00:00+00', 'Otro', 'AJENA',
   '2026-01-02 00:00:00+00');
INSERT INTO preventive_action_log (tenant_id, id, action_id, created_at, status, progress, note) VALUES
  ('PARITY/OTRO', 'AJENA-LOG', 'AJENA-PLAN', '2026-01-02 00:00:00+00', 'Pendiente', 0, 'Fila AJENA');
`;

export const cases: readonly ParityCase[] = [
  ...(['actions', 'situation-room', 'summary'] as const).flatMap((route): ParityCase[] => {
    const path = `/system/prevention/${route}`;
    return [
      { name: `prevention ${route}`, method: 'GET', path, auth: 'admin' },
      { name: `prevention ${route} without a session`, method: 'GET', path },
      { name: `prevention ${route} read-only role`, method: 'GET', path, auth: 'consulta' },
      {
        name: `prevention ${route} of a project without a grant`,
        method: 'GET',
        path,
        auth: 'admin',
        headers: { 'x-sipges-scope': 'PARITY/PRJ-B' },
      },
      {
        name: `prevention ${route} of the ungranted fixture project`,
        method: 'GET',
        path,
        auth: 'multi',
        headers: { 'x-sipges-scope': 'PARITY/OTRO' },
      },
      {
        name: `prevention ${route} with project_id of another project`,
        method: 'GET',
        path: `${path}?project_id=PRJ-B`,
        auth: 'admin',
      },
      {
        name: `prevention ${route} with project_id of its project`,
        method: 'GET',
        path: `${path}?project_id=PRJ-SECHURA`,
        auth: 'admin',
      },
      { name: `prevention ${route} before choosing a project`, method: 'GET', path, auth: 'multi' },
      {
        name: `prevention ${route} of the second project`,
        method: 'GET',
        path,
        auth: 'multi',
        headers: { 'x-sipges-scope': 'PARITY/PRJ-B' },
      },
      {
        name: `prevention ${route} of the first project by a two-project user`,
        method: 'GET',
        path,
        auth: 'multi',
        headers: { 'x-sipges-scope': 'SIPGES/PRJ-SECHURA' },
      },
    ];
  }),
  {
    name: 'prevention actions with a trailing slash',
    method: 'GET',
    path: '/system/prevention/actions/',
    auth: 'admin',
  },
  {
    name: 'prevention plan write by the read-only role',
    method: 'POST',
    path: '/system/prevention/actions',
    auth: 'consulta',
    sameOrigin: true,
    body: { json: { alert_id: 'x', title: 'Plan', responsible: 'Equipo', due_date: '2099-01-01' } },
  },
];
