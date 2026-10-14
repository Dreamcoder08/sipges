import { Timeline } from '@mascli/contracts';
import { queryOptions } from '@tanstack/react-query';
import { requestJson } from '../../shared/api/client.ts';

export const timelineQuery = (
  scope: string,
  from: string,
  to: string,
  modules: readonly string[],
) =>
  queryOptions({
    queryKey: ['records', scope, 'timeline', from, to, modules.join(',')],
    queryFn: ({ signal }) => {
      const params = new URLSearchParams({ from, to, limit: '500' });
      if (modules.length) params.set('modules', modules.join(','));
      return requestJson(`/system/timeline?${params}`, Timeline, { scope, signal });
    },
  });
