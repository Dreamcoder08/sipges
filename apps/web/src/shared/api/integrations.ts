import {
  AuthorizedSourcesCatalog,
  GeographyCatalogue,
  MediaMonitorState,
  PushConfig,
} from '@sipges/contracts';
import { queryOptions } from '@tanstack/react-query';
import { requestJson } from './client.ts';

/**
 * Reads of the sources the project can connect, for the Integraciones page. The query keys are
 * those of the screens that manage each source, so both share one cache entry.
 */
export const mediaFeedsQuery = (scope: string) =>
  queryOptions({
    queryKey: ['media-monitor', scope],
    queryFn: ({ signal }) => requestJson('/system/v4/media', MediaMonitorState, { scope, signal }),
  });

export const authorizedSourcesQuery = (scope: string) =>
  queryOptions({
    queryKey: ['authorized-sources', scope],
    queryFn: ({ signal }) =>
      requestJson('/system/intelligence/sources', AuthorizedSourcesCatalog, { scope, signal }),
  });

export const geographyCatalogueQuery = (scope: string) =>
  queryOptions({
    queryKey: ['geocatmin-catalogue', scope],
    queryFn: ({ signal }) =>
      requestJson('/system/geography/catalogue', GeographyCatalogue, { scope, signal }),
  });

export const pushConfigQuery = (scope: string) =>
  queryOptions({
    queryKey: ['push-config'],
    queryFn: ({ signal }) =>
      requestJson('/system/notifications/push', PushConfig, { scope, signal }),
    staleTime: Infinity,
  });
