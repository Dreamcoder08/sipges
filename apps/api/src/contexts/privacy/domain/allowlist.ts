/**
 * Field allowlists per record module (docs/adr/0030, Ley 29733 art. 13.5 and 13.6). This is the
 * only place that decides which fields may leave SIPGES for an external model or client:
 * anything not listed is dropped, so a new or imported field is private until someone reads it
 * here and says why it is not sensitive.
 *
 * Each field has one treatment:
 * - `clear`: a code, a date, a number or a value from a closed list; no person can be read in it.
 * - `text`: free text, sent after known names and contact data are replaced.
 * - `name`: one person or organisation, always replaced by its pseudonym, known or not.
 * - `names`: a list of them; every item is replaced.
 *
 * Never allowed, whatever the module: political opinion or stance, ethnic origin, health,
 * religion, union membership, income, biometrics, contact data and identity numbers
 * (`NEVER_ALLOWED`, enforced by a test over this file). Contact fields are dropped, not
 * pseudonymised: an agent has no need to reach anyone.
 */
import type { PseudonymKind } from './pseudonyms.ts';

export type FieldPolicy = {
  readonly kind: 'clear' | 'text' | 'name' | 'names';
  /** For `name` and `names`: the kind of pseudonym when the project does not know the name. */
  readonly entity?: PseudonymKind;
  /** Why sending this field, treated this way, does not expose sensitive data. */
  readonly why: string;
};

const clear = (why: string): FieldPolicy => ({ kind: 'clear', why });
const text = (why: string): FieldPolicy => ({ kind: 'text', why });
const name = (entity: PseudonymKind, why: string): FieldPolicy => ({ kind: 'name', entity, why });
const names = (entity: PseudonymKind, why: string): FieldPolicy => ({ kind: 'names', entity, why });

const SOURCE = clear('Reference to a source record (an id such as F-12), not a person.');
const DATE = clear('A calendar date of the record; no person is identified by it.');
const TERRITORY = clear('Community or district named for the territorial analysis, not a person.');
const STATUS = clear('Workflow state from a closed list (Pendiente, Cerrada...).');
const PRIORITY = clear('Priority or level from a closed list.');
const DEADLINE = clear('A due date or term, as written; no person is identified by it.');
const RESPONSIBLE = name(
  'Persona',
  'The responsible person becomes a pseudonym; the name never leaves.',
);
const ACTOR = name(
  'Actor',
  'The actor or organisation becomes a pseudonym; the name never leaves.',
);
const RECORD_ID = (why: string) => clear(`${why} Record codes are already sent as ids.`);

type ModuleFields = Readonly<Record<string, FieldPolicy>>;

