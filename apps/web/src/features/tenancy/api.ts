import { CurrentScope, ScopeSummary } from '@mascli/contracts';
import { queryOptions } from '@tanstack/react-query';
import { z } from 'zod';
import { request, requestJson } from '../../shared/api/client.ts';

export const scopeKey = (scope: Pick<ScopeSummary, 'company_id' | 'project_id'>) =>
  `${scope.company_id}/${scope.project_id}`;

export const scopesQuery = queryOptions({
  queryKey: ['tenancy', 'scopes'],
  queryFn: ({ signal }) => requestJson('/system/auth/scopes', z.array(ScopeSummary), { signal }),
  staleTime: 60_000,
});

/** Fails with 403 while the user has several projects and none is selected. */
export const currentScopeQuery = queryOptions({
  queryKey: ['tenancy', 'current'],
  queryFn: ({ signal }) => requestJson('/system/auth/current-scope', CurrentScope, { signal }),
  staleTime: 60_000,
  retry: false,
});

/** The server keeps the active project in an HttpOnly cookie (ADR 0006, ADR 0008 #6). */
export const selectProject = (scope: string) =>
  request('/select-project', { method: 'POST', body: { form: { scope } }, redirect: 'manual' });
