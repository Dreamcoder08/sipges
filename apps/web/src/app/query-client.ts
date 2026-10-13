import { MutationCache, QueryCache, QueryClient } from '@tanstack/react-query';
import { isApiError, isMfaRequired } from '../shared/api/client.ts';

declare module '@tanstack/react-query' {
  interface Register {
    mutationMeta: { public?: boolean };
  }
}

/**
 * Server state lives in TanStack Query (ADR 0006). A 401 anywhere means the session ended:
 * the cache is dropped and `onSessionEnded` sends the user to sign in. Sign-in and sign-out
 * mutations are marked `public` because their 401 is an answer, not an expired session.
 */
export const createQueryClient = (
  onSessionEnded: () => void,
  onMfaRequired: () => void = () => {},
) => {
  const client: QueryClient = new QueryClient({
    queryCache: new QueryCache({
      onError: (error) => {
        if (isMfaRequired(error)) onMfaRequired();
        if (isApiError(error, 401)) onSessionEnded();
      },
    }),
    mutationCache: new MutationCache({
      onError: (error, _vars, _ctx, mutation) => {
        if (isMfaRequired(error) && !mutation.meta?.public) onMfaRequired();
        if (isApiError(error, 401) && !mutation.meta?.public) onSessionEnded();
      },
    }),
    defaultOptions: {
      queries: {
        staleTime: 15_000,
        refetchOnWindowFocus: false,
        retry: (count, error) => !(isApiError(error) && error.status < 500) && count < 2,
      },
    },
  });
  return client;
};
