# 0011 — Ontology, links and provenance

## Context
Every territorial record is an untyped `payload jsonb` row in `module_records` (ADR 0003). Records cannot point at each other, an edit overwrites the previous payload, and the audit trail keeps only a sentence. Analysis platforms such as Palantir Foundry are built on an *ontology*: typed objects, typed links between them and a history of who changed what. The owner asked for that level ([ODD](../../odd/archive/ontology-intelligence-platform.md)).

## Decision
1. **Object types are the existing modules.** The server owns one catalog (`contexts/ontology/domain/catalog.ts`) with each type's label, title field and summary fields, served at `GET /system/ontology`. Payloads stay `jsonb`; the catalog describes them without forcing a schema migration of legacy data.
2. **Typed links.** `record_links` stores directed links `source → target` with a link type from the catalog (for example *Actor participa en Evento*, *Compromiso responde a Demanda*). Each type lists the source and target object types it accepts; the API rejects anything else. Both ends reference `module_records` with `ON DELETE CASCADE`, so a link never outlives its records. The table is tenant-owned under forced RLS like every business table.
3. **Inferred links.** Reference fields already present in payloads (`Fuente_ID`, `Alerta_Asociada`) are read as links at query time when they match an existing record id. They are marked `inferred` and cannot be deleted through the links API; editing the field is the way to change them.
4. **History by trigger.** An `AFTER INSERT OR UPDATE OR DELETE` trigger on `module_records` appends the full payload to `record_versions` with a per-record version number and the actor taken from the transaction-local `app.actor`. Every writer (records, evidence, migration tools) is covered without code changes. The application role has `SELECT, INSERT` only, so history is append-only. Existing rows get a version 1 baseline in the migration.
5. **Search.** An expression GIN index on `record_search_document(id, payload)` (top-level payload values plus the id, lower-cased, Spanish accents removed, `simple` configuration without stemming so prefixes match while typing). Queries require every term as a prefix and are ranked with `ts_rank`. An expression index leaves `module_records` columns and the export unchanged.
6. **Graph.** `GET /system/graph` returns the n-hop neighbourhood (at most 2 hops and 150 nodes) of one record from explicit and inferred links, computed in one tenant transaction.
7. **Timeline.** `GET /system/timeline?from=&to=&modules=` lists records of every object type with a date field whose date (first ten characters, ISO `yyyy-mm-dd`) falls in the range, newest first, at most 500 per call with a `truncated` flag. Bounds accept a year, a month or a day. The territorial map filters its points by the same kind of month range.

## Consequences
- Records keep their HTTP contract (ADR 0007); history, links, search and graph are new endpoints.
- History stores full payloads, so storage grows with edits. Attachments are not versioned (their metadata lives in the payload and is).
- The tenant export allowlist (ADR 0008 #7) adds `record_links` and `record_versions`.
- Tests: `apps/api/test/ontology/*`, `apps/api/test/records/history-http.test.ts`.

## References
Palantir Foundry Ontology documentation (object types, link types, action types); PostgreSQL 17 manual §12 (full text search) and §5.9 (row security policies).
