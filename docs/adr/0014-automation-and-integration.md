# ADR 0014 — Automation and integration

> Hosting note: the Vercel host this ADR mentions was retired; Cloudflare Workers is the only host ([ADR 0029](0029-retire-vercel-host.md)). The text below is kept as written.

- Status: Accepted
- Date: 2026-10-14
- Task: `odd/archive/automation-integration-platform.md` T1

## Context

SIPGES records, links and analyses territorial information, but every reaction is manual:
nothing fires when an alert is created or a commitment changes, no message reaches anyone,
and other systems and AI agents cannot read or feed it. Current agent and workflow platforms
(event-triggered automations, the Model Context Protocol, signed webhooks, chat and e-mail
channels) treat these as table stakes. SIPGES must add them without weakening tenant isolation,
classification markings (ADR 0012) or the append-only audit.

## Decision

1. **The audit trail is the event stream.** Every business write already appends an audit row
   in its own transaction, so an audit row exists exactly when the change committed. The
   automation engine reads audit rows after a per-tenant cursor; no second outbox is needed and
   no write path changes. Rows written by the automation context itself are never matched, which
   rules out loops.
2. **Rules are data, evaluated in the domain.** A rule names a trigger (module or `*`, one or
   more actions such as `CREATE`, `UPDATE`, `DELETE`, `IMPORT`, `REVIEW`) and conditions on the
   current record (`eq`, `neq`, `contains`, `gte`, `lte`, `present`, `absent`). Matching is a pure
   function; the store only loads rows.
3. **Runs are durable and idempotent.** Each match inserts one run per action, unique on
   `(rule, audit row, action index)`. Delivery claims due runs with a lease, calls the adapter
   outside the transaction and records the outcome. Failures retry with exponential backoff
   (1, 4, 16, 64 minutes) and stop as `failed` after five attempts.
4. **Two ways to tick.** A long-running server ticks in-process every
   `SIPGES_AUTOMATION_INTERVAL` seconds (default 30, `0` disables). Serverless hosting calls
   `POST /system/automations/tick` with `Authorization: Bearer <SIPGES_CRON_SECRET>` (Vercel Cron
   sends `CRON_SECRET` this way); administrators can tick their own project from the screen.
5. **Nothing leaves without an administrator's destination.** Outbound actions go to channels an
   administrator created: generic signed webhooks (Standard Webhooks headers, HMAC-SHA256),
   Slack, Microsoft Teams, Discord, Google Chat, Telegram and e-mail through Resend. Channel
   secrets (URLs, tokens, keys) are sealed with `SIPGES_DATA_KEY` like TOTP secrets and never
   returned by the API. Destinations must be `https` and must not name a loopback or private
   address. Restricted records (`restringido`) are announced by reference only, never by content.
6. **API keys for machines, not people.** Keys are random, shown once, stored as SHA-256,
   bound to one project, read or write, limited or full clearance, and revocable. They
   authenticate only `/mcp` and `/hooks/ingest/*`; the browser API keeps sessions with MFA.
7. **MCP server.** `POST /mcp` speaks stateless Streamable HTTP (JSON-RPC 2.0 with JSON
   responses): `initialize`, `ping`, `tools/list`, `tools/call`. Tools reuse the ontology,
   records and analyst services inside the key's tenant transaction, so RLS and markings still
   decide what an agent sees. Write tools exist only for write keys and are audited with the
   key's name as actor. Inbound webhooks (`POST /hooks/ingest/{module}`) need a write key,
   check every payload before the first write, create each record with its own audited
   CREATE (so rules react) and replay a retried call that repeats its `Idempotency-Key`.
8. **The analyst proposes; people decide.** Proposals (links between records that name each
   other in their text, follow-up records for severe open items) are computed on request,
   recomputed before an approval is applied through the owning context, and remembered once
   decided, with an audit row. No proposal is applied without a person.
9. **Hybrid search without extensions.** When enabled, record embeddings from the configured
   model are stored as `real[]` with a hash of the embedded payload, refreshed a few at a time
   on search, compared by cosine over visible records only and fused with the lexical ranking
   by reciprocal rank. Restricted records are never sent to the model; any model failure
   leaves the lexical search unchanged.
10. **Live activity and traces.** `GET /system/events` streams the project's audit tail as
    server-sent events naming only module and action, resumable with `Last-Event-ID`; the
    web app refreshes its queries when something changes. Requests join or start a W3C trace,
    logs carry its ids and outbound calls to owned systems continue it with `traceparent`.

## Consequences

- Automations add no latency to user writes; they run within one tick interval.
- Serverless deployments need a cron schedule; on plans without minute crons the delay grows.
- Webhook receivers must verify signatures; the docs show how.
- An API key is a bearer secret: anyone holding it acts on that project until revoked.
- Each open screen keeps one streaming request and polls the audit table every few seconds;
  serverless streams end before the function limit and reconnect.
- Semantic ranking is linear in the number of embedded records, fine for project-sized data;
  a much larger corpus would need an index such as pgvector.
