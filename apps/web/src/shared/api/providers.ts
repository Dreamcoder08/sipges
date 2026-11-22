import { AuthProviders } from '@sipges/contracts';
import { queryOptions } from '@tanstack/react-query';
import { requestJson } from './client.ts';

/**
 * What this API offers beyond password sign-in: Google sign-in and, on the Go API only, changing a
 * password (world-class-local T8). A failure just hides those options.
 */
export const providersQuery = queryOptions({
  queryKey: ['auth', 'providers'],
  queryFn: ({ signal }) => requestJson('/system/auth/providers', AuthProviders, { signal }),
  staleTime: Number.POSITIVE_INFINITY,
  retry: false,
});
