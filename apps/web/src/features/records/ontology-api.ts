import {
  LinkCreated,
  type LinkIn,
  OkResponse,
  OntologyCatalog,
  RecordGraph,
  RecordLinks,
} from '@mascli/contracts';
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

export const deleteLink = (scope: string, id: number) =>
  requestJson(`/system/links/${id}`, OkResponse, { method: 'DELETE', scope });
