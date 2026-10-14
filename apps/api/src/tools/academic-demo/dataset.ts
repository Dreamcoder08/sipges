/** A fictional, reproducible case. No real contacts, accounts or operational records. */
export const DEMO_VERSION = 'mascli-academic-v1';
export const DEMO_SCOPE = 'MASCLI/PRJ-SECHURA';
export type DemoRecord = { module: string; key: string; payload: Record<string, unknown> };
export type DemoEvidence = {
  recordId: string;
  filename: string;
  format: 'txt' | 'pdf' | 'docx';
  text: string;
};
const scenarios = ['Acuerdo cumplido', 'Negociación abierta', 'Compromiso atrasado'] as const;
const dimensions = [
  'G - Gobernanza y representación',
  'A - Actores e influencia',
  'D - Demandas y compromisos',
  'N - Narrativas y señales digitales',
  'E - Ambiental-territorial',
  'I - Institucional y trazabilidad',
];
const titles = [
  'Capacitación y empleo local',
  'Monitoreo participativo del agua',
  'Información sobre tránsito y ruido',
];
const organizations = [
  'Cooperativa Aurora',
  'Comité de Agua Horizonte',
  'Asociación Vecinal Mirador',
  'Mesa de Proveedores Brisa',
  'Consejo Comunitario Faro',
  'Laboratorio Participativo Delta',
  'Colectivo de Jóvenes Marea',
  'Operadora Costa Clara',
  'Red de Mujeres Semilla',
  'Comité de Seguimiento Naciente',
  'Observatorio Ambiental Cauce',
  'Oficina de Diálogo Puente',
];
const eventDescriptions = [
  'Asamblea de elección de representantes con padrón y acta revisados.',
  'Taller de capacitación para empleo local; se completó la primera cohorte.',
  'Visita de campo para establecer una línea base ambiental de agua y suelo.',
  'Mesa de diálogo documenta alternativas de horario para tránsito de vehículos.',
  'Comité de seguimiento confirma entrega del compromiso de capacitación.',
  'Publicación de avances con responsables y evidencias disponibles.',
  'Reunión detecta representación provisional pendiente de validar.',
  'Comité de agua solicita contrastar resultados antes de aprobar el acuerdo.',
  'Taller registra desacuerdo sobre participación y representatividad.',
  'Revisión conjunta define preguntas, método y próximo muestreo de agua.',
  'Mesa de proveedores propone condiciones transparentes de contratación.',
  'Acta registra una negociación abierta y responsables del siguiente paso.',
  'Sesión identifica compromiso vencido de mitigación del tránsito y ruido.',
  'Asamblea expresa tensión por retrasos y solicita un calendario verificable.',
  'Visita ambiental registra polvo y ruido como observaciones por contrastar.',
  'Reunión plantea preocupación por agua, pesca y trazabilidad de mediciones.',
  'Junta acuerda revisar la legitimidad del mandato de sus representantes.',
  'Equipo publica una aclaración documental de información aún no corroborada.',
  'Mesa técnica propone plan preventivo con responsable y plazo de seguimiento.',
  'Revisión mensual distingue compromisos cumplidos, en proceso y vencidos.',
];
const key = (prefix: string, n: number) => `DEMO-${prefix}-${String(n + 1).padStart(2, '0')}`;
const date = (n: number) => new Date(Date.UTC(2026, 6, 20 + n * 4)).toISOString().slice(0, 10);
const scenario = (n: number) => scenarios[n % scenarios.length] ?? scenarios[0];
const org = (n: number) => `[SINTÉTICO] ${organizations[n % organizations.length]}`;
const source = (n: number) => key('F', (n % 3) + 3 * (Math.floor(n / 3) % 3));
const idFields: Record<string, string> = {
  fuentes: 'ID_Fuente',
  actores: 'ID_Actor',
  eventos: 'ID_Evento',
  demandas: 'ID_Demanda',
  compromisos: 'ID_Compromiso',
  narrativas: 'ID_Narrativa',
  alertas: 'ID_Alerta',
  acciones: 'ID_Accion',
};

