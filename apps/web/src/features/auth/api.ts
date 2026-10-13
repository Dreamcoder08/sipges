import { LoginResponse, type LoginForm, Me } from '@mascli/contracts';
import { queryOptions } from '@tanstack/react-query';
import { request, requestJson } from '../../shared/api/client.ts';

export const meQuery = queryOptions({
  queryKey: ['auth', 'me'],
  queryFn: ({ signal }) => requestJson('/system/auth/me', Me, { signal }),
  staleTime: 60_000,
});

export const login = (form: LoginForm) =>
  requestJson('/login', LoginResponse, { method: 'POST', body: { form } });

export const logout = () => request('/logout', { method: 'POST' });
