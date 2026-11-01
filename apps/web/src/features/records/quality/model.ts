import type { Attachment, ModuleRecord } from '@sipges/contracts';
import { foldText } from '../../../shared/lib/text.ts';
import { actorGroups, actorName, positionTone } from '../insights/actor-map.ts';
import { alertTerritory, MISSING_TERRITORY, recordedLevel } from '../insights/alert-heatmap.ts';
import type { RecordModule } from '../modules.ts';

export const QUALITY_MODULES = [
  'actores',
  'alertas',
  'eventos',
  'demandas',
  'acciones',
  'compromisos',
  'fuentes',
] as const;
export type QualityModule = (typeof QUALITY_MODULES)[number];
export type QualityData = Readonly<Record<QualityModule, readonly ModuleRecord[]>>;
export type QualityIssue = {
  module: RecordModule;
  id: string;
  title: string;
  field: string;
  reason: string;
};
const text = (value: unknown) => (typeof value === 'string' ? value.trim() : '');
export const recordTitle = (module: RecordModule, row: ModuleRecord) =>
  module === 'actores'
    ? actorName(row)
    : text(
        row.Archivo_Fuente ||
          row.Causa ||
          row.Descripcion_Hecho ||
          row.Descripcion ||
          row.Accion ||
          row.Tema,
      ) || row._id;
const unconfirmed = (value: unknown) =>
  !text(value) ||
  ['por evaluar', 'por verificar', 'no determinado', 'otro / por verificar'].includes(
    foldText(text(value)),
  );

/** Review prompts, not validation scores or automatic modifications of business records. */
export const qualityIssues = (data: QualityData): QualityIssue[] => {
  const issues: QualityIssue[] = [];
  const add = (module: RecordModule, row: ModuleRecord, field: string, reason: string) =>
    issues.push({ module, id: row._id, title: recordTitle(module, row), field, reason });
  const sources = new Map<string, number>();
  for (const source of data.fuentes)
    for (const ref of new Set([source._id, text(source.ID_Fuente)].filter(Boolean)))
      sources.set(ref, (sources.get(ref) ?? 0) + 1);
  for (const row of data.actores) {
    if (unconfirmed(row.Tipo_Actor))
      add('actores', row, 'Tipo_Actor', 'Tipo de actor pendiente de verificar');
    if (!text(row.Territorio)) add('actores', row, 'Territorio', 'Sin territorio registrado');
    if (actorGroups([row])[0]?.band === null)
      add('actores', row, 'Influencia', 'Influencia no clasificable en los anillos actuales');
    if (positionTone(row.Posicion_Proyecto) === 'unknown')
      add(
        'actores',
        row,
        'Posicion_Proyecto',
        'Posición sin clasificación explícita; conservar el valor hasta verificar',
      );
  }
  for (const row of data.alertas) {
    if (alertTerritory(row, data.eventos) === MISSING_TERRITORY)
      add('alertas', row, 'Territorio', MISSING_TERRITORY);
    if (!/^([GADNEI])(?:$|\s*[-–—]\s*)/.test(text(row.Dimension).toUpperCase()))
      add('alertas', row, 'Dimension', 'Dimensión no clasificable');
    if (!recordedLevel(row)) add('alertas', row, 'Nivel_Preliminar', 'Nivel no clasificable');
  }
  for (const module of QUALITY_MODULES) {
    if (module === 'fuentes') continue;
    for (const row of data[module]) {
      const ref = text(row.Fuente_ID);
      if (!ref) add(module, row, 'Fuente_ID', 'Sin referencia de fuente');
      else if (sources.get(ref) !== 1)
        add(
          module,
          row,
          'Fuente_ID',
          'La referencia no identifica una fuente accesible de forma unívoca',
        );
    }
  }
  return issues;
};

export const sourceInventory = (
  sources: readonly ModuleRecord[],
  files: readonly Attachment[],
  limited: boolean,
) =>
  sources.map((source) => {
    const associated = files.filter(
      (file) => file.linked_module === 'fuentes' && file.linked_record_id === source._id,
    );
    return {
      id: source._id,
      title: recordTitle('fuentes', source),
      files: associated,
      status: associated.length
        ? 'Metadatos disponibles; abrir para comprobar el archivo'
        : limited
          ? 'Asociación no comprobada: inventario limitado'
          : 'Sin archivo asociado',
    };
  });
