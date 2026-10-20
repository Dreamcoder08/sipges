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
  marking: z.enum(['publico', 'interno', 'restringido']),
  fields: z.record(z.string(), z.string()),
});
export type ObjectSummary = z.infer<typeof ObjectSummary>;

const EvidenceRef = RecordRef.extend({ module: z.literal('fuentes') });

export const LinkEvidenceIn = z.object({ evidence: EvidenceRef.nullable() });
export type LinkEvidenceIn = z.infer<typeof LinkEvidenceIn>;

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
  evidence: ObjectSummary.nullable().default(null),
  evidence_status: z.enum(['available', 'unavailable', 'undocumented']).default('undocumented'),
});
export type LinkEdge = z.input<typeof LinkEdge>;

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
  evidence: EvidenceRef.nullable().optional(),
});
export type LinkIn = z.infer<typeof LinkIn>;

export const LinkCreated = z.object({ ok: z.literal(true), id: z.number().int() });
export type LinkCreated = z.infer<typeof LinkCreated>;

/**
 * POST /system/graph/neighbourhood (ODD territorial-operations): the joint neighbourhood of
 * several records. `hops` lists the link types each hop follows (at most two hops); `fields`
 * adds payload fields to each node's summary.
 */
export const NeighbourhoodIn = z.object({
  seeds: z.array(RecordRef).min(1).max(100),
  hops: z
    .array(z.array(z.string().min(1).max(40)).min(1).max(20))
    .min(1)
    .max(2),
  fields: z.array(z.string().min(1).max(60)).max(24).default([]),
});
export type NeighbourhoodIn = z.input<typeof NeighbourhoodIn>;

export const RecordNeighbourhood = z.object({
  /** Seeds that exist and are visible to the caller. */
  seeds: z.array(RecordRef),
  nodes: z.array(ObjectSummary),
  edges: z.array(LinkEdge),
  truncated: z.boolean(),
});
export type RecordNeighbourhood = z.infer<typeof RecordNeighbourhood>;

/** GET /system/graph?module=&id=&depth= */
export const RecordGraph = z.object({
  root: RecordRef,
  nodes: z.array(ObjectSummary),
  edges: z.array(LinkEdge),
  truncated: z.boolean(),
});
export type RecordGraph = z.infer<typeof RecordGraph>;

/** GET /system/search?q=&modules=&limit= (docs/adr/0011 §5). */
export const SearchResults = z.object({
  query: z.string(),
  hits: z.array(
    ObjectSummary.extend({
      match: z.object({ field: z.string(), excerpt: z.string() }).nullable(),
      /** Found (also) by meaning; absent from servers without hybrid search. */
      semantic: z.boolean().optional(),
    }),
  ),
});
export type SearchResults = z.infer<typeof SearchResults>;

/** PUT /system/marking (docs/adr/0012). */
export const MarkingIn = z.object({
  module: z.string().min(1).max(40),
  id: z.string().min(1).max(200),
  marking: z.enum(['publico', 'interno', 'restringido']),
});
export type MarkingIn = z.infer<typeof MarkingIn>;

const BriefingSentence = z.object({ text: z.string(), refs: z.array(z.number().int()) });

/** GET /system/briefing (docs/adr/0013): extractive briefing with numbered citations. */
export const Briefing = z.object({
  subject: ObjectSummary,
  generated_at: z.string(),
  engine: z.enum(['extractivo', 'asistido']),
  narrator: z.string().nullable(),
  notice: z.string().nullable(),
  narrative: BriefingSentence.nullable(),
  sections: z.array(z.object({ title: z.string(), sentences: z.array(BriefingSentence) })),
  sources: z.array(
    z.object({
      ref: z.number().int(),
      module: z.string(),
      id: z.string(),
      type_label: z.string(),
      title: z.string(),
    }),
  ),
});
export type Briefing = z.infer<typeof Briefing>;

const ProposalRef = z.object({ module: z.string(), id: z.string() });

/** GET /system/briefing/proposals (docs/adr/0014 §8): actions a person may approve. */
export const AnalystProposal = z.object({
  fingerprint: z.string(),
  kind: z.enum(['link', 'record']),
  title: z.string(),
  reason: z.string(),
  link: z.object({ link_type: z.string(), source: ProposalRef, target: ProposalRef }).nullable(),
  record: z.object({ module: z.string(), payload: z.record(z.string(), z.string()) }).nullable(),
});
export type AnalystProposal = z.infer<typeof AnalystProposal>;
export const AnalystProposals = z.array(AnalystProposal);

/** POST /system/briefing/proposals: approve applies the action, reject only records it. */
export const ProposalDecisionIn = z.object({
  module: z.string().min(1).max(40),
  id: z.string().min(1).max(200),
  fingerprint: z.string().min(1).max(500),
  decision: z.enum(['approve', 'reject']),
});
export type ProposalDecisionIn = z.infer<typeof ProposalDecisionIn>;
export const ProposalDecisionOut = z.object({ ok: z.literal(true), result: z.string().nullable() });

/** GET /system/timeline (docs/adr/0011 §7): dated records across object types. */
export const Timeline = z.object({
  from: z.string(),
  to: z.string(),
  entries: z.array(ObjectSummary),
  truncated: z.boolean(),
});
export type Timeline = z.infer<typeof Timeline>;