/** Keyed by the module slug (`/api/{slug}`), like the ontology catalogue. */
export const FIELD_POLICIES: Readonly<Record<string, ModuleFields>> = {
  actores: {
    ID_Actor: RECORD_ID('Id of the actor.'),
    'Nombre_Actor/Organizacion': ACTOR,
    Tipo_Actor: clear('Category from a closed list (comunidad, empresa, institución pública...).'),
    Territorio: TERRITORY,
    Sector: clear('Sector of the actor map from a closed list.'),
    Influencia: clear(
      'Assessed level of influence of the actor or organisation, from a closed list.',
    ),
    Tipo_Relacion: clear('Strength of the relationship (Fuerte/Débil), from a closed list.'),
    Sentido_Relacion: clear('Direction of the relationship, from a closed list.'),
    Fuente_ID: SOURCE,
    // Dropped: Posicion_Proyecto (political stance), Interes and Rol/Relacion (what an actor
    // wants or does, free text that may reveal opinion or union role), Observaciones (notes).
  },
  eventos: {
    ID_Evento: RECORD_ID('Id of the event.'),
    Fecha: DATE,
    Territorio: TERRITORY,
    Actor_Principal: ACTOR,
    Tipo_Evento: clear('Kind of event, a short label.'),
    Descripcion_Hecho: text('The documented fact; named people and contact data are replaced.'),
    Dimension_Principal: clear('IRSA dimension from a closed list.'),
    Relevancia_Preliminar: PRIORITY,
    Nivel_Verificacion: clear('Verification level of the information, from a closed list.'),
    Estado_Validacion: STATUS,
    Estado_Informacion: clear('Observed, estimated or hypothetical, from a closed list.'),
    Fuente_ID: SOURCE,
  },
  demandas: {
    ID_Demanda: RECORD_ID('Id of the demand.'),
    Fecha_Registro: DATE,
    'Actor/Grupo': ACTOR,
    Territorio: TERRITORY,
    Tema: text('Subject of the demand, a short phrase.'),
    Descripcion: text('The demand as documented; named people and contact data are replaced.'),
    Prioridad: PRIORITY,
    Estado: STATUS,
    Fuente_ID: SOURCE,
  },
  compromisos: {
    ID_Compromiso: RECORD_ID('Id of the commitment.'),
    Fecha: DATE,
    Descripcion: text('The commitment as documented; named people and contact data are replaced.'),
    'Actor/Entidad': ACTOR,
    Demanda_Asociada: clear('Reference to a demand record, not a person.'),
    Responsable: RESPONSIBLE,
    Plazo: DEADLINE,
    Fecha_Vencimiento: DATE,
    'Avance_%': clear('Progress percentage; a number.'),
    Estado: STATUS,
    Evidencia_Cierre: text(
      'Description of the closing evidence; names and contact data are replaced.',
    ),
    Fuente_ID: SOURCE,
  },
  narrativas: {
    ID_Narrativa: RECORD_ID('Id of the narrative.'),
    Fecha_Inicio: DATE,
    Fecha_Observacion: DATE,
    'Plataforma/Fuente': text(
      'Medium or platform where it was seen; scrubbed in case it names a page.',
    ),
    Tema: text('Subject of the narrative, a short phrase.'),
    Categoria: clear('IRSA dimension from a closed list.'),
    Actor_Relacionado: ACTOR,
    Interacciones_Observadas: clear('Number of interactions; a count.'),
    Descripcion: text('The narrative as documented; named people and contact data are replaced.'),
    Intensidad: PRIORITY,
    Nivel_Verificacion: clear('Verification level of the information, from a closed list.'),
    Estado: STATUS,
    Fuente_ID: SOURCE,
    // Dropped: URL_Publicacion (can identify an author), Tono (stance towards the project).
  },
  fuentes: {
    ID_Fuente: RECORD_ID('Id of the source.'),
    Fecha_Documento: DATE,
    Archivo_Fuente: text('Name of the document; names and contact data are replaced.'),
    Tipo_Fuente: clear('Kind of source from a closed list.'),
    'Institucion/Autor': name('Org', 'Institution or author becomes a pseudonym.'),
    Periodo_Cubierto: clear('Period the source covers, a date range.'),
    Nivel_Base_Verificacion: clear('Verification level of the source, from a closed list.'),
  },
  alertas: {
    ID_Alerta: RECORD_ID('Id of the alert.'),
    Fecha: DATE,
    Causa: text('Documented cause of the alert; named people and contact data are replaced.'),
    Territorio: TERRITORY,
    Dimension: clear('IRSA dimension letter (G, A, D, N, E, I).'),
    Nivel_Preliminar: clear('Colour level (Verde, Amarillo, Naranja, Rojo).'),
    Estado: STATUS,
    Accion_Sugerida: text('Suggested action; named people and contact data are replaced.'),
    Fuente_ID: SOURCE,
  },
  acciones: {
    ID_Accion: RECORD_ID('Id of the action.'),
    Accion: text('The action as documented; named people and contact data are replaced.'),
    Alerta_Asociada: clear('Reference to an alert record, not a person.'),
    Responsable: RESPONSIBLE,
    Plazo: DEADLINE,
    Fecha_Vencimiento: DATE,
    Estado: STATUS,
    Resultado: text('Result obtained; named people and contact data are replaced.'),
    Fuente_ID: SOURCE,
  },
  directorio: {
    Nombre: name('Persona', 'The contact becomes a pseudonym; the name never leaves.'),
    Institucion: name('Org', 'The institution becomes a pseudonym.'),
    Territorio: TERRITORY,
    Tipo_Actor: clear('Category from a closed list.'),
    Prioridad: PRIORITY,
    Estado_Verificacion: clear('Verification state of the entry, from a closed list.'),
    Fuente_ID: SOURCE,
    // Dropped: Cargo (a unique job title identifies its holder), Telefono and any other contact.
  },
  intereses: {
    Actor: ACTOR,
    Estado: clear('Verification state of the record, from a closed list.'),
    Fuente_ID: SOURCE,
    // Dropped: Posicion, Interes, Preocupacion, Mandato, Alternativa: the stance of actors.
  },
  dialogos: {
    Proceso: text('Name of the dialogue process; scrubbed.'),
    Participantes: names('Actor', 'Every participant becomes a pseudonym.'),
    Tema: text('Subject of the dialogue, a short phrase.'),
    Opciones: text('Options considered in the process; names and contact data are replaced.'),
    Acuerdo: text('Agreement reached or not; names and contact data are replaced.'),
    Responsable: RESPONSIBLE,
    Proximo_Paso: text('Next step and term; names and contact data are replaced.'),
    Fuente_ID: SOURCE,
    Estado: STATUS,
  },
  oportunidades: {
    Oportunidad: text('The opportunity as documented; names and contact data are replaced.'),
    Tipo: clear('Kind of opportunity, a short label.'),
    Beneficiarios: text('Groups expected to benefit; names and contact data are replaced.'),
    Viabilidad: text('Conditions of viability; names and contact data are replaced.'),
    Restricciones: text('Technical or legal restrictions; names and contact data are replaced.'),
    Responsable: RESPONSIBLE,
    Plazo: DEADLINE,
    Fuente_ID: SOURCE,
    Estado: STATUS,
  },
  hechos: {
    Asunto: text('Question to verify; names and contact data are replaced.'),
    Versiones: text('Discrepant versions of the information; names and contact data are replaced.'),
    Preguntas: text('Questions agreed; names and contact data are replaced.'),
    Metodo: text('Method of verification; names and contact data are replaced.'),
    Participantes: names('Actor', 'Every participant becomes a pseudonym.'),
    Fuente_ID: SOURCE,
    Accion_Verificacion: text('Next verification step; names and contact data are replaced.'),
    Estado: STATUS,
  },
  aarc: {
    Actor_Proceso: ACTOR,
    Accion_Mejora: text('Improvement action; names and contact data are replaced.'),
    Fecha: DATE,
    Estado: STATUS,
    // Dropped: Reconocimiento, Agencia, Reciprocidad, Claridad, Evidencia: assessments of how
    // an actor perceives the relationship.
  },
  buzon: {
    ID_Caso: RECORD_ID('Id of the case.'),
    Fecha: DATE,
    Tipo: clear('Queja, Denuncia, Consulta or Sugerencia.'),
    Canal: clear('Channel the case came through, from a closed list.'),
    Territorio: TERRITORY,
    Actor_Relacionado: ACTOR,
    Tema: text('Subject of the case, a short phrase.'),
    Asunto: text('Subject line of the case; names and contact data are replaced.'),
    Prioridad: PRIORITY,
    Responsable: RESPONSIBLE,
    Fecha_Limite: DATE,
    Estado: STATUS,
    Fecha_Respuesta: DATE,
    // Dropped: Remitente and Contacto (identity and contact of the complainant), Descripcion
    // and Respuesta (complaints often describe health, family or whistle-blowing).
  },
  lecciones: {
    ID_Leccion: RECORD_ID('Id of the lesson.'),
    Fecha: DATE,
    Territorio: TERRITORY,
    Tema: text('Subject of the lesson, a short phrase.'),
    Actor: ACTOR,
    Que_Paso: text('What happened; names and contact data are replaced.'),
    Por_Que: text('Why it happened; names and contact data are replaced.'),
    Aprendido: text('What was learned; names and contact data are replaced.'),
    Registro_Relacionado: clear('Reference to a record, not a person.'),
  },
};

