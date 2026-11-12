import { runtimeRoutes } from './contexts/system/http/runtime-routes.ts';
import { desktopUpdateRoutes } from './contexts/system/http/desktop-update-routes.ts';
import { geographyRequestLimit, geographyRoutes } from './contexts/geography/http/index.ts';
import { sourceRequestLimit, sourceRoutes } from './contexts/integration/http/source-routes.ts';
import { mediaRoutes } from './contexts/integration/http/media-routes.ts';
import { signalRoutes } from './contexts/integration/http/signal-routes.ts';
import { automationWakeup } from './platform/http/automation-wakeup.ts';
import type { ErrorResponse } from '@sipges/contracts';
import { Hono } from 'hono';
import { referenceRoutes } from './contexts/reference/http/reference-routes.ts';
import type { Container } from './compose.ts';
import { roleGate, sessionMiddleware } from './contexts/identity/http/auth-middleware.ts';
import { analyticsRoutes } from './contexts/analytics/http/analytics-routes.ts';
import { conflictRiskRoutes } from './contexts/analytics/http/conflict-risk-routes.ts';
import { situationsRoutes } from './contexts/situations/http/situations-routes.ts';
import { automationRoutes } from './contexts/automation/http/automation-routes.ts';
import { apiKeyRoutes } from './contexts/integration/http/api-key-routes.ts';
import { ingestRoutes } from './contexts/integration/http/ingest-routes.ts';
import { mcpRoutes } from './contexts/integration/http/mcp-routes.ts';
import { type ActivityOptions, activityRoutes } from './contexts/audit/http/activity-routes.ts';
import { auditRoutes } from './contexts/audit/http/audit-routes.ts';
import { documentLabRoutes } from './contexts/documents/http/document-lab-routes.ts';
import { intelligenceRoutes } from './contexts/intelligence/http/intelligence-routes.ts';
import { managementRoutes } from './contexts/management/http/management-routes.ts';
import { preventionRoutes } from './contexts/prevention/http/prevention-routes.ts';
import { evidenceRoutes } from './contexts/evidence/http/evidence-routes.ts';
import { indicatorsRoutes } from './contexts/indicators/http/indicators-routes.ts';
import { analystRoutes } from './contexts/analyst/http/analyst-routes.ts';
import { ontologyRoutes } from './contexts/ontology/http/ontology-routes.ts';
import { recordsRoutes } from './contexts/records/http/records-routes.ts';
import { tenancyMiddleware } from './contexts/tenancy/http/tenancy-middleware.ts';
import { tenancyRoutes } from './contexts/tenancy/http/tenancy-routes.ts';
import { authRoutes } from './contexts/identity/http/auth-routes.ts';
import { googleRoutes } from './contexts/identity/http/google-routes.ts';
import { healthRoutes } from './contexts/system/http/health.routes.ts';
import type { AppEnv } from './platform/http/env.ts';
import { hostAllowlist } from './platform/http/host.ts';
import { observability } from './platform/http/observability.ts';
import { requestContext } from './platform/http/request-context.ts';
import { log } from './platform/observability/logger.ts';
import { createMetrics } from './platform/observability/metrics.ts';
import { metricsRoutes } from './contexts/system/http/metrics.routes.ts';
import { securityHeaders } from './platform/http/security-headers.ts';
import { type WebAssets, spaMiddleware } from './platform/http/spa.ts';

