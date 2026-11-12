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
import { DashboardPage, InicioPage } from '../features/dashboard/index.ts';
import { DecisionInbox } from '../features/bandeja/index.ts';
import {
  GoogleSignInError,
  LoginPage,
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
import { SearchPalette, openSearch } from '../features/search/index.ts';
import { LiveUpdates } from '../features/live/index.ts';
import {
  DevicePush,
  AvisosPanel,
  useUnreadNotifications,
} from '../features/notifications/index.ts';
import { SETTINGS_PATH, settingsSearch } from '../features/situations/sections.ts';
import { AppShell } from './layout/AppShell.tsx';
import { useQualityReview } from './pending-quality.ts';

import {
  DESTINATIONS,
  type Destination,
  SCREENS,
  type ScreenPath,
  hubHref,
  HOME_PATH,
  safeRedirect,
} from './navigation.ts';

const RecordsPage = lazy(() =>
  import('../features/records/index.ts').then((module) => ({ default: module.RecordsPage })),
);
const RegistrosHub = lazy(() =>
  import('../features/records/index.ts').then((module) => ({ default: module.RegistrosHub })),
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
const ConflictRiskPage = lazy(() =>
  import('../features/analysis/index.ts').then((module) => ({ default: module.ConflictRiskPage })),
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
const IntegrationsPage = lazy(() =>
  import('../features/automation/index.ts').then((module) => ({
    default: module.IntegrationsPage,
  })),
);
// The sources' own management UI lives in their features; the shell composes it into the page.
const AuthorizedSourcesCard = lazy(() =>
  import('../features/operations/AuthorizedSourcesCard.tsx').then((module) => ({
    default: module.AuthorizedSourcesCard,
  })),
);
const MediaMonitorCard = lazy(() =>
  import('../features/situations/MediaMonitorCard.tsx').then((module) => ({
    default: module.MediaMonitorCard,
  })),
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
          await router.navigate({ to: HOME_PATH });
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
          await navigate({ to: HOME_PATH });
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
    // Session and project are asked together: each is a round trip to a distant server.
    // Refetched only once invalidated, e.g. after a project switch.
    const pendingScope = cachedOrFetch(context.queryClient, currentScopeQuery);
    // Without a session the project request fails too; the sign-in redirect below wins.
    pendingScope.catch(() => undefined);
    const me = await requireSession(context.queryClient, location.href);
    try {
      const scope = await pendingScope;
      return { me, scope };
    } catch (error) {
      if (isMfaRequired(error)) throw redirect({ to: '/mfa' });
      if (isApiError(error, 403)) throw redirect({ to: '/proyecto' });
      throw error;
    }
  },
  component: function AppLayout() {
    const { scope, queryClient } = appRoute.useRouteContext();
    const router = useRouter();
    // Subscribed, so the header shows the project's name once the list arrives.
    const scopes = useQuery(scopesQuery).data;
    const label = scopes?.find((s) => `${s.company_id}/${s.project_id}` === scope.scope)?.label;
    const projectLabel = label || scope.project_id;
    const unread = useUnreadNotifications(scope.scope);
    // Colour meanings of the project; until known the labels use their plain names.
    const settings = useQuery(projectSettingsQuery(scope.scope)).data ?? null;
    usePreloadScreens();
    return (
      <ProjectSettingsProvider value={settings}>
        <NavigateProvider value={(href) => void router.navigate({ href })}>
          <AppShell
            projectLabel={projectLabel}
            projectKey={scope.scope}
            search={<SearchPalette scope={scope.scope} />}
            unread={unread}
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
    renderLink={(to, children) => <Link to={isScreen(to) ? to : '/'}>{children}</Link>}
  />
);

const InicioScreen = (context: FeatureContext) => (
  <InicioPage
    scope={context.scope}
    projectId={context.projectId}
    projectLabel={context.projectLabel}
    fullName={context.fullName}
    onAsk={openSearch}
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
const IntegrationsScreen = (context: FeatureContext) => (
  <IntegrationsPage
    {...context}
    renderSource={(source) =>
      source === 'defensoria' ? (
        <AuthorizedSourcesCard context={context} />
      ) : (
        <MediaMonitorCard scope={context.scope} admin={context.role === 'admin'} />
      )
    }
  />
);
const PendingScreen = (context: FeatureContext) => (
  <DecisionInbox {...context} useQuality={useQualityReview} />
);
const AvisosScreen = (context: FeatureContext) => <AvisosPanel scope={context.scope} />;
const featurePages = {
  '/pendientes': PendingScreen,
  '/avisos': AvisosScreen,
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
  '/riesgo': ConflictRiskPage,
  '/validacion': ValidationPage,
  '/administracion': AdministrationPage,
  '/metodologia': MethodologyPage,
  '/auditoria': AuditPage,
  '/automatizaciones': AutomationPage,
  '/integraciones': IntegrationsScreen,
} as const;
const featureRoutes = (Object.keys(featurePages) as Array<keyof typeof featurePages>).map((path) =>
  createRoute({
    getParentRoute: () => appRoute,
    path,
    component: function FeatureRoute() {
      const context = useFeatureContext();
      const search = useLocation({
        select: (location) =>
          path === '/inteligencia-redes' || path === '/riesgo' ? location.searchStr : '',
      });
      const Page = featurePages[path];
      return <Page key={`${context.scope}/${path}/${search}`} {...context} />;
    },
  }),
);

/** Configuración: one screen with sections, the current one in `?seccion=` (ADR 0006). */
const settingsRoute = createRoute({
  getParentRoute: () => appRoute,
  path: SETTINGS_PATH,
  validateSearch: settingsSearch,
  component: function SettingsRoute() {
    const context = useFeatureContext();
    const navigate = useNavigate();
    const { seccion } = settingsRoute.useSearch();
    return (
      <SettingsPage
        key={context.scope}
        {...context}
        section={seccion}
        onNavigate={(href) => void navigate({ href })}
        notifications={<DevicePush scope={context.scope} />}
      />
    );
  },
});

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

/** Adds `ficha=` (the record open in the Registros sheet) to a hub href. */
const withFicha = (href: string, ficha: string | undefined) =>
  ficha ? `${href}${href.includes('?') ? '&' : '?'}ficha=${encodeURIComponent(ficha)}` : href;

/** A destination: tabs in the URL search (`?vista=`), each tab one of today's screens. */
const hubRoute = (hub: Destination) => {
  const route = createRoute({
    getParentRoute: () => appRoute,
    path: hub.path,
    validateSearch: z.object({
      [hub.param]: z.string().optional().catch(undefined),
      // Registros keeps the record open in its sheet in the URL (closure-roadmap T31).
      ...(hub.path === '/registros' ? { ficha: z.string().optional().catch(undefined) } : {}),
    }),
    component: function HubRoute() {
      const context = useFeatureContext();
      const navigate = useNavigate();
      const search = route.useSearch() as Record<string, string | undefined>;
      const asked = search[hub.param];
      // Riesgo de conflicto reads `?localidad=` on mount; a new one remounts it (ADR 0031).
      const searchStr = useLocation({ select: (location) => location.searchStr });
      if (hub.path === '/registros')
        return (
          <RegistrosHub
            key={context.scope}
            tipo={asked}
            onTipo={(tipo) => void navigate({ href: withFicha(hubHref(hub, tipo), search.ficha) })}
            ficha={search.ficha}
            onFicha={(ficha) =>
              void navigate({
                // The type as written: hubHref would fold the first type (eventos) into Todos.
                href: withFicha(
                  asked ? `${hub.path}?${hub.param}=${encodeURIComponent(asked)}` : hub.path,
                  ficha,
                ),
                replace: true,
              })
            }
            {...context}
          />
        );
      const tab = hub.tabs.find((item) => item.value === asked) ?? hub.tabs[0];
      const Screen = tab.value === 'inicio' ? InicioScreen : screenFor(tab.screen);
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
          <Screen
            key={`${context.scope}/${tab.value}${tab.value === 'riesgo' ? searchStr : ''}`}
            {...context}
          />
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
    settingsRoute,
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
