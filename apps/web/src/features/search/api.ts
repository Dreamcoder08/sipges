import { SearchResults } from '@mascli/contracts';
import { queryOptions } from '@tanstack/react-query';
import { requestJson } from '../../shared/api/client.ts';

export const searchQuery = (scope: string, q: string) =>
  queryOptions({
    queryKey: ['records', scope, 'search', q],
    queryFn: ({ signal }) =>
      requestJson(`/system/search?${new URLSearchParams({ q, limit: '20' })}`, SearchResults, {
        scope,
        signal,
      }),
    enabled: q.trim().length > 0,
    staleTime: 10_000,
  });
