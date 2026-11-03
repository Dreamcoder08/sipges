import type { ParityCase } from '../types.ts';

/**
 * Indicators & IRSA, read-only (T23). The default project gets module records (one marked
 * 'restringido', which the read-only role must not count, one whose payload carries its own
 * `_id`, one of a module the indicators never read), a stored IRSA configuration with its bands
 * in a non-default order, a current phase with saved weights, and three snapshots. The second
 * project has none of them, so it answers with the defaults. OTHER_TENANT (see ../fixtures.ts)
 * holds rows of every kind marked "AJENA", under the same record ids, so only row-level
 * security keeps them out.
 */
export const seed = `
INSERT INTO module_records (tenant_id, module, id, payload, created_at, updated_at, marking) VALUES
  ('SIPGES/PRJ-SECHURA', 'Eventos', 'IND-EV-1',
   '{"Dimension_Principal": "Gobernanza", "Dimension_Secundaria": "Institucional",
     "Relevancia_Preliminar": "Alta", "Tipo_Evento": "Reunión comunal",
     "Descripcion_Hecho": "Conflicto por la representación ante la resolución registral",
     "_id": "id-del-payload"}', '2026-01-03 00:00:00+00', '2026-01-03 00:00:00+00', 'interno'),
  ('SIPGES/PRJ-SECHURA', 'Eventos', 'IND-EV-2',
   '{"Dimension_Principal": "Ambiental", "Relevancia_Preliminar": "Crítica",
     "Descripcion_Hecho": "Disputa por el uso del agua"}',
   '2026-01-04 00:00:00+00', '2026-01-04 00:00:00+00', 'restringido'),
  ('SIPGES/PRJ-SECHURA', 'Actores', 'IND-AC-1',
   '{"Tipo_Actor": "Comunal", "Rol/Relacion": "Representante",
     "Legitimidad/Representacion": "Fragmentada, pendiente de validar"}',
   '2026-01-03 00:00:00+00', '2026-01-03 00:00:00+00', 'interno'),
  ('SIPGES/PRJ-SECHURA', 'Alertas', 'IND-AL-1',
   '{"Dimension": "G", "Estado": "Abierta", "Nivel": "Alto"}',
   '2026-01-03 00:00:00+00', '2026-01-03 00:00:00+00', 'publico'),
  ('SIPGES/PRJ-SECHURA', 'Demandas', 'IND-DE-1',
   '{"Estado": "Pendiente", "Tema": "Empleo local", "Dimension": "Económica"}',
   '2026-01-03 00:00:00+00', '2026-01-03 00:00:00+00', 'interno'),
  ('SIPGES/PRJ-SECHURA', 'Compromisos', 'IND-CO-1',
   '{"Estado": "Vencido", "Descripcion": "Mesa técnica", "Fecha_Limite": "2025-12-01"}',
   '2026-01-03 00:00:00+00', '2026-01-03 00:00:00+00', 'interno'),
  ('SIPGES/PRJ-SECHURA', 'Narrativas', 'IND-NA-1',
   '{"Tema": "Tensión por la consulta previa", "Verificacion": "No verificada", "Alcance": 3}',
   '2026-01-03 00:00:00+00', '2026-01-03 00:00:00+00', 'interno'),
  ('SIPGES/PRJ-SECHURA', 'Otro_Modulo', 'IND-OT-1',
   '{"Estado": "Abierta", "Dimension": "G"}',
   '2026-01-03 00:00:00+00', '2026-01-03 00:00:00+00', 'interno'),
  ('PARITY/OTRO', 'Eventos', 'IND-EV-1',
   '{"Dimension_Principal": "Gobernanza", "Relevancia_Preliminar": "Crítica",
     "Descripcion_Hecho": "Conflicto AJENA"}', '2026-01-02 00:00:00+00', '2026-01-02 00:00:00+00', 'interno'),
  ('PARITY/OTRO', 'Alertas', 'AJENA-AL',
   '{"Dimension": "E", "Estado": "Abierta", "Nivel": "AJENA"}',
   '2026-01-02 00:00:00+00', '2026-01-02 00:00:00+00', 'interno');
INSERT INTO irsa_configs (tenant_id, config, updated_at) VALUES
  ('SIPGES/PRJ-SECHURA', '{"version":"0.4-indicators","weights":{"G":0.5,"A":0.1,"D":0.1,"N":0.1,"E":0.1,"I":0.1},"thresholds":{"Rojo":[60,100],"Naranja":[40,59.99],"Amarillo":[20,39.99],"Verde":[0,19.99]},"contributions":{"active_alert":10,"high_event":4},"extra":"conservado"}',
   '2026-01-03 00:00:00+00'),
  ('PARITY/OTRO', '{"version":"AJENA","weights":{"G":1},"thresholds":{"AJENA":[0,100]},"contributions":{}}',
   '2026-01-02 00:00:00+00');
INSERT INTO project_settings (tenant_id, settings, updated_by, updated_at) VALUES
  ('SIPGES/PRJ-SECHURA', '{"phase": "construccion", "phaseWeights": {"construccion": {"G": 0.3, "A": 0.1, "D": 0.2, "N": 0.1, "E": 0.2, "I": 0.1}, "cierre": {"G": 1}}}',
   'parity', '2026-01-03 00:00:00+00'),
  ('PARITY/OTRO', '{"phase": "operacion", "phaseWeights": {"operacion": {"E": 1}}}',
   'AJENA', '2026-01-02 00:00:00+00');
INSERT INTO irsa_snapshots (tenant_id, ts, irsa, level, scores, config_version, note) VALUES
  ('SIPGES/PRJ-SECHURA', '2026-01-05 10:00:00.789+00', 42.5, 'Amarillo', '{"G":40,"A":45.25}',
   '0.4-indicators', 'Corte de paridad'),
  ('PARITY/OTRO', '2026-01-06 00:00:00+00', 99.99, 'AJENA', '{"G":99.99}', 'AJENA', 'Corte AJENA'),
  ('SIPGES/PRJ-SECHURA', '2026-01-06 08:30:00+00', 61.75, 'Naranja', '{"G": 60.5, "A": 63}', NULL, NULL),
  ('SIPGES/PRJ-SECHURA', '2026-01-07 00:00:00+00', 12, 'Verde', '{}', '0.4-indicators', '');
`;

