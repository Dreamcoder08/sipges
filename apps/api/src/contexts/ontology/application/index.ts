// Public API of the Ontology context (docs/adr/0011).
export {
  INFERENCE_RULES,
  LINK_TYPES,
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
  type Edge,
  type Neighbour,
  type ObjectSummary,
  type OntologyService,
  createOntologyService,
  summarize,
} from './ontology-service.ts';
