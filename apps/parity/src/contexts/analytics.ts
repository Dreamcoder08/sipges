import type { ParityCase } from '../types.ts';

/**
 * Analytics, read-only JSON routes (T24): the dashboard counters and the four engines. This seed
 * adds synthetic module records to the default project (SIPGES/PRJ-SECHURA) for every module the
 * engines read, one of them marked 'restringido' so the read-only role (limited clearance) must
 * not count it, and rows in OTHER_TENANT (see ../fixtures.ts) that name the default project's id,
 * so only row-level security keeps them out. Those rows carry "AJENA" so a leak is plain in a
 * mismatch report. `generated_at` is the clock of each API, so it is the only normalized field.
 */
type Row = readonly [
  module: string,
  id: string,
  payload: Record<string, unknown>,
  marking?: string,
];

const DEFAULT_ROWS: readonly Row[] = [
  ['Eventos', 'PAR-EV-1', { Territorio: 'Caleta sintética norte', Tipo: 'Reunión' }],
  ['Eventos', 'PAR-EV-2', { Territorio: 'Caleta sintética norte' }],
  ['Eventos', 'PAR-EV-3', { Territorio: 'Zona sintética reservada' }, 'restringido'],
  ['Actores', 'PAR-AC-1', { Nombre: 'Asociación sintética de pescadores' }],
  ['Demandas', 'PAR-DE-1', { Tema: 'Agua', Estado: 'Abierta' }],
  ['Demandas', 'PAR-DE-2', { Tema: 'Empleo', Estado: ' CERRADA ' }],
  ['Alertas', 'PAR-AL-1', { Nivel_Preliminar: 'Alto', Estado: 'Activa' }],
  ['Alertas', 'PAR-AL-2', { Nivel: 'Medio', Estado: 'Descartada' }],
  ['Alertas', 'PAR-AL-3', { Nivel_Preliminar: '', Nivel: 2, Estado: 'Activa' }],
  ['Alertas', 'PAR-AL-4', { Estado: 'Activa' }],
  ['Directorio_Territorial', 'PAR-DT-1', { Nombre: 'Contacto sintético' }],
  ['Actores_Priorizados', 'PAR-AP-1', { Actor: 'Asociación sintética de pescadores' }],
  [
    'Intereses',
    'PAR-IN-1',
    {
      Actor: 'Asociación sintética de pescadores',
      Interes: 'Pesca artesanal',
      Preocupacion: 'contaminación marina',
      Estado: 'Validado',
    },
  ],
  ['Intereses', 'PAR-IN-2', { Actor: 'Junta sintética', Interes: 'Agua para pesca' }],
  ['Dialogos', 'PAR-DI-1', { Tema: 'Agua para pesca', Estado: 'Abierto', Responsable: 'Equipo' }],
  [
    'Oportunidades',
    'PAR-OP-1',
    { Oportunidad: 'Contaminacion', Beneficiarios: 'PESCA', Viabilidad: 'Alta' },
  ],
  [
    'Hechos_Compartidos',
    'PAR-HE-1',
    { ID_Proceso: 'P1', Asunto: 'agua', Estado: 'Validado', Fuente_ID: 'F-1' },
  ],
  [
    'Evaluaciones_AARC',
    'PAR-AA-1',
    { Actor: 'Junta sintética', Mandato: 'Asamblea', Estado: 'Pendiente' },
  ],
];

const OTHER_ROWS: readonly Row[] = [
  ['Proyectos', 'AJENA-AN-PR', { Proyecto_ID: 'PRJ-SECHURA', Nombre: 'Proyecto AJENA' }],
  ['Eventos', 'AJENA-AN-EV', { Territorio: 'Territorio AJENA' }],
  ['Demandas', 'AJENA-AN-DE', { Tema: 'Tema AJENA', Estado: 'Abierta' }],
  ['Alertas', 'AJENA-AN-AL', { Nivel_Preliminar: 'AJENA', Estado: 'Activa' }],
  ['Intereses', 'AJENA-AN-IN', { Actor: 'Actor AJENA', Interes: 'Pesca artesanal AJENA' }],
  ['Dialogos', 'AJENA-AN-DI', { Tema: 'Diálogo AJENA', Estado: 'Abierto' }],
];

