-- Additive provenance only: historical signals and audit rows remain unchanged.
ALTER TABLE digital_alert_reviews ADD COLUMN territory text;
ALTER TABLE digital_alert_reviews ADD COLUMN source_record jsonb;
ALTER TABLE audit ADD COLUMN event_payload jsonb;

-- A stable lock row serializes identical evidence without rewriting historical duplicates.
CREATE TABLE digital_signal_dedup_locks (
  tenant_id text NOT NULL REFERENCES tenants (tenant_id) ON DELETE CASCADE,
  dedup_key text NOT NULL,
  PRIMARY KEY (tenant_id, dedup_key)
);
ALTER TABLE digital_signal_dedup_locks ENABLE ROW LEVEL SECURITY;
ALTER TABLE digital_signal_dedup_locks FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_rows ON digital_signal_dedup_locks
  USING (tenant_id = current_setting('app.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true));
GRANT SELECT, INSERT, UPDATE ON digital_signal_dedup_locks TO mascli_tenant;
CREATE INDEX digital_alert_reviews_evidence
  ON digital_alert_reviews (tenant_id, sha256, created_at DESC);
