import {
  AccountList,
  DashboardResponse,
  IrsaConfig,
  IrsaSummary,
  ModelStatus,
  RecordsSummary,
} from '@sipges/contracts';
import { queryOptions } from '@tanstack/react-query';
import { moduleRecordsQuery as recordsQuery } from '../../shared/api/module-records.ts';
import { requestJson } from '../../shared/api/client.ts';

/** A module record as `/api/{module}` lists it: free-form payload plus `_id`. */
export type { ModuleRecord } from '@sipges/contracts';

export const dashboardQuery = (scope: string) =>
  queryOptions({
    queryKey: ['dashboard', scope, 'summary'],
    queryFn: ({ signal }) => requestJson('/api/dashboard', DashboardResponse, { scope, signal }),
  });

export const irsaQuery = (scope: string) =>
  queryOptions({
    queryKey: ['indicators', scope, 'irsa-summary'],
    queryFn: ({ signal }) => requestJson('/system/irsa', IrsaSummary, { scope, signal }),
  });

export const irsaConfigQuery = (scope: string) =>
  queryOptions({
    queryKey: ['indicators', scope, 'irsa-config'],
    queryFn: ({ signal }) => requestJson('/system/irsa/config', IrsaConfig, { scope, signal }),
  });

export const modelStatusQuery = (scope: string) =>
  queryOptions({
    queryKey: ['indicators', scope, 'model-status'],
    queryFn: ({ signal }) => requestJson('/system/model-status', ModelStatus, { scope, signal }),
    staleTime: Infinity,
  });

/** Every scoped record, retrieved through bounded API pages, in the cache entry the map shares. */
export const moduleRecordsQuery = (slug: 'alertas' | 'eventos', scope: string) =>
  recordsQuery(slug, scope);

/**
 * The project's record counts per type, from one row of Registros' summary: the counts are the
 * project's totals whatever the page. Under `records`, so a new or imported record refreshes it.
 */
export const recordCountsQuery = (scope: string) =>
  queryOptions({
    queryKey: ['records', scope, 'counts'],
    queryFn: async ({ signal }) =>
      (
        await requestJson('/api/registros/summary?limit=1&offset=0', RecordsSummary, {
          scope,
          signal,
        })
      ).counts,
  });

/** The installation's accounts, admins only; the same cache entry as Administración's list. */
export const accountsQuery = (scope: string) =>
  queryOptions({
    queryKey: ['administration', scope, 'accounts'],
    queryFn: ({ signal }) => requestJson('/system/auth/accounts', AccountList, { scope, signal }),
  });
