import type { RecordModule } from '../modules.ts';

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
