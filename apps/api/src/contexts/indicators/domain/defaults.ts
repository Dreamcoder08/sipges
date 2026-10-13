// Embedded copies of data/indicator_config.json, data/irsa_config.json and data/model_status.json
// (app.py defaults). Never read from disk at request time.
import type { IndicatorMeta, IrsaConfig } from './types.ts';

export const INDICATOR_CONFIG: Readonly<Record<string, readonly IndicatorMeta[]>> = {
  G: [
    {
      code: 'G1',
      name: 'Validez de representación',
      definition:
        'Riesgo derivado de interlocutores con representación fragmentada, limitada o pendiente de validación.',
    },
    {
      code: 'G2',
      name: 'Estabilidad de gobernanza',
      definition:
        'Nivel de estabilidad de la conducción y de los mecanismos de gobernanza comunal.',
    },
    {
      code: 'G3',
      name: 'Conflictividad interna',
      definition: 'Intensidad de disputas, enfrentamientos o facciones vinculadas a la gobernanza.',
    },
    {
      code: 'G4',
      name: 'Incertidumbre jurídica/registral',
      definition:
        'Presencia de procesos judiciales, registrales o administrativos que pueden alterar representación o capacidad de actuación.',
    },
    {
      code: 'G5',
      name: 'Cambios de liderazgo y proceso electoral',
      definition:
        'Cambios, elecciones, padrones o administraciones provisionales que modifican interlocución y liderazgo.',
    },
  ],
  A: [
    {
      code: 'A1',
      name: 'Influencia de actores críticos',
      definition:
        'Presencia de actores de alta influencia cuya posición es crítica, opositora o no determinada.',
    },
    {
      code: 'A2',
      name: 'Capacidad de movilización',
      definition: 'Capacidad observable de convocatoria o movilización de actores territoriales.',
    },
    {
      code: 'A3',
      name: 'Cambio de posición',
      definition: 'Variación temporal de la posición de los actores frente al proyecto.',
    },
    {
      code: 'A4',
      name: 'Centralidad en la red',
      definition:
        'Concentración de menciones e interacciones en actores que ocupan posiciones centrales en la red.',
    },
    {
      code: 'A5',
      name: 'Legitimidad de actores priorizados',
      definition:
        'Riesgo asociado a actores prioritarios cuya legitimidad o representación requiere validación.',
    },
    {
      code: 'A6',
      name: 'Polarización y alianzas',
      definition:
        'Señales de polarización, tensión, facciones, alianzas o confrontación entre actores.',
    },
  ],
  D: [
    {
      code: 'D1',
      name: 'Demandas abiertas',
      definition: 'Volumen de demandas que permanecen abiertas o en atención.',
    },
    {
      code: 'D2',
      name: 'Recurrencia de demandas',
      definition: 'Proporción de demandas clasificadas con recurrencia alta.',
    },
    {
      code: 'D3',
      name: 'Compromisos vencidos',
      definition: 'Proporción de compromisos vencidos sin cierre documentado.',
    },
    {
      code: 'D4',
      name: 'Demoras de atención',
      definition:
        'Proxy de riesgo por demandas nuevas/evaluadas y compromisos pendientes, ante ausencia de tiempos completos de respuesta.',
    },
    {
      code: 'D5',
      name: 'Brecha expectativa–competencia',
      definition:
        'Demandas cuya atención depende de otra entidad, futura etapa contractual o competencia aún por definir.',
    },
  ],
  N: [
    {
      code: 'N1',
      name: 'Contenido crítico',
      definition: 'Proporción de narrativas con tono negativo e intensidad alta.',
    },
    {
      code: 'N2',
      name: 'Persistencia de narrativas sensibles',
      definition:
        'Narrativas que permanecen en seguimiento o activas durante el periodo registrado.',
    },
    {
      code: 'N3',
      name: 'Confrontación digital',
      definition:
        'Narrativas con términos de controversia, conflicto, tensión, disputa o enfrentamiento.',
    },
    {
      code: 'N4',
      name: 'Información no verificada',
      definition: 'Proporción de narrativas con verificación baja o pendiente.',
    },
    {
      code: 'N5',
      name: 'Diversificación de temas emergentes',
      definition:
        'Número de temas distintos presentes en el monitoreo como aproximación a la expansión de la agenda narrativa.',
    },
  ],
  E: [
    {
      code: 'E1',
      name: 'Preocupaciones ambientales activas',
      definition:
        'Demandas y eventos activos asociados a agua, pesca, maricultura, biodiversidad, territorio y otros componentes ambientales.',
    },
    {
      code: 'E2',
      name: 'Recurrencia ambiental',
      definition: 'Proporción de demandas ambientales registradas con recurrencia alta.',
    },
    {
      code: 'E3',
      name: 'Medios de vida expuestos',
      definition:
        'Diversidad de sectores productivos potencialmente expuestos según demandas y eventos.',
    },
    {
      code: 'E4',
      name: 'Territorio, accesos y servidumbres',
      definition:
        'Señales relacionadas con uso de territorio, servidumbres, acceso, tránsito, superficie, rutas y delimitación.',
    },
    {
      code: 'E5',
      name: 'Brecha percepción–evidencia',
      definition:
        'Proporción de eventos ambientales sustentados principalmente en percepción/opinión frente a evidencia verificada/corroborada.',
    },
  ],
  I: [
    {
      code: 'I1',
      name: 'Coordinación interinstitucional',
      definition:
        'Riesgo residual reflejado en alertas institucionales y acciones pendientes de coordinación.',
    },
    {
      code: 'I2',
      name: 'Coherencia de mensajes',
      definition:
        'Señales de contradicción, desinformación institucional o necesidad de precisar el alcance de la información.',
    },
    {
      code: 'I3',
      name: 'Oportunidad de respuesta',
      definition:
        'Proxy basado en alertas y acciones institucionales que permanecen pendientes o en curso.',
    },
    {
      code: 'I4',
      name: 'Alertas sin responsable efectivo',
      definition:
        "Proporción de alertas activas sin responsable definido o asignadas a 'Por asignar'.",
    },
    {
      code: 'I5',
      name: 'Trazabilidad documental',
      definition:
        'Riesgo inverso del porcentaje de registros clave que cuentan con fuente documental identificada.',
    },
    {
      code: 'I6',
      name: 'Cobertura territorial',
      definition:
        'Cobertura de territorios distintos en eventos y demandas respecto del directorio territorial disponible.',
    },
  ],
};

