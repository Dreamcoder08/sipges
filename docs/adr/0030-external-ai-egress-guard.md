# ADR 0030 — External AI egress guard

- Status: Accepted (technical control; the legal decision is still the owner's)
- Date: 2026-11-01
- Task: `odd/tasks/ai-egress-privacy.md` (T1)
- Related: [ADR 0013](0013-cited-analyst-briefings.md) (narrator), [ADR 0014](0014-automation-and-integration.md) (MCP, embeddings), [ADR 0012](0012-observability-and-classification.md) (restricted records)

## Context

SIPGES can send tenant data outside the system on three paths:

1. the MCP server (`POST /mcp`), whose read tools return records to an agent run by someone else;
2. the analyst narrator (`SIPGES_ANALYST_PROVIDER=anthropic`), which sends a briefing to Anthropic;
3. embeddings, when `SIPGES_OLLAMA_URL` is not on this machine (search indexing and queries,
   semantic text analysis).

The records describe people and organisations of social conflicts: names, contacts, positions
towards a project, complaints. Peru's Ley 29733 (data protection) asks for prior, informed,
express and unequivocal consent (art. 13.5), written consent for sensitive data (art. 13.6), and
conditions on sending personal data abroad (DS 016-2024-JUS, art. 18). Whether and how SIPGES may
send real personal data to a model hosted outside Peru is a legal decision that has not been taken
([workspace-architecture T8](../../odd/tasks/workspace-architecture.md)). Until then the system
must make the safe behaviour the only behaviour. This ADR is technical support for that decision,
not legal advice.

## Decision

One guard, `contexts/privacy`, in front of every egress path.

1. **Switch.** `externalAi: { enabled }` in the project settings (`project_settings`, no
   migration), **off by default**, editable only by administrators through
   `PUT /system/v4/settings` («Envío a IA externa» in Configuración). While off, MCP data tools
   answer with an MCP error («El envío a IA externa está desactivado para este proyecto»), the
   narrator is not called (the extractive briefing stays) and embeddings to a non-loopback URL
   are refused. The static catalogue (`list_object_types`), the write tools (`create_record`,
   `link_records`) and embeddings to a loopback URL are not egress and keep working.
2. **Restricted records never leave.** The guard withholds whole any record whose classification
   marking is `restringido` (or missing or unknown), whatever the clearance of the MCP key or
   user: it is left out of every list, its fields count as dropped, and its id appears as
   «retenidos» in the access log, never its content.
3. **Allowlist.** `privacy/domain/allowlist.ts` lists, per module, the fields that may leave and
   why each is not sensitive. Everything else is dropped, including fields added or imported
   later. Political opinion or stance, ethnic origin, health, religion, union membership, income,
   biometrics, contact data and identity numbers are never listed (a test enforces it); contact
   fields are dropped, not pseudonymised.
4. **Pseudonyms.** People and organisations leave as stable pseudonyms (`Actor-7F3A1C`,
   `Persona-…`, `Org-…`): HMAC-SHA256 of the kind and the folded name under a key derived from
   `SIPGES_DATA_KEY` and the project, so the same name maps to the same token inside a project and
   to another in a different project. Nothing is stored or returned: the mapping is recomputable
   only inside SIPGES. Known names of the project (every person or organisation field in any
   module, participant lists split into people, and fields never sent such as `Remitente`, read
   with full clearance) are also replaced inside free text, whatever the case or accents, including
   half a name cut by the ontology's `…`. Emails, phone numbers (Peruvian formats) and DNI (eight
   digits next to the word that names it) become `[correo]`, `[teléfono]`, `[DNI]`.
   Search over MCP matches only fields that may leave: a record found only through a dropped
   field (a stance, a health note, a complainant) or only by meaning is not returned, so a hit
   never reveals what such a field holds. A restricted record asked for by id (`get_record`,
   `get_links`, `get_briefing`) answers with a `withheld` stub.
5. **Access log.** Every release writes one row in the append-only audit (module «IA externa»,
   action `EGRESS`): channel, tool or purpose, actor (user name, or API key name and id), record
   ids, fields sent and dropped, characters. Never values. It shows in Auditoría. The log is
   written before the payload is sealed; if it fails, nothing leaves.
6. **No bypass.** Adapters and tool results accept only `SanitisedPayload<T>`, a branded type
   that only the guard seals (`narrate`, `embed`, `ToolResult.data`). A structural test pins the
   constructors that skip sanitising (constants, a write's own id, loopback text), the modules
   that import the Anthropic SDK or call `fetch`, and the shape of every MCP tool, so a new egress
   path cannot be added silently. Embedders and narrators must declare `egress: 'local' |
   'external'`; anything not `local` is treated as external.
7. **No real-names mode.** There is no setting that sends real names. Adding one needs the legal
   decision above and a new ADR.

## Consequences

- With the switch off (the default, also in production) no tenant data reaches an external model
  or MCP client. T3 verifies that in production.
- MCP agents and the narrator see less: no stance, no contact, no complaint text, pseudonyms
  instead of names. Briefings for the signed-in team keep the real names; the model's prose may
  quote pseudonyms. A reverse mapping for display is a possible follow-up.
- Free text is scrubbed of known names and contact patterns, not understood: a name nobody
  registered, or a sensitive fact written in a free-text field, can still pass. Free-text fields
  are therefore on the allowlist only where their content is documented work, and the owner's
  legal review should cover that residual risk.
- Pseudonymised data is still personal data under Ley 29733: the switch does not replace consent.
- Automation channels to webhooks, Slack and similar (ADR 0014) are user-configured destinations,
  not AI services, and keep their own rule (restricted content never leaves); they are out of scope.
- Hosting is itself outside Peru (Neon, Cloudflare R2). Their regions and data-processing terms
  belong to the owner's legal review.
- A project key is derived from `SIPGES_DATA_KEY`; rotating that key changes every pseudonym.
