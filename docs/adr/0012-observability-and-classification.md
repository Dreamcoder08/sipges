# 0012 — Observability and classification markings

## Context
Before real users arrive, operators need to follow a request end to end and see latency and error rates; until now the API only wrote `console.error`. The ontology (ADR 0011) also makes sensitive records easier to find, so read access must be finer than four URL-prefix roles ([ODD](../../odd/archive/ontology-intelligence-platform.md) T6–T7).

## Decision
1. **Request context.** An `AsyncLocalStorage` context opened per request carries the request id, the actor and the clearance. `X-Request-Id` is echoed when it matches `[A-Za-z0-9._-]{8,64}`, otherwise a UUID is generated.
2. **Structured logs.** One JSON object per line with time, level, message, request id and actor. Access lines carry method, matched route pattern, path (never the query), status and duration; `SIPGES_ACCESS_LOG=0` turns them off. Payloads, cookies and secrets are never logged.
3. **Metrics.** `GET /system/metrics` (administrators only) serves request counters by route pattern and status class, latency histograms and process gauges in the Prometheus text format. Every response carries `Server-Timing: app;dur=…`.
4. **Markings.** `module_records.marking` is `publico`, `interno` (default) or `restringido`. `withTenant` sets `app.clearance` from the session role: `consulta` is limited, other roles are full; work outside a request is full. The RLS policy hides restricted rows when clearance is not exactly `full`, so the check fails closed. History, attachments and links follow the marking of the records they touch. `PUT /system/marking` changes a marking (writers only) and is audited as `CLASSIFY`; the tenant export always runs with full clearance.

## Consequences
- Every reader (lists, search, graph, indicators, analytics) honours markings without code changes, because the filter lives in SQL.
- Metrics are per process; a multi-instance deployment needs a scraper per instance or an OpenTelemetry collector later.
- Tests: `apps/api/test/platform/observability.test.ts`, `apps/api/test/ontology/classification.test.ts`.

## References
The Twelve-Factor App, XI (logs); Prometheus exposition format 0.0.4; W3C Server Timing; PostgreSQL row security policies.
