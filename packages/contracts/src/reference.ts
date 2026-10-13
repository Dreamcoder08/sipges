import { z } from 'zod';
const Point = z.tuple([z.number().finite(), z.number().finite()]);
const Bounds = z.tuple([
  z.number().finite(),
  z.number().finite(),
  z.number().finite(),
  z.number().finite(),
]);
export const ProjectCoordinates = z.object({
  project_id: z.string(),
  project_name: z.string(),
  initiative: z.string(),
  description: z.string(),
  crs: z.object({
    geometry: z.literal('EPSG:4326'),
    label: z.string(),
    projected_reference: z.string(),
    axis_order: z.string(),
  }),
  source: z.object({
    organization: z.string(),
    service: z.string(),
    dataset: z.string(),
    consulted_on: z.string(),
    scope: z.string(),
  }),
  nominal_area_source: z.object({ label: z.string(), scope: z.string() }),
  bbox: Bounds,
  summary: z.object({
    concession_count: z.number(),
    nominal_area_total_ha: z.number(),
    gis_area_total_ha: z.number(),
  }),
  concessions: z.array(
    z.object({
      code: z.string(),
      name: z.string(),
      nominal_area_ha: z.number(),
      gis_area_ha: z.number(),
      substance: z.string(),
      holder: z.string(),
      department: z.string(),
      province: z.string(),
      district: z.string(),
      mining_zone: z.string(),
      centroid: z.object({ longitude: z.number(), latitude: z.number(), method: z.string() }),
      bbox: Bounds,
      geometry: z.object({
        type: z.literal('Polygon'),
        coordinates: z.array(z.array(Point).min(4)).min(1),
      }),
    }),
  ),
});
export type ProjectCoordinates = z.infer<typeof ProjectCoordinates>;
export const CanonicalEntities = z.record(
  z.string(),
  z.object({
    canonical_name: z.string(),
    short_name: z.string(),
    entity_type: z.string(),
    territory: z.string(),
    note: z.string(),
  }),
);
export type CanonicalEntities = z.infer<typeof CanonicalEntities>;
export const ProjectCoordinatesResponse = z.object({
  available: z.boolean(),
  data: ProjectCoordinates.nullable(),
  notice: z.string(),
});
export const CanonicalEntitiesResponse = z.object({
  available: z.boolean(),
  data: CanonicalEntities.nullable(),
  notice: z.string(),
});
