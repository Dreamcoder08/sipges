import type { CanonicalEntities, ProjectCoordinates } from '@mascli/contracts';
import type { Scope } from '../../tenancy/application/index.ts';
export type ReferenceReader = {
  coordinates(scope: Scope): Promise<ProjectCoordinates | null>;
  entities(scope: Scope): Promise<CanonicalEntities | null>;
};
export const createReferenceService = (reader: ReferenceReader) => ({
  coordinates: async (scope: Scope) => {
    const data = await reader.coordinates(scope);
    return {
      available: data !== null,
      data,
      notice: data
        ? data.source.scope
        : 'No hay geometría de referencia registrada para este proyecto.',
    };
  },
  entities: async (scope: Scope) => {
    const data = await reader.entities(scope);
    return {
      available: data !== null,
      data,
      notice: 'Las denominaciones canónicas no reescriben los textos de las fuentes originales.',
    };
  },
});
export type ReferenceService = ReturnType<typeof createReferenceService>;
