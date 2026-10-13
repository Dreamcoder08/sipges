# 0007 — HTTP contract compatibility and errors

## Context
User decision L7: preserve user-visible contracts (endpoints, responses, roles, calculations). FastAPI errors are `{"detail": ...}` with the status codes in behavior contract §1.

## Decision
- Same paths, methods, status codes and success payload shapes as the Python app. Every route has a parity test written from the behavior contract before implementation.
- Error body stays `{"detail": string | object}` for compatibility; responses also set `Content-Type: application/json`. A future move to RFC 9457 `application/problem+json` would be a versioned change, not part of the migration.
- Requests are validated with Zod from `packages/contracts`; validation failures return 422 with `{"detail": [...]}`, matching FastAPI's status.
- Hono middleware order mirrors `enforce_auth` (behavior contract §2): exemptions → session → origin → scope → tenant availability → project mismatch → role gates → handler → security headers.
- Structured JSON logs (pino) with request ID; no secrets, tokens or record payloads in logs.

## Consequences
- The existing frontend and any external scripts keep working against the new API during transition.
