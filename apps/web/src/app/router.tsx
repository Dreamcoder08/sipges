import { type QueryClient, useQuery } from '@tanstack/react-query';
import {
  Link,
  Outlet,
  createRootRouteWithContext,
  createRoute,
  createRouter,
  redirect,
  useNavigate,
  useRouter,
} from '@tanstack/react-router';
import { z } from 'zod';
import { RecordsPage } from '../features/records/index.ts';
import { DashboardPage } from '../features/dashboard/index.ts';
import { LoginPage, UserMenu, meQuery } from '../features/auth/index.ts';
import {
  ProjectSwitcher,
  SelectProjectPage,
  currentScopeQuery,
  scopesQuery,
} from '../features/tenancy/index.ts';
import { isApiError } from '../shared/api/client.ts';
import { Card } from '../shared/ui/Card.tsx';
import { AppShell } from './layout/AppShell.tsx';
import { PendingScreen } from './layout/PendingScreen.tsx';
import { SCREENS, type ScreenPath, safeRedirect } from './navigation.ts';

type RouterContext = { queryClient: QueryClient };

const rootRoute = createRootRouteWithContext<RouterContext>()({
  component: Outlet,
  notFoundComponent: () => (
    <Card title="Página no encontrada">
      <p>
        La dirección no existe. <Link to="/">Volver al dashboard</Link>
      </p>
    </Card>
  ),
});

const loginRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/login',
  validateSearch: z.object({ redirect: z.string().optional() }),
  component: function LoginRoute() {
    const { queryClient } = loginRoute.useRouteContext();
    const search = loginRoute.useSearch();
    const router = useRouter();
    return (
      <LoginPage
        onSignedIn={async () => {
          queryClient.clear();
          await router.navigate({ href: safeRedirect(search.redirect), replace: true });
        }}
      />
    );
  },
});

const requireSession = async (queryClient: QueryClient, href: string) => {
  const me = await queryClient.fetchQuery(meQuery);
  if (!me) throw redirect({ to: '/login', search: { redirect: href } });
  return me;
};

const selectProjectRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/proyecto',
  beforeLoad: async ({ context, location }) => ({
    me: await requireSession(context.queryClient, location.href),
  }),
  component: function SelectProjectRoute() {
    const { queryClient } = selectProjectRoute.useRouteContext();
    const navigate = useNavigate();
    return (
      <SelectProjectPage
        onSelected={async () => {
          await queryClient.invalidateQueries();
          await navigate({ to: '/' });
        }}
      />
    );
  },
});

/** Every signed-in screen: needs a session and an active project. */
const appRoute = createRoute({
  getParentRoute: () => rootRoute,
  id: 'app',
  beforeLoad: async ({ context, location }) => {
    const me = await requireSession(context.queryClient, location.href);
    try {
      // fetchQuery refetches once invalidated, e.g. after a project switch.
      const scope = await context.queryClient.fetchQuery(currentScopeQuery);
      return { me, scope };
    } catch (error) {
      if (isApiError(error, 403)) throw redirect({ to: '/proyecto' });
      throw error;
    }
  },
  component: function AppLayout() {
    const { me, scope, queryClient } = appRoute.useRouteContext();
    const router = useRouter();
    const scopes = queryClient.getQueryData(scopesQuery.queryKey);
    const label = scopes?.find((s) => `${s.company_id}/${s.project_id}` === scope.scope)?.label;
    return (
      <AppShell
        projectLabel={label || scope.project_id}
        projectSwitcher={
          <ProjectSwitcher
            current={scope}
            onSwitched={async () => {
              await queryClient.invalidateQueries();
              await router.invalidate();
            }}
          />
        }
        userMenu={
          <UserMenu
            me={me}
            onSignedOut={async () => {
              queryClient.clear();
              await router.navigate({ to: '/login', search: {} });
            }}
          />
        }
      >
        <Outlet />
      </AppShell>
    );
  },
});

const isScreen = (to: string): to is ScreenPath => SCREENS.some((s) => s.path === to);

const dashboardRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/',
  component: function DashboardRoute() {
    const { scope } = appRoute.useRouteContext();
    return (
      <DashboardPage
        projectId={scope.project_id}
        renderLink={(to, children) => <Link to={isScreen(to) ? to : '/'}>{children}</Link>}
      />
    );
  },
});

const recordModules = [
  'eventos',
  'actores',
  'directorio',
  'demandas',
  'narrativas',
  'fuentes',
] as const;
const recordRoutes = recordModules.map((module) =>
  createRoute({
    getParentRoute: () => appRoute,
    path: `/${module}`,
    component: function RecordsRoute() {
      const { scope, me } = appRoute.useRouteContext();
      const grantedScopes = useQuery(scopesQuery);
      const label = grantedScopes.data?.find(
        (item) => `${item.company_id}/${item.project_id}` === scope.scope,
      )?.label;
      return (
        <RecordsPage
          key={`${scope.scope}/${module}`}
          module={module}
          scope={scope.scope}
          projectId={scope.project_id}
          projectLabel={label ?? ''}
          role={me.role}
        />
      );
    },
  }),
);

const pendingRoutes = SCREENS.filter(
  (screen) => screen.path !== '/' && !recordModules.some((module) => screen.path === `/${module}`),
).map((screen) =>
  createRoute({
    getParentRoute: () => appRoute,
    path: screen.path,
    component: () => <PendingScreen title={screen.title} />,
  }),
);

const routeTree = rootRoute.addChildren([
  loginRoute,
  selectProjectRoute,
  appRoute.addChildren([dashboardRoute, ...recordRoutes, ...pendingRoutes]),
]);

export const createAppRouter = (queryClient: QueryClient) =>
  createRouter({
    routeTree,
    context: { queryClient },
    defaultPreload: 'intent',
    defaultPendingMs: 300,
  });

declare module '@tanstack/react-router' {
  interface Register {
    router: ReturnType<typeof createAppRouter>;
  }
}
