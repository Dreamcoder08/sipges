// Public API of the Ontology context (docs/adr/0011).
export {
  INFERENCE_RULES,
  LINK_TYPES,
  MARKINGS,
  type Marking,
  OBJECT_TYPES,
  type LinkType,
  type ObjectType,
  objectTypeForModule,
  objectTypeForSlug,
  titleOf,
} from '../domain/catalog.ts';
export type { NodeRef, NodeRow, OntologyStore } from './ports.ts';
export {
  MAX_GRAPH_DEPTH,
  MAX_GRAPH_NODES,
  MAX_MENTIONS,
  type Mention,
  MAX_SEARCH_RESULTS,
  MAX_TIMELINE_RESULTS,
  type SearchHit,
  type Edge,
  type Neighbour,
  type ObjectSummary,
  type OntologyService,
  createOntologyService,
  summarize,
} from './ontology-service.ts';
