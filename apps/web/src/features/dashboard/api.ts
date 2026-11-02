import { DashboardResponse, IrsaSummary, ModelStatus } from '@sipges/contracts';
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

export const modelStatusQuery = (scope: string) =>
  queryOptions({
    queryKey: ['indicators', scope, 'model-status'],
    queryFn: ({ signal }) => requestJson('/system/model-status', ModelStatus, { scope, signal }),
    staleTime: Infinity,
  });

/** Every scoped record, retrieved through bounded API pages, in the cache entry the map shares. */
export const moduleRecordsQuery = (slug: 'alertas' | 'eventos', scope: string) =>
  recordsQuery(slug, scope);
