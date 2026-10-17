import { GeographyQuery, type GeographyCatalogue, type GeographyResult } from '@mascli/contracts';
import type { Scope } from '../../tenancy/application/index.ts';
import { relateRecords, type GeographyRecords } from './relations.ts';
export type GeographyGateway = {
  catalogue(): Promise<GeographyCatalogue>;
  query(input: GeographyQuery): Promise<Pick<GeographyResult, 'features' | 'truncated' | 'source'>>;
};
export type GeographyRecordReader = {
  read(scope: Scope, modules: readonly string[]): Promise<GeographyRecords>;
};
export const createGeographyService = ({
  reader,
  gateway,
}: {
  reader: GeographyRecordReader;
  gateway: GeographyGateway;
}) => ({
  catalogue: gateway.catalogue,
  async query(scope: Scope, raw: unknown) {
    const input = GeographyQuery.parse(raw);
    const official = await gateway.query(input);
    const relations = input.polygon
      ? relateRecords(
          await reader.read(scope, ['Eventos', 'Demandas', 'Actores', 'Narrativas', 'Reportes']),
          input.polygon,
          input.concessionCode,
        )
      : { related: [], unlocated: [] };
    return { ...official, ...relations };
  },
});
export type GeographyService = ReturnType<typeof createGeographyService>;
