# ADR 0021 — Media monitoring by RSS and project phase weights

- Status: Accepted
- Date: 2026-10-19
- Task: `odd/tasks/media-monitoring-project-phase.md`

## Context

The client expects MASCLI to watch regional media on its own and to weigh risk differently in
exploration, construction, operation and closure. Until now narratives arrive by hand, by
webhook or from the Defensoría connector (ADR 0014), and IRSA has one weight set per project.
MASCLI 3.0 must stay unchanged (ADR 0020) and no paid service or credential may be connected
without the data owner.

## Decision

1. **Public RSS/Atom feeds, configured per project.** An admin registers up to 20 feeds with a
   name, optional keywords and territory, and an authorization note. Only `https` URLs on
   public host names are accepted (no IP literals, ports, credentials or internal names);
   fetching refuses redirects, stops after 8 s and 1 MB, and parses with a small pure reader
   that ignores markup and keeps title, link, date and a plain-text summary.
2. **Idempotent import into Narrativas.** Each matching item becomes a Narrativas record with a
   canonical id `SRC-RSS-<feed>-<hash>` derived from its link or guid, created through the
   same importer as the Defensoría connector, so it gets a CREATE audit row and every
   automation rule (including `evaluate` on Narrativas) sees it. Items carry
   `Fecha_Observacion`, so situations count them.
3. **Polled by the existing cron.** The automation cron (`CRON_SECRET`) polls due feeds of
   each tenant before its tick, at most every 30 minutes per feed and 20 items per feed.
   Feeds of a project with MASCLI 4.0 off are never fetched.
4. **Phase in the 4.0 settings.** `project_settings` gains `phase` (exploración, construcción,
   operación, cierre or none) and optional per-phase weights over the six IRSA dimensions,
   summing to 1 ± 0.02. Preliminary suggestions are shown, never applied automatically. When
   4.0 is on and the current phase has saved weights, IRSA uses them and says so in its notes
   and a `phase` field; otherwise it is computed exactly as before.

## Consequences

- Monitoring needs no account or key; feeds behind logins or paid APIs stay out of scope.
- Keyword matching is literal (accent- and case-insensitive); relevance still needs people.
- Phase weights change the IRSA level only after an admin saves them, and are audited.
