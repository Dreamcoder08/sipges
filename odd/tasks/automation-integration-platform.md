# Automation and Integration Platform

Make MASCLI act on its own and connect with external systems and AI agents, on top of the ontology platform already on `main`. Branch `claude/project-thread-67pd9u` from `main` 401be61. Synthetic data only; no deployment, real-data migration, external message delivery to real recipients or paid service activation without the user's word.

## Specs
- S1: "Que más le falta al proyecto para que sea 100% automático e integrado con todos los medios posibles ?? Inspírate en los mejores software de vanguardia de este mes, semana de la web"
- S2: "Si ODD completo" — accepted gap list (2026-10-14): automation engine, MCP server and public API, multichannel notifications, automatic ingestion, an analyst that proposes actions, semantic search, realtime and observability; start with 1 and 2.
- S3: Keep the existing guarantees: hexagonal contexts, forced RLS per tenant, append-only audit, MFA, classification markings (ADR 0012), existing HTTP contract (ADR 0007) and parity tests stay green. Nothing leaves the server unless an administrator configured the destination.

## Tasks
- T1 [ ] S2,S3 — ADR 0014 automation and integration; this ODD; route: inline; commit: pending
- T2 [ ] S2,S3 — Automation engine: per-tenant rules over the audit event stream (module, action, field conditions), actions (in-app notification, signed webhook), run log with retries, `POST /system/automations/tick` for cron plus an in-process scheduler, Automatizaciones screen; route: inline; commit: pending
- T3 [ ] S2,S3 — API keys (hashed, tenant-scoped, read or write, revocable) and an MCP server at `POST /mcp` (Streamable HTTP, stateless JSON-RPC) exposing search, record, links, timeline and briefing tools; route: inline + review; commit: pending
- T4 [ ] S2,S3 — Multichannel notifications: in-app inbox with unread count, channels Slack/Teams/Discord/Google Chat webhooks, Telegram bot and e-mail (Resend) with encrypted secrets, installable PWA manifest; route: inline; commit: pending
- T5 [ ] S2,S3 — Automatic ingestion: inbound webhook `POST /hooks/ingest/{module}` with an API key (Zapier, n8n, Make, Power Automate, forms) and optional OCR port for scanned PDFs; route: inline; commit: pending
- T6 [ ] S2,S3 — Analyst proposals: the briefing suggests actions (links, follow-up records) that a person approves or rejects, all audited; route: inline; commit: pending
- T7 [ ] S2 — Semantic search: stored embeddings when a provider is configured, hybrid ranking with the lexical index, graceful lexical fallback; route: inline; commit: pending
- T8 [ ] S2,S3 — Realtime and tracing: server-sent events for tenant activity that refresh open screens, W3C `traceparent` propagation in logs and outbound calls; route: inline; commit: pending
- T9 [ ] S2,S3 — E2E coverage, docs, deployment notes (Vercel cron) and architecture viewer refresh; route: verify; commit: pending

## Log
- L1 (plan, 2026-10-14): Gap review in the project thread found no triggers, queues, schedules or webhooks (no `webhook`, `outbox` or `schedul` in the code, no crons in `apps/hosting/vercel.json`), no MCP server or API keys, no notifications, CSV as the only ingestion path, a read-only narrator, embeddings without storage and no realtime channel. The user accepted the full list ("Si ODD completo").
