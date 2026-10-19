import type { Situation } from '@mascli/contracts';
import { objectHref } from '../../shared/lib/navigation.tsx';

/** Alerts created from a situation carry this origin; the engine never counts them again. */
export const GENERATED_ORIGIN = 'MASCLI 4.0';

/** Stored module name → screen slug ("Demandas" → "demandas", "Buzon" → "buzon"). */
export const citationHref = (module: string, id: string) => objectHref(module.toLowerCase(), id);

/**
 * The alert a person confirms from a situation: its level, the explanation and the suggested
 * actions, with the cited records. A territory is set only when every dated record that
 * carries one names the same territory.
 */
export const situationAlertPayload = (
  situation: Situation,
  today: string,
  projectId: string,
  projectLabel: string,
) => ({
  Proyecto_ID: projectId,
  Proyecto: projectLabel || projectId,
  Fecha: today,
  Causa: situation.summary,
  ...(situation.kind === 'territorio'
    ? { Territorio: situation.label }
    : situation.territories.length === 1
      ? { Territorio: situation.territories[0] }
      : {}),
  Nivel_Preliminar: situation.level,
  Estado: 'Abierta',
  Accion_Sugerida: situation.recommendations.join('\n'),
  Origen: GENERATED_ORIGIN,
  Situacion: situation.key,
  Explicacion: situation.reasons.map((reason) => reason.text).join('\n'),
  Registros_Relacionados: situation.records.map((record) => `${record.module}:${record.id}`),
});
