# ADR 0024 — SIPGES: proportional practices for territorial risk work

- Status: Accepted
- Date: 2026-10-19
- Origin: proposal "Gentle SIPGES", after ADR 0023 (decision receipts)

## Context

The Gentle AI practices the team follows to build SIPGES share one rule: ceremony scales with
risk, not with size. The same rule fits the social-risk work done inside SIPGES. Every change
here is behind the per-project SIPGES switch (ADR 0020); with it off, 3.0 is unchanged.

## Decision

1. **Four eyes only where it matters.** A high-priority (`Alta`) alert needs two different
   people to move into an actionable state (`Corroborado` or `En seguimiento`). The first
   validation is recorded (`first_validator`, migration 0028) and audited without changing the
   status; the same person cannot confirm it (409). Medium and low alerts, discarding, and
   moves between actionable states stay with one person. Preventive plans already require an
   actionable alert, so a high-priority plan now always follows two validations.
2. **A situation room instead of status meetings.** A preventive action can say who it waits
   on (`Comunidad`, `Autoridad`, `Área interna`, `Contratista`, `Otro`) and why (migration
   0029). The waiting time keeps counting while it waits on the same party; closing a plan
   clears it. `GET /system/prevention/situation-room` lists blocked plans by party, overdue
   ones and how many move normally; the Centro gerencial shows it with SIPGES on.
3. **Rules change scenario first.** `docs/escenarios/alertas.md` (text → expected priority and
   signals) and `docs/escenarios/irsa.md` (dimension scores → expected traffic light with the
   default configuration) are plain tables the social team can read and edit. A test runs every
   row in `pnpm verify`, so changing a classifier rule, an IRSA weight or a threshold starts by
   writing the row it must satisfy. It only checks existing behaviour; it changes none, so it
   needs no switch.
4. **Lessons stay with the territory.** What the team learns about a territory, topic or actor is
   a records module, `Lecciones_Territoriales` (prefix `LEC`, screen Lecciones with SIPGES on):
   what happened, why, what was learned and the record it cites. A situation shows the lessons
   whose territory, topic or actor matches its key, newest first. Lessons never change a score.
   They live in PostgreSQL under the project's row-level security, never in Engram, which is
   repository memory and must not hold real data. No migration: records modules share one table.

## Consequences

- A single person can no longer trigger the response to the most serious alerts alone.
- Management sees what is stuck and on whom without asking for a weekly status report.
- Specialists can see and challenge what the rules promise without reading code.
- The next person working a conflict sees what was learned last time before acting.
- The rule reads the first validation and then writes; two people confirming at the same
  instant may both pass the check, which still leaves two distinct validators.
