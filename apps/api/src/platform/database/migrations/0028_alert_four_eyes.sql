-- MASCLI 4.0 four eyes (docs/adr/0024): the first person who validates a high-priority
-- alert, kept until a different person confirms it or the alert leaves the actionable states.
ALTER TABLE digital_alert_reviews
  ADD COLUMN first_validator text,
  ADD COLUMN first_validated_at timestamptz;
