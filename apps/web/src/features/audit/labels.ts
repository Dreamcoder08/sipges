import { keyWords } from '../../shared/lib/text.ts';

/**
 * Spanish names of what the API stores in an audit row (functional-10 T3, F9). The stored values
 * stay as they are: automations match on `CREATE`/`UPDATE` and old rows are never rewritten. The
 * record operations use the words of a record's history (records/HistoryPanel).
 */
const ACTIONS: Readonly<Record<string, string>> = {
  CREATE: 'Creación',
  UPDATE: 'Actualización',
  DELETE: 'Eliminación',
  IMPORT: 'Importación',
  UPLOAD: 'Carga de archivo',
  CLASSIFY: 'Clasificación',
  REVIEW: 'Revisión',
  SNAPSHOT: 'Corte IRSA guardado',
  CONFIG_UPDATE: 'Cambio de configuración',
  SESSION_END: 'Cierre de sesión',
  SESSIONS_END_OTHERS: 'Cierre de las demás sesiones',
  MFA_RESET: 'Restablecimiento de la verificación en dos pasos',
  CHANNEL_SEND: 'Aviso enviado a un canal',
  PUSH_SEND: 'Notificación push',
  EGRESS: 'Envío a IA externa',
};

/** Audit modules whose stored name is not already a Spanish phrase. */
const MODULES: Readonly<Record<string, string>> = {
  Directorio_Territorial: 'Directorio territorial',
  Actores_Priorizados: 'Actores priorizados',
  Hechos_Compartidos: 'Hechos compartidos',
  Evaluaciones_AARC: 'Evaluaciones AARC',
  Lecciones_Territoriales: 'Lecciones territoriales',
  Laboratorio_Documental: 'Laboratorio documental',
  InteligenciaDigital: 'Inteligencia digital',
  PrevencionTerritorial: 'Prevención territorial',
  Vinculos: 'Vínculos',
  Dialogos: 'Diálogos',
  Buzon: 'Buzón',
  SIPGES: 'Configuración del proyecto',
};

/** «Creación» for `CREATE`; an action no map names yet reads as words. */
export const auditActionLabel = (action: string) =>
  ACTIONS[action.trim().toUpperCase()] ?? keyWords(action);

/** «Directorio territorial» for `Directorio_Territorial`; other names read as words. */
export const auditModuleLabel = (module: string) =>
  MODULES[module] ?? (/[_]/.test(module) ? keyWords(module) : module);
