# ADR 0020 — SIPGES: related situations, explained alerts and a grievance mailbox

- Status: Accepted; §1 (per-project switch) superseded by [ADR 0027](0027-mascli-4-only.md)
- Date: 2026-10-19
- Task: `odd/tasks/mascli-4-situations.md`

## Context

The client wants SIPGES to relate facts, notice when a situation is growing, raise explained
alerts and suggest preventive actions, plus a mailbox for complaints and a visible audit trail.
SIPGES 3.0 (everything on `main` up to `046bb1a`) must keep working unchanged, the colour
meanings are preliminary, and sending territorial text to an external model needs the data
owner's approval (ADR 0013).

## Decision

1. **A per-project switch.** `project_settings` holds, per tenant, `version4` (default off), the
   four colour meanings and the situation thresholds and recommendation texts. Reading is open
   to every role of the project; changing it is admin-only and audited (`SIPGES`,
   `CONFIG_UPDATE`). With the switch off the web app shows exactly the 3.0 screens.
2. **Deterministic engine in its own context.** `situations` turns dated records (Eventos,
   Demandas, Compromisos, Narrativas, Alertas, Dialogos, Buzon) into signals and groups those
   sharing a topic, an actor or an explicit territory within a window. Territory comes only
   from Territorio/Comunidad/Localidad/Distrito, never from free text. Topics come from the
   record's own topic fields and a small, visible keyword list. Each signal weighs
   `0.5^(age / half-life)` times its recorded severity; a group is "en aumento" when the last
   week holds at least two signals and more than 1.5 times the previous weekly rate.
3. **Every conclusion cites its records.** A situation carries its level, the reasons that led
   to it as sentences and the ids of the records behind each one. Recommendations come from an
   editable catalogue keyed by fixed conditions (level, trend, modules involved); they orient
   and never act.
4. **People create alerts.** "Crear alerta" pre-fills an Alertas record with the level, the
   explanation and the suggested actions; the user confirms it through the records API, so
   history, markings and automation rules apply as for any alert. The engine writes nothing
   and never changes IRSA.
5. **AI later, behind a port.** Narrative repetition and tone change are rules today. A future
   assistant may read the same signals through a port enabled only by configuration and the
   data owner's approval, as the analyst narrator does.

## Consequences

- Turning 4.0 on or off is instant and reversible; no 3.0 data or behaviour changes.
- The engine reads all dated records of the project on request, fine at project scale.
- Thresholds and meanings need calibration with the client's methodology owner.