/** Stored module name of each slug, to find the project's known names in the database. */
export const STORED_MODULES: Readonly<Record<string, string>> = {
  actores: 'Actores',
  eventos: 'Eventos',
  demandas: 'Demandas',
  compromisos: 'Compromisos',
  narrativas: 'Narrativas',
  fuentes: 'Fuentes',
  alertas: 'Alertas',
  acciones: 'Acciones',
  directorio: 'Directorio_Territorial',
  intereses: 'Intereses',
  dialogos: 'Dialogos',
  oportunidades: 'Oportunidades',
  hechos: 'Hechos_Compartidos',
  aarc: 'Evaluaciones_AARC',
  buzon: 'Buzon',
  lecciones: 'Lecciones_Territoriales',
};

/** The field each module's display title comes from; its policy treats the title too. */
export const TITLE_FIELDS: Readonly<Record<string, string>> = {
  actores: 'Nombre_Actor/Organizacion',
  eventos: 'Descripcion_Hecho',
  demandas: 'Descripcion',
  compromisos: 'Descripcion',
  narrativas: 'Descripcion',
  fuentes: 'Archivo_Fuente',
  alertas: 'Causa',
  acciones: 'Accion',
  directorio: 'Nombre',
  intereses: 'Actor',
  dialogos: 'Proceso',
  oportunidades: 'Oportunidad',
  hechos: 'Asunto',
  aarc: 'Actor_Proceso',
  buzon: 'Asunto',
  lecciones: 'Aprendido',
};