/** Builds the HTTP application from an already-wired container (no I/O here). */
export const createApp = (
  container: Container,
  options: {
    web?: WebAssets;
    activity?: Partial<ActivityOptions>;
    eventAutomation?: boolean;
    cronSchedule?: string;
    defer?: (task: Promise<unknown>) => void;
  } = {},
) => {
  const {
    config,
    identity,
    tenancy,
    records,
    audit,
    indicators,
    analytics,
    evidence,
    documents,
    clientIp,
    intelligence,
    prevention,
    management,
  } = container;
  const app = new Hono<AppEnv>();

  const metrics = createMetrics();
  app.use('*', requestContext());
  app.use('*', observability(metrics, { accessLog: config.accessLog }));
  app.use('*', securityHeaders({ hsts: config.cookieSecure }));
  app.use('*', hostAllowlist(config.allowedHosts));
  if (options.web) app.use('*', spaMiddleware(options.web));
  app.use('*', sessionMiddleware(identity, { requireMfa: config.requireMfa }));
  app.use('/system/geography/query', geographyRequestLimit());
  app.use('/system/intelligence/sources/*', sourceRequestLimit());
  app.use('/system/v4/media/*', sourceRequestLimit());
  app.use('*', tenancyMiddleware(tenancy));
  app.use('*', roleGate(identity));
  if (options.eventAutomation) app.use('*', automationWakeup(container.runtime, options.defer));

  app.route('/', healthRoutes({ ready: container.ready }));
  app.route(
    '/',
    runtimeRoutes(container.runtime, {
      eventProcessing: options.eventAutomation ?? false,
      cronConfigured: Boolean(config.automation.cronSecret),
      cronSchedule: options.cronSchedule,
      intervalMs: config.automation.intervalSeconds * 1000,
    }),
  );
  app.route('/', geographyRoutes({ geography: container.geography }));
  app.route('/', sourceRoutes({ sources: container.authorizedSources }));
  app.route('/', signalRoutes({ keys: container.apiKeys, ingest: container.ingest }));
  app.route('/', metricsRoutes(metrics));
  // Managed desktop installs only: the cloud and development builds never mount these routes.
  if (container.desktopUpdate) app.route('/', desktopUpdateRoutes(container.desktopUpdate));
  app.route('/', referenceRoutes(container.reference));
  app.route('/', tenancyRoutes({ tenancy, identity, cookieSecure: config.cookieSecure }));
  app.route('/', analyticsRoutes({ analytics }));
  app.route('/', conflictRiskRoutes({ conflictRisk: container.conflictRisk }));
  app.route('/', situationsRoutes(container.situations));
  app.route('/', mediaRoutes({ media: container.media }));
  app.route('/', recordsRoutes(records, container.recordsSummary));
  app.route('/', ontologyRoutes(container.ontology));
  app.route('/', analystRoutes(container.analyst));
  app.route('/', auditRoutes(audit));
  app.route(
    '/',
    activityRoutes(
      audit,
      async (token, tenantId) => {
        const principal = await identity.authenticate(token);
        return principal !== null && tenancy.isGranted(principal.username, tenantId);
      },
      options.activity,
    ),
  );
  app.route('/', indicatorsRoutes({ indicators }));
  app.route('/', evidenceRoutes(evidence));
  app.route('/', documentLabRoutes(documents));
  app.route(
    '/',
    intelligenceRoutes(intelligence, {
      configured: config.ollama.configured,
      semanticSearch: config.semanticSearch,
    }),
  );
  app.route('/', preventionRoutes(prevention));
  app.route('/', managementRoutes(management));
  app.route(
    '/',
    automationRoutes(container.automation, config.automation.cronSecret, {
      runCron: () => container.runtime.scheduled(),
    }),
  );
  app.route('/', apiKeyRoutes(container.apiKeys));
  app.route(
    '/',
    mcpRoutes({
      keys: container.apiKeys,
      services: {
        ontology: container.ontology,
        records: container.records,
        analyst: container.analyst,
        guard: container.egress,
      },
    }),
  );
  app.route('/', ingestRoutes({ keys: container.apiKeys, ingest: container.ingest }));
  app.route('/', authRoutes({ identity, cookieSecure: config.cookieSecure, clientIp }));
  app.route(
    '/',
    googleRoutes({ identity, google: container.googleSignIn, cookieSecure: config.cookieSecure }),
  );

  app.notFound((c) => c.json({ detail: 'Not Found' } satisfies ErrorResponse, 404));
  app.onError((error, c) => {
    log('error', 'unhandled_error', { method: c.req.method, path: c.req.path, error });
    return c.json({ detail: 'Internal Server Error' } satisfies ErrorResponse, 500);
  });

  return app;
};
