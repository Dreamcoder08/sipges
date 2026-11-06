# ADR 0027 — SIPGES is the only behaviour

- Status: Accepted
- Date: 2026-10-26
- Task: `odd/tasks/sipges-4-only.md`
- Supersedes: ADR 0020 §1 (per-project switch) and the "3.0 stays intact" rule of ADR 0021

## Context

ADR 0020 shipped SIPGES behind a per-project switch (`project_settings.version4`, default
off) so SIPGES 3.0 kept working unchanged. Every 4.0 rule therefore had a 3.0 twin: plan
closing with or without an evidence file, one or two people for high-priority alerts, IRSA with
or without phase weights, colour labels with or without meaning, the media monitor on or off,
and a web menu with or without the 4.0 screens. The owner asked for everything to be 4.0 and for
the redundancy to go: «quiero que todo este en 4.0 , objetivo actualizar todo , eliminar
redundancia».

## Decision

1. **No switch.** Every project runs SIPGES. The `version4` setting leaves the domain, the
   settings contract and the web app. A `version4` key already stored in
   `project_settings.settings` is ignored; it is not migrated or deleted. The settings API never
   returns it; the raw tenant export (`sipges-tenant.json`) still carries stored rows as they are.
2. **4.0 rules are unconditional.** Closing a preventive action as `Completada` needs an attached
   evidence file (ADR 0023); an `Alta` alert needs a second person; IRSA uses the phase weights
   saved for the current phase (ADR 0021); colour labels always carry their meaning; the media
   monitor fetches only the feeds a project configured and did not pause.
3. **Stored history stays readable.** The `evidence_url` column, the legacy import that fills it,
   the stored `Origen = 'SIPGES'` value of generated alerts and the `'SIPGES'` audit
   module are data, not branches, and stay.
4. **Per-project configuration stays.** Colour meanings, thresholds, recommendation catalogue,
   phase, phase weights and RSS feeds remain editable by project administrators.
5. **The product is named SIPGES** in visible branding.

## Consequences

- One code path per rule: fewer ports, tests and screens to keep in step.
- Behaviour changes for projects that had the switch off: plans need an evidence file to
  close, `Alta` alerts need two people, IRSA follows saved phase weights, and configured feeds
  are fetched. These are the 4.0 rules those projects had not turned on yet.
- Clients that closed plans with only a URL now receive `evidence_required`.
- Rolling back means restoring the switch in code, and it is not data-neutral: every settings
  save since this change drops a stored `version4` key, so after a rollback those projects
  read the old default (switch off, SIPGES 3.0) until an administrator turns 4.0 on again.
- Deployment and production activation still need the owner's word.
