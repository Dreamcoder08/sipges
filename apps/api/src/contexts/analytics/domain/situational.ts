import { mostCommon, pyGet, pyStr, pyTruthy } from './python.ts';
import {
  type AnalysisRecord,
  DEFAULT_PROJECT_ID,
  type RecordsByModule,
  SITUATIONAL_MODULES,
  recordWithId,
} from './records.ts';

const CLOSED = new Set(['cerrada', 'cerrado', 'descartado', 'descartada', 'resuelta', 'resuelto']);
const ALERT_RANK = new Map([
  ['rojo', 0],
  ['naranja', 1],
  ['amarillo', 2],
  ['verde', 3],
]);

const isOpen = (x: AnalysisRecord) => !CLOSED.has(pyStr(pyGet(x, 'Estado')).trim().toLowerCase());

const orDefault = (value: unknown, fallback: string) => (pyTruthy(value) ? pyStr(value) : fallback);

/** app.py trim(): selected fields (default '') plus the record id, first `limit` items. */
const trim = (items: readonly AnalysisRecord[], fields: readonly string[], limit = 8) =>
  items.slice(0, limit).map((x) => ({
    ...Object.fromEntries(fields.map((k) => [k, pyGet(x, k)])),
    id: x._id,
  }));

const SCENARIOS = [
  {
    nombre: 'Favorable',
    supuesto: 'Se atienden y verifican oportunamente las demandas y alertas pendientes.',
  },
  { nombre: 'Intermedio', supuesto: 'Persisten demandas y señales sin escalamiento confirmado.' },
  {
    nombre: 'Crítico',
    supuesto: 'Convergen eventos corroborados, alertas graves y falta de respuesta oportuna.',
  },
];

const LIMITATIONS = [
  'Los registros pueden estar desactualizados, incompletos o pendientes de verificación.',
  'Los escenarios son condicionales, no pronósticos.',
  'IRSA requiere validación de pesos y umbrales; no se interpreta aquí como medición científica definitiva.',
  'El reporte requiere revisión y aprobación de un analista antes de circularse como documento institucional.',
];

/**
 * Situational analysis (app.py:627 build_situational): deterministic synthesis of the master
 * base, not a validated judgment. Every record of the tenant counts: the tenant is the project
 * (S13), so its `Proyecto_ID` field is not re-checked.
 */
export const buildSituational = (
  byModule: RecordsByModule,
  projectId: string,
  generatedAt: string,
) => {
  const groups = Object.fromEntries(
    SITUATIONAL_MODULES.map((module) => [module, (byModule[module] ?? []).map(recordWithId)]),
  ) as Record<(typeof SITUATIONAL_MODULES)[number], AnalysisRecord[]>;
  const project = (byModule['Proyectos'] ?? []).find(
    (r) => r.payload['Proyecto_ID'] === projectId,
  )?.payload;

  const { Eventos: ev, Demandas: de, Alertas: al, Narrativas: nar, Actores: ac } = groups;
  const activeAlerts = al.filter(isOpen);
  const openDemands = de.filter(isOpen);

  const observations: string[] = [];
  if (activeAlerts.length)
    observations.push(
      `Constan ${activeAlerts.length} alertas con estado no cerrado; requieren verificación de vigencia, gravedad y responsable.`,
    );
  if (openDemands.length)
    observations.push(
      `Se registran ${openDemands.length} demandas no cerradas; revisar competencia y respuesta institucional.`,
    );
  if (nar.length)
    observations.push(
      `Existen ${nar.length} narrativas registradas; su contenido no constituye por sí mismo prueba de un hecho.`,
    );
  if (!observations.length)
    observations.push(
      'No hay señales suficientes para emitir conclusiones sustantivas con esta base de datos.',
    );

  const recommendations: string[] = [];
  if (activeAlerts.length)
    recommendations.push(
      'Revisar alertas abiertas, contrastar evidencias y asignar responsables y plazos.',
    );
  if (openDemands.length)
    recommendations.push(
      'Actualizar la trazabilidad de demandas, respuesta institucional y compromisos asociados.',
    );
  if (nar.length)
    recommendations.push(
      'Contrastar narrativas con fuentes independientes antes de atribuir hechos o responsabilidades.',
    );
  recommendations.push(
    'Validar el diagnóstico con el equipo territorial y registrar fecha, fuentes y analista responsable.',
    'Aplicar seguimiento periódico y documentar cambios frente al corte anterior.',
  );

  const priorityAlerts = [...activeAlerts].sort((a, b) => rank(a) - rank(b));

  return {
    project_id: projectId,
    project_name:
      project && Object.hasOwn(project, 'Nombre')
        ? project['Nombre']
        : projectId === DEFAULT_PROJECT_ID
          ? 'Proyecto Sechura'
          : projectId,
    generated_at: generatedAt,
    method: 'Síntesis descriptiva basada en registros; no predicción ni evaluación pericial.',
    counts: Object.fromEntries(
      SITUATIONAL_MODULES.map((m) => [m.toLowerCase(), groups[m].length]),
    ) as Record<Lowercase<(typeof SITUATIONAL_MODULES)[number]>, number>,
    alertas_activas: activeAlerts.length,
    demandas_pendientes: openDemands.length,
    territorios: mostCommon(
      ev.map((x) => orDefault(x['Territorio'], 'Sin precisar')),
      8,
    ),
    temas_demanda: mostCommon(
      openDemands.map((x) => orDefault(x['Tema'], 'Sin tema')),
      8,
    ),
    niveles_alerta: mostCommon(
      activeAlerts.map((x) =>
        orDefault(
          pyTruthy(x['Nivel_Preliminar']) ? x['Nivel_Preliminar'] : x['Nivel'],
          'Sin nivel',
        ),
      ),
    ),
    eventos_recientes: trim(ev, [
      'Fecha',
      'Territorio',
      'Descripcion_Hecho',
      'Nivel_Verificacion',
      'Fuente_ID',
    ]),
    alertas_prioritarias: trim(priorityAlerts, [
      'Fecha',
      'Nivel_Preliminar',
      'Causa',
      'Accion_Sugerida',
      'Fuente_ID',
    ]),
    demandas_abiertas: trim(openDemands, [
      'Fecha_Registro',
      'Tema',
      'Descripcion',
      'Estado',
      'Fuente_ID',
    ]),
    actores: trim(ac, [
      'Nombre_Actor/Organizacion',
      'Posicion_Proyecto',
      'Influencia',
      'Fuente_Principal',
    ]),
    observaciones: observations,
    escenarios: SCENARIOS,
    recomendaciones: recommendations,
    limitations: LIMITATIONS,
  };
};

const rank = (x: AnalysisRecord) =>
  ALERT_RANK.get(pyStr(pyGet(x, 'Nivel_Preliminar')).toLowerCase()) ?? 4;

export type SituationalAnalysis = ReturnType<typeof buildSituational>;
