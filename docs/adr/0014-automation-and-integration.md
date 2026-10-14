# ADR 0014 — Automation and integration

- Status: Accepted
- Date: 2026-10-14
- Task: `odd/tasks/automation-integration-platform.md` T1

## Context

MASCLI records, links and analyses territorial information, but every reaction is manual:
nothing fires when an alert is created or a commitment changes, no message reaches anyone,
and other systems and AI agents cannot read or feed it. Current agent and workflow platforms
(event-triggered automations, the Model Context Protocol, signed webhooks, chat and e-mail
channels) treat these as table stakes. MASCLI must add them without weakening tenant isolation,
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
   `MASCLI_AUTOMATION_INTERVAL` seconds (default 30, `0` disables). Serverless hosting calls
   `POST /system/automations/tick` with `Authorization: Bearer <MASCLI_CRON_SECRET>` (Vercel Cron
   sends `CRON_SECRET` this way); administrators can tick their own project from the screen.
5. **Nothing leaves without an administrator's destination.** Outbound actions go to channels an
   administrator created: generic signed webhooks (Standard Webhooks headers, HMAC-SHA256),
   Slack, Microsoft Teams, Discord, Google Chat, Telegram and e-mail through Resend. Channel
   secrets (URLs, tokens, keys) are sealed with `MASCLI_DATA_KEY` like TOTP secrets and never
   returned by the API. Destinations must be `https` and must not name a loopback or private
   address. Restricted records (`restringido`) are announced by reference only, never by content.
6. **API keys for machines, not people.** Keys are random, shown once, stored as SHA-256,
   bound to one project, read or write, limited or full clearance, and revocable. They
   authenticate only `/mcp` and `/hooks/ingest/*`; the browser API keeps sessions with MFA.
7. **MCP server.** `POST /mcp` speaks stateless Streamable HTTP (JSON-RPC 2.0 with JSON
   responses): `initialize`, `ping`, `tools/list`, `tools/call`. Tools reuse the ontology,
   records and analyst services inside the key's tenant transaction, so RLS and markings still
   decide what an agent sees. Write tools exist only for write keys and are audited with the
   key's name as actor.

## Consequences

- Automations add no latency to user writes; they run within one tick interval.
- Serverless deployments need a cron schedule; on plans without minute crons the delay grows.
- Webhook receivers must verify signatures; the docs show how.
- An API key is a bearer secret: anyone holding it acts on that project until revoked.
