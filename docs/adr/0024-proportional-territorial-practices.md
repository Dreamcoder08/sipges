# ADR 0024 — MASCLI 4.0: proportional practices for territorial risk work

- Status: Accepted
- Date: 2026-10-19
- Origin: proposal "Gentle MASCLI", after ADR 0023 (decision receipts)

## Context

The Gentle AI practices the team follows to build MASCLI share one rule: ceremony scales with
risk, not with size. The same rule fits the social-risk work done inside MASCLI. Every change
here is behind the per-project MASCLI 4.0 switch (ADR 0020); with it off, 3.0 is unchanged.

## Decision

1. **Four eyes only where it matters.** A high-priority (`Alta`) alert needs two different
   people to move into an actionable state (`Corroborado` or `En seguimiento`). The first
   validation is recorded (`first_validator`, migration 0028) and audited without changing the
   status; the same person cannot confirm it (409). Medium and low alerts, discarding, and
   moves between actionable states stay with one person. Preventive plans already require an
   actionable alert, so a high-priority plan now always follows two validations.

## Consequences

- A single person can no longer trigger the response to the most serious alerts alone.
- The rule reads the first validation and then writes; two people confirming at the same
  instant may both pass the check, which still leaves two distinct validators.
