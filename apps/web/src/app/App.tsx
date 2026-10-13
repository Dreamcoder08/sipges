import { QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider } from '@tanstack/react-router';
import { useState } from 'react';
import { createQueryClient } from './query-client.ts';
import { createAppRouter } from './router.tsx';
import './styles/global.css';

/** Wires server state and routing; a 401 from any query returns the user to sign in. */
export const App = () => {
  const [{ router, queryClient }] = useState(() => {
    const holder: { router?: ReturnType<typeof createAppRouter> } = {};
    const queryClient = createQueryClient(
      () => {
        queryClient.clear();
        const current = holder.router?.state.location.href ?? '/';
        if (!current.startsWith('/login')) {
          void holder.router?.navigate({ to: '/login', search: { redirect: current } });
        }
      },
      () => {
        if (holder.router?.state.location.pathname !== '/mfa') {
          queryClient.clear();
          void holder.router?.navigate({ to: '/mfa' });
        }
      },
    );
    holder.router = createAppRouter(queryClient);
    return { router: holder.router, queryClient };
  });
  return (
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  );
};
