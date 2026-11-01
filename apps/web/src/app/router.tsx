import {
  type FetchQueryOptions,
  type QueryClient,
  type QueryKey,
  useQuery,
} from '@tanstack/react-query';
import {
  Link,
  Outlet,
  createRootRouteWithContext,
  createRoute,
  createRouter,
  redirect,
  useNavigate,
  useLocation,
  useRouter,
} from '@tanstack/react-router';
import { z } from 'zod';
import { lazy, Suspense, useEffect, useState, type ReactNode } from 'react';
import type { FeatureContext } from '../shared/api/feature-context.ts';
import { NavigateProvider } from '../shared/lib/navigation.tsx';
import { ProjectSettingsProvider } from '../shared/lib/project-settings.tsx';
import { projectSettingsQuery } from '../shared/api/project-settings.ts';
import { Button } from '../shared/ui/Button.tsx';
import { ChipRow } from '../shared/ui/ChipRow.tsx';
import { DashboardPage } from '../features/dashboard/index.ts';
import {
  GoogleSignInError,
  LoginPage,
  AccountMenu,
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
import { SearchPalette } from '../features/search/index.ts';
import { LiveUpdates } from '../features/live/index.ts';
import {
  NotificationBell,
  NotificationList,
  useUnreadNotifications,
} from '../features/notifications/index.ts';
import { COMPACT_QUERY, useMediaQuery } from '../shared/lib/media.ts';
import { AppShell } from './layout/AppShell.tsx';

import {
  DESTINATIONS,
  type Destination,
  SCREENS,
  type ScreenPath,
  hubHref,
  safeRedirect,
} from './navigation.ts';

const RecordsPage = lazy(() =>
  import('../features/records/index.ts').then((module) => ({ default: module.RecordsPage })),
);
const AlertOverview = lazy(() =>
  import('../features/records/index.ts').then((module) => ({ default: module.AlertOverview })),
);
const QualityPage = lazy(() =>
  import('../features/records/index.ts').then((module) => ({ default: module.QualityPage })),
);
const ObjectPage = lazy(() =>
  import('../features/records/index.ts').then((module) => ({ default: module.ObjectPage })),
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
const AutomationPage = lazy(() =>
  import('../features/automation/index.ts').then((module) => ({ default: module.AutomationPage })),
);
const AuditPage = lazy(() =>
  import('../features/audit/index.ts').then((module) => ({ default: module.AuditPage })),
);
const GeographyPage = lazy(() =>
  import('../features/geography/index.ts').then((module) => ({ default: module.GeographyPage })),
);
const TimelinePage = lazy(() =>
  import('../features/timeline/index.ts').then((module) => ({ default: module.TimelinePage })),
);
const SettingsPage = lazy(() =>
  import('../features/situations/index.ts').then((module) => ({ default: module.SettingsPage })),
);
const SituationsPage = lazy(() =>
  import('../features/situations/index.ts').then((module) => ({ default: module.SituationsPage })),
);
const TerritorialMapPage = lazy(() =>
  import('../features/geography/index.ts').then((module) => ({
    default: module.TerritorialMapPage,
  })),
);

/** Every lazily loaded screen module, fetched while the browser is idle after sign-in. */
const SCREEN_MODULES = [
  () => import('../features/records/index.ts'),
  () => import('../features/indicators/index.ts'),
  () => import('../features/analysis/index.ts'),
  () => import('../features/operations/index.ts'),
  () => import('../features/administration/index.ts'),
  () => import('../features/automation/index.ts'),
  () => import('../features/audit/index.ts'),
  () => import('../features/geography/index.ts'),
  () => import('../features/timeline/index.ts'),
  () => import('../features/situations/index.ts'),
];

/**
 * Downloads the other screens in the background once the first one is shown, so opening a
 * screen later does not wait for its code ("Cargando sección…"). Skipped on Save-Data.
 */
const usePreloadScreens = () => {
  useEffect(() => {
    const connection = (navigator as Navigator & { connection?: { saveData?: boolean } })
      .connection;
    if (connection?.saveData) return;
    const run = () => {
      for (const load of SCREEN_MODULES) load().catch(() => undefined);
    };
    if ('requestIdleCallback' in window) {
      const id = window.requestIdleCallback(run, { timeout: 4000 });
      return () => window.cancelIdleCallback(id);
    }
    const timer = setTimeout(run, 2000);
    return () => clearTimeout(timer);
  }, []);
};

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

/**
 * The cached answer while it is valid, refreshed in the background once stale; a fresh fetch
 * only when there is none or it was invalidated (sign-in, project switch). Waiting for two
 * sequential round trips on every navigation made each screen change feel slow, above all
 * against a serverless API.
 */
const cachedOrFetch = <TData, TKey extends QueryKey>(
  queryClient: QueryClient,
  options: FetchQueryOptions<TData, Error, TData, TKey>,
): Promise<TData> =>
  queryClient.getQueryState(options.queryKey)?.isInvalidated
    ? queryClient.fetchQuery(options)
    : queryClient.ensureQueryData({ ...options, revalidateIfStale: true });

const requireSession = async (queryClient: QueryClient, href: string) => {
  const me = await cachedOrFetch(queryClient, meQuery);
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
/** Phone account sheet links, the same screens as the desktop account menu. */
const AccountLinks = () => (
  <>
    <Link to="/version-4" activeOptions={{ exact: true }}>
      Configuración
    </Link>
    <Link to="/administracion" activeOptions={{ exact: true }}>
      Administración
    </Link>
    <Link to="/auditoria" activeOptions={{ exact: true }}>
      Auditoría
    </Link>
    <Link to="/metodologia" activeOptions={{ exact: true }}>
      Ayuda y metodología
    </Link>
  </>
);

const appRoute = createRoute({
  getParentRoute: () => rootRoute,
  id: 'app',
  beforeLoad: async ({ context, location }) => {
    const me = await requireSession(context.queryClient, location.href);
    try {
      // Refetched only once invalidated, e.g. after a project switch.
      const scope = await cachedOrFetch(context.queryClient, currentScopeQuery);
      return { me, scope };
    } catch (error) {
      if (isMfaRequired(error)) throw redirect({ to: '/mfa' });
      if (isApiError(error, 403)) throw redirect({ to: '/proyecto' });
      throw error;
    }
  },
  component: function AppLayout() {
    const locationHref = useLocation({ select: (location) => location.href });
    const { me, scope, queryClient } = appRoute.useRouteContext();
    const router = useRouter();
    // Subscribed, so the header shows the project's name once the list arrives.
    const scopes = useQuery(scopesQuery).data;
    const label = scopes?.find((s) => `${s.company_id}/${s.project_id}` === scope.scope)?.label;
    const compact = useMediaQuery(COMPACT_QUERY);
    const unread = useUnreadNotifications(scope.scope);
    const projectLabel = label || scope.project_id;
    // Colour meanings of the project; until known the labels use their plain names.
    const settings = useQuery(projectSettingsQuery(scope.scope)).data ?? null;
    usePreloadScreens();
    return (
      <ProjectSettingsProvider value={settings}>
        <NavigateProvider value={(href) => void router.navigate({ href })}>
          <AppShell
            projectLabel={projectLabel}
            search={<SearchPalette scope={scope.scope} />}
            notifications={
              <NotificationBell key={`notifications/${locationHref}`} scope={scope.scope} />
            }
            live={<LiveUpdates scope={scope.scope} />}
            projectSwitcher={
              <ProjectSwitcher
                current={scope}
                onSwitched={async () => {
                  await queryClient.invalidateQueries();
                  await router.invalidate();
                }}
              />
            }
            account={
              <AccountMenu
                key={`account/${locationHref}`}
                me={me}
                project={projectLabel}
                unread={compact ? unread : 0}
                links={compact ? <AccountLinks /> : null}
                onSignedOut={async () => {
                  queryClient.clear();
                  await router.navigate({ to: '/login', search: {} });
                }}
              >
                {compact ? <NotificationList scope={scope.scope} /> : null}
              </AccountMenu>
            }
          >
            <Suspense fallback={<p role="status">Cargando sección…</p>}>
              <Outlet />
            </Suspense>
          </AppShell>
        </NavigateProvider>
      </ProjectSettingsProvider>
    );
  },
});

const isScreen = (to: string): to is ScreenPath => SCREENS.some((s) => s.path === to);

const DashboardScreen = (context: FeatureContext) => (
  <DashboardPage
    key={context.scope}
    scope={context.scope}
    projectId={context.projectId}
    renderLink={(to, children) => <Link to={isScreen(to) ? to : '/'}>{children}</Link>}
  />
);

const dashboardRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/',
  component: function DashboardRoute() {
    return <DashboardScreen {...useFeatureContext()} />;
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
const ALERT_TABS = [
  ['resumen', 'Vista general'],
  ['alertas', 'Alertas territoriales'],
  ['acciones', 'Acciones territoriales'],
] as const;
const AlertsPage = (context: FeatureContext) => {
  const [tab, setTab] = useState<(typeof ALERT_TABS)[number][0]>('resumen');
  return (
    <>
      <ChipRow label="Alertas y acciones">
        {ALERT_TABS.map(([value, label]) => (
          <Button
            key={value}
            variant={tab === value ? 'primary' : 'secondary'}
            aria-pressed={tab === value}
            onClick={() => setTab(value)}
          >
            {label}
          </Button>
        ))}
      </ChipRow>
      <p>
        Registros territoriales documentados. Las señales digitales y sus planes preventivos se
        revisan en Inteligencia de redes.
      </p>
      {tab === 'resumen' ? (
        <AlertOverview
          key={context.scope}
          scope={context.scope}
          onShowList={() => setTab('alertas')}
        />
      ) : (
        <RecordsPage key={`${context.scope}/${tab}`} module={tab} {...context} />
      )}
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
const SituationsScreen = (context: FeatureContext) => <SituationsPage {...context} />;
const MailboxScreen = (context: FeatureContext) => (
  <RecordsPage key={`${context.scope}/buzon`} module="buzon" {...context} />
);
const LessonsScreen = (context: FeatureContext) => (
  <RecordsPage key={`${context.scope}/lecciones`} module="lecciones" {...context} />
);
const featurePages = {
  '/situaciones': SituationsScreen,
  '/buzon': MailboxScreen,
  '/lecciones': LessonsScreen,
  '/calidad': QualityPage,
  '/gerencia': ManagementPage,
  '/inteligencia-redes': IntelligencePage,
  '/alertas': AlertsPage,
  '/mapa': TerritorialMapPage,
  '/cronologia': TimelinePage,
  '/ubicacion': GeographyPage,
  '/situacion': SituationalPage,
  '/estrategia': StrategicPage,
  '/irsa': IrsaPage,
  '/validacion': ValidationPage,
  '/administracion': AdministrationPage,
  '/metodologia': MethodologyPage,
  '/auditoria': AuditPage,
  '/automatizaciones': AutomationPage,
  '/version-4': SettingsPage,
} as const;
const featureRoutes = (Object.keys(featurePages) as Array<keyof typeof featurePages>).map((path) =>
  createRoute({
    getParentRoute: () => appRoute,
    path,
    component: function FeatureRoute() {
      const context = useFeatureContext();
      const search = useLocation({
        select: (location) => (path === '/inteligencia-redes' ? location.searchStr : ''),
      });
      const Page = featurePages[path];
      return <Page key={`${context.scope}/${path}/${search}`} {...context} />;
    },
  }),
);

const objectRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/objeto/$module/$id',
  component: function ObjectRoute() {
    const context = useFeatureContext();
    const { module, id } = objectRoute.useParams();
    return <ObjectPage module={module} id={id} {...context} />;
  },
});

/** The screen of every path a hub shows as a tab; the old routes render the same functions. */
const screenFor = (path: ScreenPath): ((context: FeatureContext) => ReactNode) => {
  if (path === '/') return DashboardScreen;
  const module = recordModules.find((item) => `/${item}` === path);
  if (module)
    return (context) => (
      <RecordsPage key={`${context.scope}/${module}`} module={module} {...context} />
    );
  return featurePages[path as keyof typeof featurePages];
};

/** A destination: tabs in the URL search (`?vista=`), each tab one of today's screens. */
const hubRoute = (hub: Destination) => {
  const route = createRoute({
    getParentRoute: () => appRoute,
    path: hub.path,
    validateSearch: z.object({ [hub.param]: z.string().optional().catch(undefined) }),
    component: function HubRoute() {
      const context = useFeatureContext();
      const navigate = useNavigate();
      const asked = (route.useSearch() as Record<string, string | undefined>)[hub.param];
      const tab = hub.tabs.find((item) => item.value === asked) ?? hub.tabs[0];
      const Screen = screenFor(tab.screen);
      return (
        <>
          <ChipRow label={hub.label}>
            {hub.tabs.map((item) => (
              <Button
                key={item.value}
                variant={item.value === tab.value ? 'primary' : 'secondary'}
                aria-pressed={item.value === tab.value}
                onClick={() => void navigate({ href: hubHref(hub, item.value) })}
              >
                {item.label}
              </Button>
            ))}
          </ChipRow>
          <Screen key={`${context.scope}/${tab.screen}`} {...context} />
        </>
      );
    },
  });
  return route;
};
const hubRoutes = DESTINATIONS.map(hubRoute);

const routeTree = rootRoute.addChildren([
  loginRoute,
  mfaRoute,
  selectProjectRoute,
  appRoute.addChildren([
    dashboardRoute,
    objectRoute,
    ...hubRoutes,
    ...recordRoutes,
    ...featureRoutes,
  ]),
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