/** Field names that must never appear in `FIELD_POLICIES` (checked by a test). */
export const NEVER_ALLOWED =
  /posici|postura|opini|tono|etni|raza|salud|enferm|discapac|relig|sindic|ingres|salari|sueldo|biometr|huella|telef|celular|correo|e?mail|dni|remitente|contacto/i;

/** The treatment of one field, or null when it is not allowed (or the module has no list). */
export const policyFor = (slug: string, field: string): FieldPolicy | null => {
  if (!Object.hasOwn(FIELD_POLICIES, slug)) return null;
  const fields = FIELD_POLICIES[slug] as ModuleFields;
  return Object.hasOwn(fields, field) ? (fields[field] as FieldPolicy) : null;
};

/** How a `names` field separates its people: commas, semicolons, slashes, «y»/«e». */
export const LIST_SEPARATOR = /\s*(?:[,;\n/&]|\s+y\s+|\s+e\s+)\s*/iu;

/** Person fields never sent, but whose names must still be replaced inside free text. */
const DROPPED_NAME_FIELDS: Readonly<Record<string, PseudonymKind>> = {
  Remitente: 'Persona',
};

export type NameSource = {
  readonly field: string;
  readonly entity: PseudonymKind;
  /** The field holds several people, split with `LIST_SEPARATOR`. */
  readonly list: boolean;
};

/**
 * Where the project's own people and organisations are written, to find them in free text. A
 * person field has the same name in every module, so a source is read in all of them, also in
 * modules and fields that are never sent: a name stored anywhere in SIPGES is a known name.
 */
export const NAME_SOURCES: readonly NameSource[] = [
  ...new Map<string, NameSource>([
    ...Object.values(FIELD_POLICIES).flatMap((fields) =>
      Object.entries(fields).flatMap(([field, policy]): [string, NameSource][] =>
        (policy.kind === 'name' || policy.kind === 'names') && policy.entity
          ? [[field, { field, entity: policy.entity, list: policy.kind === 'names' }]]
          : [],
      ),
    ),
    ...Object.entries(DROPPED_NAME_FIELDS).map(([field, entity]): [string, NameSource] => [
      field,
      { field, entity, list: false },
    ]),
  ]).values(),
];
