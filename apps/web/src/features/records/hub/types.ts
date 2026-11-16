import { MODULES, type RecordModule } from '../modules.ts';

/** The record types the hub lists, in the order of the chips. */
export const HUB_TYPES = [
  ['eventos', 'Eventos'],
  ['actores', 'Actores'],
  ['directorio', 'Directorio territorial'],
  ['demandas', 'Demandas'],
  ['narrativas', 'Narrativas'],
  ['fuentes', 'Fuentes'],
  ['buzon', 'Buzón'],
] as const satisfies readonly (readonly [RecordModule, string])[];

/** Types the hub lists under another type's tab: Demandas shows Compromisos as a sub-list. */
export const HUB_SUBTYPES = ['compromisos'] as const satisfies readonly RecordModule[];

/** The name the hub gives a record type: its chip label, else the module's own label. */
export const typeLabel = (module: RecordModule): string =>
  HUB_TYPES.find(([type]) => type === module)?.[1] ?? MODULES[module].label;
