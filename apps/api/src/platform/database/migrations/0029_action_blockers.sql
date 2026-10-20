-- MASCLI 4.0 situation room (docs/adr/0024 §2): who a preventive action is waiting on.
ALTER TABLE preventive_actions
  ADD COLUMN blocked_by text,
  ADD COLUMN blocked_reason text,
  ADD COLUMN blocked_since timestamptz;