const ROUTES = [
  'irsa',
  'irsa/config',
  'irsa/history',
  'indicators',
  'model-status',
  'validation-template',
] as const;

export const cases: readonly ParityCase[] = [
  ...ROUTES.flatMap((route): ParityCase[] => {
    const path = `/system/${route}`;
    return [
      { name: `indicators ${route}`, method: 'GET', path, auth: 'admin' },
      { name: `indicators ${route} without a session`, method: 'GET', path },
      { name: `indicators ${route} read-only role`, method: 'GET', path, auth: 'consulta' },
      {
        name: `indicators ${route} of a project without a grant`,
        method: 'GET',
        path,
        auth: 'admin',
        headers: { 'x-sipges-scope': 'PARITY/PRJ-B' },
      },
      {
        name: `indicators ${route} of the ungranted fixture project`,
        method: 'GET',
        path,
        auth: 'multi',
        headers: { 'x-sipges-scope': 'PARITY/OTRO' },
      },
      {
        name: `indicators ${route} of the second project`,
        method: 'GET',
        path,
        auth: 'multi',
        headers: { 'x-sipges-scope': 'PARITY/PRJ-B' },
      },
      {
        name: `indicators ${route} of the first project by a two-project user`,
        method: 'GET',
        path,
        auth: 'multi',
        headers: { 'x-sipges-scope': 'SIPGES/PRJ-SECHURA' },
      },
    ];
  }),
  ...(['1', '-1', '', ' 2 ', '0x2', 'abc', '1.5', '1e400'] as const).map((limit): ParityCase => ({
    name: `indicators irsa/history with limit ${JSON.stringify(limit)}`,
    method: 'GET',
    path: `/system/irsa/history?limit=${encodeURIComponent(limit)}`,
    auth: 'admin',
  })),
  {
    name: 'indicators irsa/history with limit before the session check',
    method: 'GET',
    path: '/system/irsa/history?limit=abc',
  },
  {
    name: 'indicators irsa with a trailing slash',
    method: 'GET',
    path: '/system/irsa/',
    auth: 'admin',
  },
];