export const academicDemo = (): {
  scope: string;
  version: string;
  asOf: string;
  records: DemoRecord[];
  evidence: DemoEvidence[];
} => {
  const records: DemoRecord[] = [];
  const evidence: DemoEvidence[] = [];
  const add = (
    module: string,
    prefix: string,
    count: number,
    payload: (n: number) => Record<string, unknown>,
  ) => {
    for (let n = 0; n < count; n++) {
      const recordKey = key(prefix, n);
      const idField = idFields[module];
      records.push({
        module,
        key: recordKey,
        payload: {
          Demo_Dataset: DEMO_VERSION,
          Demo_ID: recordKey,
          Dato_Sintetico: true,
          Escenario: scenario(n),
          Proyecto_ID: 'PRJ-SECHURA',
          Proyecto: 'Proyecto Sechura (demo sintética)',
          Territorio: 'Sechura — caso académico ficticio',
          Observaciones:
            'DATOS SINTÉTICOS. Organizaciones, personas, hechos y mediciones inventados para demostración; la verificación es simulada.',
          ...(idField ? { [idField]: recordKey } : {}),
          ...payload(n),
        },
      });
    }
  };
  add('fuentes', 'F', 10, (n) => {
    const format = n === 0 ? 'pdf' : n === 1 ? 'docx' : 'txt';
    const filename = `demo-fuente-${String(n + 1).padStart(2, '0')}.${format}`;
    const outcome = [
      'Se completó la capacitación de empleo local y se documentó el cierre del acuerdo.',
      'La negociación sobre monitoreo participativo del agua permanece abierta; se solicitan datos adicionales.',
      'La mitigación de tránsito y ruido está atrasada; el compromiso venció y requiere intervención.',
    ][n % 3];
    const text = `DOCUMENTO SINTÉTICO — ${key('F', n)}\nCaso: ${scenario(n)}. Tema: ${titles[n % 3]}.\n${outcome}\nParticipantes: ${org(n)} y ${org(n + 1)}.\nDemanda: ${key('D', n)}. Compromiso: ${key('C', n)}.\nEl responsable registra evidencia, fecha y próximo paso. Este caso no describe hechos ni mediciones reales.\nSe requiere revisión humana de la fuente antes de decidir.\n`;
    evidence.push({ recordId: key('F', n), filename, format, text });
    return {
      Archivo_Fuente: filename,
      Fecha_Documento: date(n),
      Tipo_Fuente: ['Acta', 'Informe', 'Registro de campo'][n % 3],
      'Institucion/Autor': 'Equipo académico sintético MASCLI',
      Nivel_Base_Verificacion: n < 6 ? 'A - Confirmada' : 'C - Parcial',
      Periodo_Cubierto: 'Julio–octubre 2026 (simulado)',
    };
  });
  add('actores', 'A', 12, (n) => ({
    'Nombre_Actor/Organizacion': org(n),
    Tipo_Actor: ['Organización social', 'Comunidad', 'Empresa'][n % 3],
    'Rol/Relacion': 'Representante del proceso de diálogo sintético',
    'Legitimidad/Representacion':
      n % 3 === 2
        ? 'Mandato provisional pendiente de validar'
        : 'Mandato y representación documentados (simulados)',
    Influencia: ['Alta', 'Media', 'Baja'][n % 3],
    Interes: titles[n % 3],
    Posicion_Proyecto: ['A favor', 'Neutral', 'En contra'][n % 3],
    Fuente_ID: source(n),
  }));
  add('directorio', 'DIR', 12, (n) => ({
    Nombre: `[SINTÉTICO] Vocería DEMO ${String(n + 1).padStart(2, '0')}`,
    Cargo: 'Representante ficticio',
    Institucion: org(n),
    Actor_ID: key('A', n),
    Telefono: '',
    Email: `voceria${n + 1}@example.invalid`,
    Tipo_Actor: 'Organización social',
    Prioridad: ['Alta', 'Media', 'Baja'][n % 3],
    Estado_Verificacion: n % 3 === 0 ? 'Corroborado' : 'Por verificar',
    Fuente_ID: source(n),
  }));
  add('eventos', 'EV', 20, (n) => ({
    Fecha: date(n),
    Actor_Principal: org(n),
    Actor_ID: key('A', n % 12),
    Tipo_Evento: ['Asamblea', 'Reunión de seguimiento', 'Visita de campo'][n % 3],
    Descripcion_Hecho: `[SINTÉTICO] ${eventDescriptions[n % 3 === 0 ? Math.floor(n / 3) % 6 : n % 3 === 1 ? 6 + (Math.floor(n / 3) % 6) : 12 + (Math.floor(n / 3) % 8)]}`,
    Dimension_Principal: dimensions[n % 6],
    Relevancia_Preliminar: ['Baja', 'Media', 'Alta'][n % 3],
    Nivel_Verificacion: n % 3 === 0 ? 'A - Confirmada' : 'C - Parcial',
    Estado_Validacion: n % 3 === 0 ? 'Validado' : 'En revisión',
    Fuente_ID: source(n),
  }));
  add('demandas', 'D', 12, (n) => ({
    Fecha_Registro: date(n),
    'Actor/Grupo': org(n),
    Actor_ID: key('A', n),
    Tema: titles[n % 3],
    Descripcion: `[SINTÉTICO] Solicitud ${n + 1}: ${titles[n % 3]} con criterios y evidencia verificables.`,
    Prioridad: ['Baja', 'Media', 'Alta'][n % 3],
    Estado: ['Cerrada', 'En diálogo', 'Nueva'][n % 3],
    Fuente_ID: source(n),
  }));
  add('compromisos', 'C', 12, (n) => ({
    Fecha: date(n),
    Descripcion: `[SINTÉTICO] Hito ${n + 1}: atender ${titles[n % 3]} y documentar el resultado.`,
    'Actor/Entidad': org(n),
    Demanda_Asociada: key('D', n),
    Responsable: org((n + 1) % 12),
    Plazo: n % 3 === 2 ? '2026-09-30' : '2026-10-30',
    'Avance_%': [100, 45, 10][n % 3],
    Estado: ['Cumplido', 'En proceso', 'Vencido'][n % 3],
    Evidencia_Cierre: n % 3 === 0 ? source(n) : '',
    Fuente_ID: source(n),
  }));
  add('narrativas', 'N', 8, (n) => ({
    Fecha_Inicio: date(n + 12),
    Fecha_Observacion: '2026-10-14',
    URL_Publicacion: `https://example.invalid/mascli/demo/${n + 1}`,
    'Plataforma/Fuente': 'Boletín académico ficticio',
    Tema: titles[n % 3],
    Actor_Relacionado: org(n),
    Actor_ID: key('A', n),
    Interacciones_Observadas: [12, 40, 75][n % 3],
    Descripcion: `[SINTÉTICO] ${['Se comunica el cumplimiento de la capacitación.', 'Se solicita mayor claridad sobre los resultados de agua.', 'Se expresa preocupación por el retraso en mitigación de ruido.'][n % 3]}`,
    Tono: ['Positivo', 'Neutral', 'Crítico'][n % 3],
    Intensidad: ['Baja', 'Media', 'Alta'][n % 3],
    Nivel_Verificacion: 'C - Parcial',
    Estado: ['Cerrada', 'En seguimiento', 'Abierta'][n % 3],
    Fuente_ID: source(n),
  }));
  add('alertas', 'AL', 6, (n) => ({
    Fecha: date(n + 12),
    Causa: `[SINTÉTICO] ${titles[n % 3]}: ${['seguimiento concluido', 'información por contrastar', 'compromiso vencido y tensión'][n % 3]}.`,
    Dimension: ['G', 'A', 'D', 'N', 'E', 'I'][n],
    Nivel_Preliminar: ['Verde', 'Amarillo', 'Naranja'][n % 3],
    Estado: ['Cerrada', 'En seguimiento', 'Abierta'][n % 3],
    Accion_Sugerida: 'Contrastar evidencia y registrar una decisión humana.',
    Fuente_ID: source(n),
  }));
  add('acciones', 'AC', 8, (n) => ({
    Accion: `[SINTÉTICO] ${['Documentar cierre del acuerdo', 'Convocar revisión participativa', 'Reprogramar hito y verificar avance'][n % 3]} ${n + 1}.`,
    Alerta_Asociada: key('AL', n % 6),
    Responsable: org(n),
    Plazo: n % 3 === 2 ? '2026-10-01' : '2026-10-30',
    Estado: ['Cumplida', 'En proceso', 'Pendiente'][n % 3],
    Fuente_ID: source(n),
  }));
  add('intereses', 'INT', 6, (n) => ({
    Actor: org(n),
    Actor_ID: key('A', n),
    Posicion: ['Apoya el acuerdo', 'Solicita información', 'Cuestiona el plazo'][n % 3],
    Interes: titles[n % 3],
    Preocupacion: 'Transparencia de resultados y participación efectiva.',
    Mandato: 'Representación ficticia registrada en acta.',
    Alternativa: 'Solicitar una mesa de contraste independiente.',
    Estado: 'En revisión (simulada)',
    Fuente_ID: source(n),
  }));
  add('dialogos', 'DIA', 4, (n) => ({
    Proceso: `[SINTÉTICO] Mesa ${n + 1}: ${titles[n % 3]}`,
    Participantes: `${org(n)}; ${org(n + 1)}`,
    Tema: titles[n % 3],
    Opciones: 'Monitoreo participativo; seguimiento mensual; revisión documental.',
    Acuerdo: [
      'Acuerdo cumplido y cierre documentado.',
      'Información adicional solicitada; negociación abierta.',
      'No hay acuerdo sobre el plazo; se requiere intervención.',
    ][n % 3],
    Responsable: org(n + 1),
    Proximo_Paso: 'Revisar acta y evidencias el 2026-10-30.',
    Estado: ['Concluido', 'En diálogo', 'Pendiente'][n % 3],
    Fuente_ID: source(n),
  }));
  add('oportunidades', 'OP', 4, (n) => ({
    Oportunidad: `[SINTÉTICO] ${['Programa de capacitación local', 'Laboratorio participativo de agua', 'Servicio de monitoreo de tránsito'][n % 3]}`,
    Tipo: ['Capacitación', 'Servicios', 'Proveedores'][n % 3],
    Beneficiarios: org(n),
    Viabilidad: 'Presupuesto ficticio y revisión técnica pendiente.',
    Restricciones: 'No constituye oferta real ni autorización de inversión.',
    Responsable: org(n + 1),
    Plazo: '2026-11-15',
    Estado: ['Aprobada (simulada)', 'En evaluación', 'Propuesta'][n % 3],
    Fuente_ID: source(n),
  }));
  add('hechos', 'H', 4, (n) => ({
    Asunto: `[SINTÉTICO] Contraste ${n + 1}: ${titles[n % 3]}`,
    Versiones: 'Una versión afirma cumplimiento; otra solicita respaldo documental.',
    Preguntas: '¿Qué evidencia respalda el resultado y quién la revisó?',
    Metodo: 'Revisión de acta y contraste participativo.',
    Participantes: `${org(n)}; ${org(n + 1)}`,
    Accion_Verificacion: 'Contrastar fuente y registrar disensos.',
    Estado: ['Validado (simulado)', 'En contraste', 'Pendiente'][n % 3],
    Fuente_ID: source(n),
  }));
  add('aarc', 'AARC', 4, (n) => ({
    Actor_Proceso: `[SINTÉTICO] Evaluación de ${org(n)}`,
    Reconocimiento: ['Preocupaciones escuchadas', 'Escucha parcial', 'Preocupaciones pendientes'][
      n % 3
    ],
    Agencia: 'Participación observada en mesa ficticia.',
    Reciprocidad: 'Opciones de beneficio mutuo documentadas.',
    Claridad: ['Plazos claros y cierre', 'Datos por contrastar', 'Plazo vencido'][n % 3],
    Evidencia: `Fuente ${source(n)}: acta de revisión simulada.`,
    Accion_Mejora: 'Registrar responsable, plazo y evidencia de seguimiento.',
    Fecha: '2026-10-14',
    Estado: 'En revisión académica',
    Fuente_ID: source(n),
  }));
  return { scope: DEMO_SCOPE, version: DEMO_VERSION, asOf: '2026-10-14', records, evidence };
};
