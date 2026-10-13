import { DashboardResponse, IrsaSummary, ModelStatus } from '@mascli/contracts';
import { queryOptions } from '@tanstack/react-query';
import { z } from 'zod';
import { requestJson } from '../../shared/api/client.ts';

/** A module record as `/api/{module}` lists it: free-form payload plus `_id`. */
const ModuleRecord = z.looseObject({ _id: z.string() });
export type ModuleRecord = z.infer<typeof ModuleRecord>;

export const dashboardQuery = queryOptions({
  queryKey: ['dashboard', 'summary'],
  queryFn: ({ signal }) => requestJson('/api/dashboard', DashboardResponse, { signal }),
});

export const irsaQuery = queryOptions({
  queryKey: ['indicators', 'irsa'],
  queryFn: ({ signal }) => requestJson('/system/irsa', IrsaSummary, { signal }),
});

export const modelStatusQuery = queryOptions({
  queryKey: ['indicators', 'model-status'],
  queryFn: ({ signal }) => requestJson('/system/model-status', ModelStatus, { signal }),
  staleTime: Infinity,
});

/** Every record of a module the API returns (at most 500, its upper bound). */
export const moduleRecordsQuery = (slug: 'alertas' | 'eventos') =>
  queryOptions({
    queryKey: ['records', slug, 'all'],
    queryFn: ({ signal }) =>
      requestJson(`/api/${slug}?limit=-1`, z.array(ModuleRecord), { signal }),
  });