export const DEFAULT_IRSA_CONFIG: IrsaConfig = {
  version: '0.3-provisional',
  status: 'PENDIENTE_DE_VALIDACION_METODOLOGICA',
  weights: {
    G: 0.1666667,
    A: 0.1666667,
    D: 0.1666667,
    N: 0.1666667,
    E: 0.1666667,
    I: 0.1666665,
  },
  thresholds: {
    Verde: [0, 24.99],
    Amarillo: [25, 49.99],
    Naranja: [50, 74.99],
    Rojo: [75, 100],
  },
  contributions: {
    active_alert: 18,
    high_event: 8,
    critical_event: 12,
    open_demand: 7,
    pending_action: 5,
    unverified_narrative: 6,
  },
  notes: [
    'Los pesos son iguales únicamente como línea base de prototipado.',
    'Los pesos definitivos deberán validarse mediante el método aprobado en la tesis (p. ej., AHP/Delphi).',
    'Los umbrales del semáforo son provisionales y requieren calibración y análisis de sensibilidad.',
    'El cálculo no sustituye la evaluación humana.',
  ],
};

export const MODEL_STATUS: Readonly<Record<string, unknown>> = {
  version: 'MASCLI · Prototipo final de tesis | Motor V0.5.1',
  content_validation: 'Pendiente de juicio de expertos',
  aiken_status: 'Sin resultados todavía',
  indicator_count: 32,
  dimensions: ['G', 'A', 'D', 'N', 'E', 'I'],
  canonical_entity: 'Comunidad Campesina San Martín de Sechura (CCSMS)',
  release_rule:
    'La interfaz está finalizada para la tesis. La condición de “modelo validado” solo se asignará después del juicio de expertos y la evaluación funcional contra Gold Standard.',
  classifier: 'Reglas ponderadas y contextuales',
  functional_validation: 'Protocolo preparado; Gold Standard pendiente',
  ui_release: 'Web Final RC 1.0',
};
