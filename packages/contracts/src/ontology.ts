import { z } from 'zod';

const RecordRef = z.object({
  module: z.string().min(1).max(40),
  id: z
    .string()
    .min(1)
    .max(200)
    .refine((id) => !id.includes('\u0000'), { message: 'Text must not contain NUL characters' }),
});
export type RecordRef = z.infer<typeof RecordRef>;

/** GET /system/ontology (docs/adr/0011 §1-2). */
export const OntologyCatalog = z.object({
  object_types: z.array(
    z.object({
      module: z.string(),
      label: z.string(),
      title_field: z.string(),
      summary_fields: z.array(z.string()),
      date_field: z.string().nullable(),
    }),
  ),
  link_types: z.array(
    z.object({
      id: z.string(),
      label: z.string(),
      inverse_label: z.string(),
      sources: z.array(z.string()).nullable(),
      targets: z.array(z.string()).nullable(),
      symmetric: z.boolean(),
    }),
  ),
});
export type OntologyCatalog = z.infer<typeof OntologyCatalog>;

/** A record as shown in links, search hits and the graph. */
export const ObjectSummary = z.object({
  module: z.string(),
  id: z.string(),
  type_label: z.string(),
  title: z.string(),
  date: z.string().nullable(),
  fields: z.record(z.string(), z.string()),
});
export type ObjectSummary = z.infer<typeof ObjectSummary>;

export const LinkEdge = z.object({
  id: z.number().int().nullable(),
  link_type: z.string(),
  source: RecordRef,
  target: RecordRef,
  inferred: z.boolean(),
  via: z.string().nullable(),
  note: z.string(),
  created_by: z.string().nullable(),
  created_at: z.string().nullable(),
});
export type LinkEdge = z.infer<typeof LinkEdge>;

/** GET /system/links?module=&id= */
export const RecordLinks = z.object({
  record: ObjectSummary,
  links: z.array(
    z.object({
      edge: LinkEdge,
      direction: z.enum(['out', 'in']),
      label: z.string(),
      other: ObjectSummary,
    }),
  ),
});
export type RecordLinks = z.infer<typeof RecordLinks>;

/** POST /system/links */
export const LinkIn = z.object({
  link_type: z.string().min(1).max(40),
  source: RecordRef,
  target: RecordRef,
  note: z.string().max(500).default(''),
});
export type LinkIn = z.infer<typeof LinkIn>;

export const LinkCreated = z.object({ ok: z.literal(true), id: z.number().int() });
export type LinkCreated = z.infer<typeof LinkCreated>;

/** GET /system/graph?module=&id=&depth= */
export const RecordGraph = z.object({
  root: RecordRef,
  nodes: z.array(ObjectSummary),
  edges: z.array(LinkEdge),
  truncated: z.boolean(),
});
export type RecordGraph = z.infer<typeof RecordGraph>;
