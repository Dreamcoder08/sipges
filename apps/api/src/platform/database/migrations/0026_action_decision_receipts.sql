-- MASCLI 4.0 decision receipts (docs/adr/0021): an action log entry can name the evidence
-- file behind the decision, frozen with its sha256, and who decided. Nullable: 3.0 entries
-- and migrated history carry no receipt.
ALTER TABLE preventive_action_log
  ADD COLUMN decided_by text,
  ADD COLUMN evidence_attachment_id text,
  ADD COLUMN evidence_file_name text,
  ADD COLUMN evidence_sha256 text;
