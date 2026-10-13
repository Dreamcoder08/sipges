import { DashboardResponse, IrsaSummary, ModelStatus } from '@mascli/contracts';
import { queryOptions } from '@tanstack/react-query';
import { z } from 'zod';
import { requestJson } from '../../shared/api/client.ts';

/** A module record as `/api/{module}` lists it: free-form payload plus `_id`. */
const ModuleRecord = z.looseObject({ _id: z.string() });
export type ModuleRecord = z.infer<typeof ModuleRecord>;

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

/** Every record of a module the API returns (at most 500, its upper bound). */
export const moduleRecordsQuery = (slug: 'alertas' | 'eventos', scope: string) =>
  queryOptions({
    queryKey: ['records', scope, slug, 'all'],
    queryFn: ({ signal }) =>
      requestJson(`/api/${slug}?limit=-1`, z.array(ModuleRecord), { scope, signal }),
  });
