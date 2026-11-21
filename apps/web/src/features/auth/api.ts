import { AuthProviders, LoginResponse, type LoginForm, Me } from '@sipges/contracts';
import { queryOptions } from '@tanstack/react-query';
import { request, requestJson } from '../../shared/api/client.ts';
import { forgetSavedConversations } from '../../shared/lib/saved-conversations.ts';

export const meQuery = queryOptions({
  queryKey: ['auth', 'me'],
  queryFn: ({ signal }) => requestJson('/system/auth/me', Me, { signal }),
  staleTime: 60_000,
});

export const login = (form: LoginForm) =>
  requestJson('/login', LoginResponse, { method: 'POST', body: { form } });

/** Signs out, and forgets every conversation saved in this browser (chat-first-ui T11). */
export const logout = () => {
  forgetSavedConversations();
  return request('/logout', { method: 'POST' });
};

/** Optional sign-in methods; a failure just hides them (password sign-in still works). */
export const providersQuery = queryOptions({
  queryKey: ['auth', 'providers'],
  queryFn: ({ signal }) => requestJson('/system/auth/providers', AuthProviders, { signal }),
  staleTime: Number.POSITIVE_INFINITY,
  retry: false,
});
