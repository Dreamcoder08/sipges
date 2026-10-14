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
import { lazy, Suspense, useState } from 'react';
import type { FeatureContext } from '../shared/api/feature-context.ts';
import type { RecordModule } from '../features/records/modules.ts';
import { Button } from '../shared/ui/Button.tsx';
import { DashboardPage } from '../features/dashboard/index.ts';
import {
  GoogleSignInError,
  LoginPage,
  UserMenu,
  MfaEnrollmentPage,
  logout,
  meQuery,
} from '../features/auth/index.ts';
import {
  ProjectSwitcher,
  SelectProjectPage,
  currentScopeQuery,
  scopesQuery,
} from '../features/tenancy/index.ts';
import { isApiError, isMfaRequired } from '../shared/api/client.ts';
import { Card } from '../shared/ui/Card.tsx';
import { AppShell } from './layout/AppShell.tsx';

import { SCREENS, type ScreenPath, safeRedirect } from './navigation.ts';

const RecordsPage = lazy(() =>
  import('../features/records/index.ts').then((module) => ({ default: module.RecordsPage })),
);
const IrsaPage = lazy(() =>
  import('../features/indicators/index.ts').then((module) => ({ default: module.IrsaPage })),
);
const ValidationPage = lazy(() =>
  import('../features/indicators/index.ts').then((module) => ({ default: module.ValidationPage })),
);
const MethodologyPage = lazy(() =>
  import('../features/indicators/index.ts').then((module) => ({ default: module.MethodologyPage })),
);
const SituationalPage = lazy(() =>
  import('../features/analysis/index.ts').then((module) => ({ default: module.SituationalPage })),
);
const StrategyPage = lazy(() =>
  import('../features/analysis/index.ts').then((module) => ({ default: module.StrategyPage })),
);
const IntelligencePage = lazy(() =>
  import('../features/operations/index.ts').then((module) => ({
    default: module.IntelligencePage,
  })),
);
const ManagementPage = lazy(() =>
  import('../features/operations/index.ts').then((module) => ({ default: module.ManagementPage })),
);
const AdministrationPage = lazy(() =>
  import('../features/administration/index.ts').then((module) => ({
    default: module.AdministrationPage,
  })),
);
const AuditPage = lazy(() =>
  import('../features/audit/index.ts').then((module) => ({ default: module.AuditPage })),
);
const GeographyPage = lazy(() =>
  import('../features/geography/index.ts').then((module) => ({ default: module.GeographyPage })),
);
const TerritorialMapPage = lazy(() =>
  import('../features/geography/index.ts').then((module) => ({
    default: module.TerritorialMapPage,
  })),
);

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
  validateSearch: z.object({
    redirect: z.string().optional(),
    google: GoogleSignInError.optional().catch(undefined),
  }),
  component: function LoginRoute() {
    const { queryClient } = loginRoute.useRouteContext();
    const search = loginRoute.useSearch();
    const router = useRouter();
    return (
      <LoginPage
        googleError={search.google}
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

const mfaRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/mfa',
  beforeLoad: async ({ context, location }) => ({
    me: await requireSession(context.queryClient, location.href),
  }),
  component: function MfaRoute() {
    const { queryClient } = mfaRoute.useRouteContext();
    const router = useRouter();
    return (
      <MfaEnrollmentPage
        onEnabled={async () => {
          queryClient.clear();
          await router.invalidate();
          await router.navigate({ to: '/' });
        }}
        onSignOut={async () => {
          await logout();
          queryClient.clear();
          await router.navigate({ to: '/login', search: {} });
        }}
      />
    );
  },
});

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
      if (isMfaRequired(error)) throw redirect({ to: '/mfa' });
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
        <Suspense fallback={<p role="status">Cargando sección…</p>}>
          <Outlet />
        </Suspense>
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
        key={scope.scope}
        scope={scope.scope}
        projectId={scope.project_id}
        renderLink={(to, children) => <Link to={isScreen(to) ? to : '/'}>{children}</Link>}
      />
    );
  },
});

const useFeatureContext = (): FeatureContext => {
  const { scope, me } = appRoute.useRouteContext();
  const grantedScopes = useQuery(scopesQuery);
  const label = grantedScopes.data?.find(
    (item) => `${item.company_id}/${item.project_id}` === scope.scope,
  )?.label;
  return {
    scope: scope.scope,
    projectId: scope.project_id,
    projectLabel: label ?? '',
    role: me.role,
    username: me.username,
    fullName: me.full_name,
  };
};
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
      const context = useFeatureContext();
      return <RecordsPage key={`${context.scope}/${module}`} module={module} {...context} />;
    },
  }),
);
const AlertsPage = (context: FeatureContext) => {
  const [module, setModule] = useState<RecordModule>('alertas');
  return (
    <>
      <div aria-label="Alertas y acciones">
        <Button
          variant={module === 'alertas' ? 'primary' : 'secondary'}
          aria-pressed={module === 'alertas'}
          onClick={() => setModule('alertas')}
        >
          Alertas territoriales
        </Button>
        <Button
          variant={module === 'acciones' ? 'primary' : 'secondary'}
          aria-pressed={module === 'acciones'}
          onClick={() => setModule('acciones')}
        >
          Acciones territoriales
        </Button>
      </div>
      <p>
        Registros territoriales documentados. Las señales digitales y sus planes preventivos se
        revisan en Inteligencia de redes.
      </p>
      <RecordsPage key={`${context.scope}/${module}`} module={module} {...context} />
    </>
  );
};
const StrategicPage = (context: FeatureContext) => (
  <StrategyPage
    {...context}
    renderRecords={(module) => (
      <RecordsPage key={`${context.scope}/${module}`} module={module} {...context} />
    )}
  />
);
const featurePages = {
  '/gerencia': ManagementPage,
  '/inteligencia-redes': IntelligencePage,
  '/alertas': AlertsPage,
  '/mapa': TerritorialMapPage,
  '/ubicacion': GeographyPage,
  '/situacion': SituationalPage,
  '/estrategia': StrategicPage,
  '/irsa': IrsaPage,
  '/validacion': ValidationPage,
  '/administracion': AdministrationPage,
  '/metodologia': MethodologyPage,
  '/auditoria': AuditPage,
} as const;
const featureRoutes = (Object.keys(featurePages) as Array<keyof typeof featurePages>).map((path) =>
  createRoute({
    getParentRoute: () => appRoute,
    path,
    component: function FeatureRoute() {
      const context = useFeatureContext();
      const Page = featurePages[path];
      return <Page key={`${context.scope}/${path}`} {...context} />;
    },
  }),
);

const routeTree = rootRoute.addChildren([
  loginRoute,
  mfaRoute,
  selectProjectRoute,
  appRoute.addChildren([dashboardRoute, ...recordRoutes, ...featureRoutes]),
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