const quote = (value: string) => `'${value.replaceAll("'", "''")}'`;

const insert = (tenant: string, rows: readonly Row[]) =>
  rows
    .map(([module, id, payload, marking = 'interno'], i) => {
      // Distinct times so "newest first" is one order on both APIs.
      const at = `2026-09-${String(i + 1).padStart(2, '0')} 12:00:00+00`;
      return `(${[tenant, module, id, JSON.stringify(payload), at, at, marking].map(quote).join(', ')})`;
    })
    .join(',\n  ');

export const seed = `
INSERT INTO module_records (tenant_id, module, id, payload, created_at, updated_at, marking) VALUES
  ${insert('SIPGES/PRJ-SECHURA', DEFAULT_ROWS)},
  ${insert('PARITY/OTRO', OTHER_ROWS)};
`;

const ROUTES: readonly (readonly [name: string, path: string, normalize?: readonly string[]])[] = [
  ['dashboard', '/api/dashboard'],
  ['situational analysis', '/system/situational-analysis', ['generated_at']],
  ['strategic assessment', '/system/strategic-assessment', ['generated_at']],
  ['consensus engine', '/system/consensus-engine', ['generated_at']],
  ['integrated analysis', '/system/integrated-analysis', ['generated_at']],
];

const jsonCases = ROUTES.flatMap(([route, path, normalize]): ParityCase[] => {
  const success = normalize ? { normalize } : {};
  return [
    { name: `analytics ${route}`, method: 'GET', path, auth: 'admin', ...success },
    { name: `analytics ${route} without a session`, method: 'GET', path },
    {
      name: `analytics ${route} read-only role`,
      method: 'GET',
      path,
      auth: 'consulta',
      ...success,
    },
    {
      name: `analytics ${route} of a project without a grant`,
      method: 'GET',
      path,
      auth: 'admin',
      headers: { 'x-sipges-scope': 'PARITY/PRJ-B' },
    },
    {
      name: `analytics ${route} of the ungranted fixture project`,
      method: 'GET',
      path,
      auth: 'multi',
      headers: { 'x-sipges-scope': 'PARITY/OTRO' },
    },
    {
      name: `analytics ${route} with project_id of another project`,
      method: 'GET',
      path: `${path}?project_id=PRJ-B`,
      auth: 'admin',
    },
  ];
});

/** The Word reports: the parity runner compares their word/document.xml (../docx.ts). */
const REPORTS: readonly (readonly [name: string, path: string])[] = [
  ['situational report', '/system/situational-report.docx'],
  ['strategic report', '/system/strategic-report.docx'],
  ['integrated report', '/system/integrated-analysis.docx'],
  ['consensus report', '/system/consensus-engine.docx'],
];

const reportCases = REPORTS.flatMap(([route, path]): ParityCase[] => [
  { name: `analytics ${route}`, method: 'GET', path, auth: 'admin', absent: ['AJENA'] },
  { name: `analytics ${route} without a session`, method: 'GET', path },
  {
    name: `analytics ${route} read-only role`,
    method: 'GET',
    path,
    auth: 'consulta',
    absent: ['AJENA', 'reservada'],
  },
  {
    name: `analytics ${route} of a project without a grant`,
    method: 'GET',
    path,
    auth: 'admin',
    headers: { 'x-sipges-scope': 'PARITY/PRJ-B' },
  },
  {
    name: `analytics ${route} of the ungranted fixture project`,
    method: 'GET',
    path,
    auth: 'multi',
    headers: { 'x-sipges-scope': 'PARITY/OTRO' },
  },
  {
    name: `analytics ${route} with project_id of another project`,
    method: 'GET',
    path: `${path}?project_id=PRJ-B`,
    auth: 'admin',
  },
  { name: `analytics ${route} HEAD`, method: 'HEAD', path, auth: 'admin' },
  {
    name: `analytics ${route} with a trailing slash`,
    method: 'GET',
    path: `${path}/`,
    auth: 'admin',
  },
]);

export const cases: readonly ParityCase[] = [...jsonCases, ...reportCases];
