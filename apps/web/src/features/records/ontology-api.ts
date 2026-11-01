import {
  AnalystProposals,
  Briefing,
  ProposalDecisionOut,
  type ProposalDecisionIn,
  LinkCreated,
  type LinkIn,
  type LinkEvidenceIn,
  type MarkingIn,
  OkResponse,
  OntologyCatalog,
  RecordGraph,
  RecordLinks,
} from '@sipges/contracts';
import { queryOptions } from '@tanstack/react-query';
import { requestJson } from '../../shared/api/client.ts';

export const catalogQuery = queryOptions({
  queryKey: ['ontology', 'catalog'],
  queryFn: ({ signal }) => requestJson('/system/ontology', OntologyCatalog, { signal }),
  staleTime: Infinity,
});

const recordParams = (module: string, id: string) => new URLSearchParams({ module, id });

export const linksQuery = (module: string, id: string, scope: string) =>
  queryOptions({
    queryKey: ['records', scope, 'links', module, id],
    queryFn: ({ signal }) =>
      requestJson(`/system/links?${recordParams(module, id)}`, RecordLinks, { scope, signal }),
  });

export const graphQuery = (module: string, id: string, scope: string, depth: number) =>
  queryOptions({
    queryKey: ['records', scope, 'graph', module, id, depth],
    queryFn: ({ signal }) =>
      requestJson(`/system/graph?${recordParams(module, id)}&depth=${depth}`, RecordGraph, {
        scope,
        signal,
      }),
  });

export const createLink = (scope: string, link: LinkIn) =>
  requestJson('/system/links', LinkCreated, { method: 'POST', scope, body: { json: link } });

export const setLinkEvidence = (scope: string, id: number, body: LinkEvidenceIn) =>
  requestJson(`/system/links/${id}/evidence`, OkResponse, {
    method: 'PUT',
    scope,
    body: { json: body },
  });

export const deleteLink = (scope: string, id: number) =>
  requestJson(`/system/links/${id}`, OkResponse, { method: 'DELETE', scope });

export const setMarking = (scope: string, body: MarkingIn) =>
  requestJson('/system/marking', OkResponse.loose(), {
    method: 'PUT',
    scope,
    body: { json: body },
  });

export const briefingQuery = (module: string, id: string, scope: string) =>
  queryOptions({
    queryKey: ['records', scope, 'briefing', module, id],
    queryFn: ({ signal }) =>
      requestJson(`/system/briefing?${recordParams(module, id)}`, Briefing, { scope, signal }),
    staleTime: 5 * 60_000,
  });

export const proposalsQuery = (module: string, id: string, scope: string) =>
  queryOptions({
    queryKey: ['records', scope, 'proposals', module, id],
    queryFn: ({ signal }) =>
      requestJson(`/system/briefing/proposals?${recordParams(module, id)}`, AnalystProposals, {
        scope,
        signal,
      }),
  });

export const decideProposal = (scope: string, body: ProposalDecisionIn) =>
  requestJson('/system/briefing/proposals', ProposalDecisionOut, {
    method: 'POST',
    scope,
    body: { json: body },
  });
