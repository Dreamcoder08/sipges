-- Idempotency receipts of inbound webhooks (docs/adr/0014 §6). A retried call with the same
-- key replays the stored answer instead of creating the records again.

CREATE TABLE ingest_receipts (
  tenant_id  text NOT NULL REFERENCES tenants (tenant_id) ON DELETE CASCADE,
  key_id     integer NOT NULL REFERENCES api_keys (id) ON DELETE CASCADE,
  idem_key   text NOT NULL CHECK (char_length(idem_key) BETWEEN 1 AND 200),
  -- NULL while the first call is still running.
  response   jsonb,
  created_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, key_id, idem_key)
);

ALTER TABLE ingest_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE ingest_receipts FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_rows ON ingest_receipts
  USING (tenant_id = current_setting('app.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true));
GRANT SELECT, INSERT, UPDATE, DELETE ON ingest_receipts TO mascli_tenant;
