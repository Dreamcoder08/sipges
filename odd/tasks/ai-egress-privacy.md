# Privacy guard for data sent to external AI

SIPGES can send tenant data outside the system through the MCP server (`/mcp`), the analyst narrator
(`SIPGES_ANALYST_PROVIDER=anthropic`) and the embeddings endpoint. Build one technical guard for every such
path before any real data leaves, in line with Peru's Ley 29733 (consent, sensitive data, cross-border flow).
This is technical support for compliance, not a legal decision.

## Specs

- S1 — «perfect implementa y te autorizo todo», in reply to: «Yo te puedo dejar armada la parte técnica (seudonimización, exclusión de datos sensibles y registro de accesos) para que la decisión legal sea fácil de cumplir.»
- S2 — One egress guard used by every path that sends tenant data to an external model or client: MCP tool results, the analyst narrator prompt, and embedding requests to a non-loopback URL. No path bypasses it; a test fails if a new egress path is added without it.
- S3 — Pseudonymisation: person and organisation names and contact data (actor names, responsible persons, authors, emails, phone numbers, Peruvian DNI) are replaced with stable per-project pseudonyms (same input → same pseudonym, e.g. `Actor-7F3A`), so references stay consistent across calls. Known names are also replaced inside free text. The mapping never leaves SIPGES.
- S4 — Sensitive data never leaves: each module declares which fields may be sent (allowlist); anything not allowed is dropped. Fields that hold sensitive data under the law (political opinion, ethnic origin, health, religion, union membership, income, biometrics) are never on the allowlist.
- S5 — Access log: every egress is recorded (actor or API key, channel, tool or purpose, project, record ids, number of fields sent and dropped, time) in the append-only audit, without the data itself, and is visible in Auditoría.
- S6 — A per-project switch «Envío a IA externa», off by default. When off, egress paths refuse with a clear message; when on, data is always pseudonymised. There is no mode that sends real names (that needs the legal decision of T8 in odd/tasks/workspace-architecture.md).
- S7 — Integrity and isolation are unchanged: tenant scoping, permissions and inbound writes (`create_record`, `link_records`) keep their current rules.

## Tasks

- T1 — S2–S7: guard, pseudonymiser, field allowlists, access log, project switch, wiring into MCP/narrator/embeddings; tests; docs (ADR). Route: delegated worker. Risk: items 1 and 2 (data exposure, security). Commit: pending.
- T2 — S2–S6: independent verification. Route: gentle-ai-verify. Commit: n/a.
- T3 — S6: deploy and check in production that the switch is off and egress refuses. Route: inline. Commit: n/a.

## Log

- L1 — S1 verbatim, after explaining Ley 29733 (consent previo/informado/expreso/inequívoco, art. 13.5; sensitive data in writing, art. 13.6; cross-border flow, DS 016-2024-JUS art. 18; fines 0,5–100 UIT).
- L2 — Production state 2026-11-01: analyst off (no ANTHROPIC_API_KEY secret), zero MCP API keys in SIPGES/PRJ-SECHURA and SIPGES/PRJ-ALGARROBO, so no tenant data has left to an external model yet. Hosting (Neon, Cloudflare R2) is itself outside Peru; reviewing their regions and DPAs is part of the owner's legal review, not of this task.
- L3 — T1 implemented, uncommitted, awaiting T2. Guard in `apps/api/src/contexts/privacy` (domain: pseudonymiser, scrubbers, allowlists in `allowlist.ts`; application: `createEgressGuard`; infrastructure: HMAC keys from `SIPGES_DATA_KEY` + project, name directory, audit log). Switch `externalAi.enabled` in `project_settings` (no migration), `external_ai` in `PUT /system/v4/settings` (admin-only), toggle in Configuración. Wired: MCP read tools (`runTool`), narrator (`analyst-service`), embeddings (`ontology-service`, `intelligence-service`); adapters take `SanitisedPayload<string>`. Audit rows: module «IA externa», action `EGRESS`. RED then GREEN: 25 failing privacy tests + 3 unit files that did not import, then 76 tests in `test/privacy` (S2 structural, S3 pseudonyms/scrub, S4 allowlist, S5 audit, S6 switch, S7 cross-project key) and 3 web tests in `SettingsPage.test.tsx`. Checks: `pnpm --filter @sipges/api test` 857 passed / 14 skipped (PostgreSQL integration files skipped: no synthetic connection), `pnpm --filter @sipges/web test` 355 passed, `pnpm --filter @sipges/hosting-cloudflare test` 18 passed, `pnpm lint`, `pnpm typecheck`, `pnpm boundaries` exit 0. Found by inspection, not by the first tests: the ontology cuts titles and excerpts with «…» and can leave half a name or phone, so the pseudonymiser also replaces name fragments and digit runs next to the mark. Open: free text can still carry a name nobody registered; full-clearance keys still receive restricted records (allowlisted, pseudonymised); internal briefings show the model's pseudonyms unreversed. ADR 0030.
- L4 — Parent decision: restricted records never leave to external AI, whatever the clearance. Enforced once in the guard (`sanitiseRecords`: marking other than publico/interno is withheld whole, fields counted as dropped, ids listed as «retenidos» in the audit row); MCP lists, briefing and embeddings honour it. Tests: `test/privacy/restricted-egress.test.ts` and marking cases in `sanitise.test.ts`.
