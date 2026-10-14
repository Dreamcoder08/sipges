-- Decisions on analyst proposals (docs/adr/0014 §8): a proposal someone approved or discarded
-- is never offered again. Open proposals are computed, not stored.

CREATE TABLE proposal_decisions (
  tenant_id      text NOT NULL REFERENCES tenants (tenant_id) ON DELETE CASCADE,
  fingerprint    text NOT NULL CHECK (char_length(fingerprint) <= 500),
  subject_module text NOT NULL,
  subject_id     text NOT NULL,
  kind           text NOT NULL CHECK (kind IN ('link', 'record')),
  decision       text NOT NULL CHECK (decision IN ('approved', 'rejected')),
  result         text,
  decided_by     text NOT NULL,
  decided_at     timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, fingerprint)
);

ALTER TABLE proposal_decisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE proposal_decisions FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_rows ON proposal_decisions
  USING (tenant_id = current_setting('app.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true));
GRANT SELECT, INSERT ON proposal_decisions TO mascli_tenant;
