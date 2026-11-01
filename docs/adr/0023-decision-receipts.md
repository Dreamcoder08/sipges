# ADR 0023 — SIPGES: decision receipts on preventive actions

- Status: Accepted
- Date: 2026-10-19
- Origin: proposal "Gentle SIPGES" (receipt-driven development applied to the product)

## Context

Closing a preventive action claims that the risk behind a verified alert was addressed. In
SIPGES 3.0 the progress entry keeps a free `evidence_url`: nothing proves which evidence the
person saw, the file behind the link can change, and the audit row does not say who decided.
Evidence files already store their `sha256` on upload. Gentle AI's RDD binds a review to the
exact candidate with a receipt; the same idea fits a decision in the field.

## Decision

1. **A receipt is optional data on a progress entry**: the attachment id, its file name and its
   `sha256` frozen at decision time, plus the username that recorded the entry
   (`preventive_action_log.decided_by`, migration 0027). The audit detail carries the first 12
   hex characters of the hash.
2. **Only completion needs one, and only with SIPGES on.** Progress updates and
   cancellations stay as light as before. With the switch off the field is ignored, so 3.0
   behaves exactly as before; `decided_by` is still recorded for every new entry.
3. **The file must belong to the scope.** The lookup goes through the Evidence context with the
   active tenant, so a file of another project answers "not found".

## Consequences

- An auditor can match a closed action to the exact file that justified it and to its author.
- Replacing the file later does not change the receipt; a new decision needs a new entry.
- Older entries and migrated history carry no receipt (`receipt: null`).
