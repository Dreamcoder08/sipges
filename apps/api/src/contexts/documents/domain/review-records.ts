import { limaToday } from '@sipges/kernel';
import type { ReviewItem, ReviewStatus } from './review.ts';

/**
 * An approved review finding becomes a record in the tenant's module (functional-closure T23).
 * The target follows the lexical theme the document lab extracted (insights.ts DOC_TERMS);
 * free themes from imported batches go to «Hechos compartidos», the module for facts to verify.
 */

/** Decisions that accept a finding; «pendiente» and «descartado» never create a record. */
export const APPROVAL_STATUSES: readonly ReviewStatus[] = [
  'aceptado_para_revision',
  'corroborado_documentalmente',
];
export const isApproval = (status: ReviewStatus) => APPROVAL_STATUSES.includes(status);

/** A records module by its URL slug (contexts/records RECORD_MODULES) and its screen label. */
export type ReviewTarget = { readonly module: string; readonly label: string };

const ACTORES = { module: 'actores', label: 'Actores' } as const;
const DEMANDAS = { module: 'demandas', label: 'Demandas' } as const;
const COMPROMISOS = { module: 'compromisos', label: 'Compromisos' } as const;
const HECHOS = { module: 'hechos', label: 'Hechos compartidos' } as const;
const DIALOGOS = { module: 'dialogos', label: 'Diálogos' } as const;
const OPORTUNIDADES = { module: 'oportunidades', label: 'Valor compartido' } as const;
const NARRATIVAS = { module: 'narrativas', label: 'Narrativas' } as const;

const TARGETS: Readonly<Record<string, ReviewTarget>> = {
  'Actor (extracción automática)': ACTORES,
  'Representatividad y gobernanza': ACTORES,
  'Demandas e intereses': DEMANDAS,
  'Compromisos y trazabilidad': COMPROMISOS,
  'Controversias y hechos compartidos': HECHOS,
  'Diálogo y construcción de consensos': DIALOGOS,
  'Oportunidades de valor compartido': OPORTUNIDADES,
  'Territorio y ambiente': NARRATIVAS,
};

export const reviewTarget = (theme: string): ReviewTarget =>
  Object.hasOwn(TARGETS, theme) ? (TARGETS[theme] as ReviewTarget) : HECHOS;

/** The project of a `COMPANY/PROJECT` tenant id: records carry the tenant's project. */
export const projectOf = (tenantId: string) => tenantId.slice(tenantId.indexOf('/') + 1);

/** Audit source of records created from approved review items. */
export const REVIEW_SOURCE = 'la bandeja de revisión documental';

/** Deterministic record id: approving twice, or approving and then the backfill, is one record. */
export const reviewRecordId = (itemId: string) => `REV-${itemId}`;

const STATUS_LABELS: Record<ReviewStatus, string> = {
  pendiente: 'pendiente',
  aceptado_para_revision: 'aceptado para revisión',
  descartado: 'descartado',
  corroborado_documentalmente: 'corroborado documentalmente',
};

/** `YYYY-MM-DD` of the decision in Peru, the date fields' format. */
const day = (at: Date) => limaToday(at);

/**
 * Record fields for an approved item, derived only from the item so the inbox and the backfill
 * write the same payload. The excerpt fills the module's main text field; everything without a
 * field of its own (theme, suggested action, reviewer note, SHA-256) goes to «Observaciones», and
 * the source document, location and review item id keep the record traceable.
 */
export const reviewRecordFields = (item: ReviewItem, projectId: string): Record<string, string> => {
  const target = reviewTarget(item.theme);
  const id = reviewRecordId(item.id);
  const date = day(item.updatedAt);
  const notes = [
    `Hallazgo documental ${STATUS_LABELS[item.status]}${item.reviewer ? ` por ${item.reviewer}` : ''}.`,
    item.theme ? `Tema: ${item.theme}.` : '',
    item.action ? `Acción sugerida: ${item.action}` : '',
    item.note ? `Nota de revisión: ${item.note}` : '',
    `Documento: ${item.sourceFile} (SHA-256 ${item.sourceSha256}), ${item.location}.`,
  ];
  const common = {
    Proyecto_ID: projectId,
    Fuente_ID: `${item.sourceFile} · ${item.location}`,
    Revision_Documental_ID: item.id,
  };
  const corroborated = item.status === 'corroborado_documentalmente';
  const own: Record<string, string> = (() => {
    switch (target.module) {
      case 'actores':
        return {
          ID_Actor: id,
          'Nombre_Actor/Organizacion': `Por identificar (${item.sourceFile})`,
          Tipo_Actor: 'Otro / por verificar',
          'Rol/Relacion': item.excerpt,
        };
      case 'demandas':
        return {
          ID_Demanda: id,
          Fecha_Registro: date,
          Tema: item.theme,
          Descripcion: item.excerpt,
          Estado: 'En revisión',
        };
      case 'compromisos':
        return { ID_Compromiso: id, Fecha: date, Descripcion: item.excerpt, Estado: 'Pendiente' };
      case 'dialogos':
        return { Proceso: item.excerpt, Tema: item.theme, Estado: 'Por verificar' };
      case 'oportunidades':
        return { Oportunidad: item.excerpt, Estado: 'En evaluación' };
      case 'narrativas':
        return {
          ID_Narrativa: id,
          Fecha_Observacion: date,
          'Plataforma/Fuente': item.sourceFile,
          Tema: item.theme,
          Categoria: 'E - Ambiental-territorial',
          Descripcion: item.excerpt,
          Tono: 'Por evaluar',
          Nivel_Verificacion: corroborated ? 'B - Corroborada' : 'E - No verificada',
        };
      default:
        return {
          Asunto: item.excerpt,
          Accion_Verificacion: item.action,
          Estado: corroborated ? 'validado' : 'pendiente',
        };
    }
  })();
  return { ...own, ...common, Observaciones: notes.filter(Boolean).join(' ') };
};
