import type { ErrorResponse } from '@mascli/contracts';
import { Hono } from 'hono';
import { referenceRoutes } from './contexts/reference/http/reference-routes.ts';
import type { Container } from './compose.ts';
import { roleGate, sessionMiddleware } from './contexts/identity/http/auth-middleware.ts';
import { analyticsRoutes } from './contexts/analytics/http/analytics-routes.ts';
import { automationRoutes } from './contexts/automation/http/automation-routes.ts';
import { apiKeyRoutes } from './contexts/integration/http/api-key-routes.ts';
import { mcpRoutes } from './contexts/integration/http/mcp-routes.ts';
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
export const createApp = (container: Container, options: { web?: WebAssets } = {}) => {
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
  app.use('*', tenancyMiddleware(tenancy));
  app.use('*', roleGate(identity));

  app.route('/', healthRoutes());
  app.route('/', metricsRoutes(metrics));
  app.route('/', referenceRoutes(container.reference));
  app.route('/', tenancyRoutes({ tenancy, identity, cookieSecure: config.cookieSecure }));
  app.route('/', analyticsRoutes({ analytics }));
  app.route('/', recordsRoutes(records));
  app.route('/', ontologyRoutes(container.ontology));
  app.route('/', analystRoutes(container.analyst));
  app.route('/', auditRoutes(audit));
  app.route('/', indicatorsRoutes({ indicators }));
  app.route('/', evidenceRoutes(evidence));
  app.route('/', documentLabRoutes(documents));
  app.route('/', intelligenceRoutes(intelligence));
  app.route('/', preventionRoutes(prevention));
  app.route('/', managementRoutes(management));
  app.route('/', automationRoutes(container.automation, config.automation.cronSecret));
  app.route('/', apiKeyRoutes(container.apiKeys));
  app.route(
    '/',
    mcpRoutes({
      keys: container.apiKeys,
      services: {
        ontology: container.ontology,
        records: container.records,
        analyst: container.analyst,
      },
    }),
  );
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
