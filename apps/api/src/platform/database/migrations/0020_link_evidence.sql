-- Optional provenance for explicit relationships. Keep the id after source deletion so
-- readers can distinguish unavailable evidence from links that were never documented.
-- Application writes validate Fuentes and both endpoints under RLS in one transaction.
ALTER TABLE record_links ADD COLUMN evidence_source_id text
  CHECK (evidence_source_id IS NULL OR
    (char_length(evidence_source_id) BETWEEN 1 AND 200));
GRANT UPDATE (evidence_source_id) ON record_links TO mascli_tenant;
CREATE POLICY tenant_update_evidence ON record_links FOR UPDATE
  USING (tenant_id = current_setting('app.tenant_id', true)
    AND EXISTS (SELECT 1 FROM module_records r WHERE r.tenant_id = record_links.tenant_id
      AND r.module = record_links.source_module AND r.id = record_links.source_id)
    AND EXISTS (SELECT 1 FROM module_records r WHERE r.tenant_id = record_links.tenant_id
      AND r.module = record_links.target_module AND r.id = record_links.target_id))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true));

-- Private forensic retention: preserve before/after source ids even after sources or
-- links are deleted. No foreign keys/cascades and no public endpoint. Runtime may only
-- append; recovery requires a privileged operator connection outside the application.
-- Generic audit deliberately omits these potentially restricted identifiers.
CREATE TABLE link_evidence_history (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id text NOT NULL,
  link_id integer NOT NULL,
  previous_source_id text,
  next_source_id text,
  actor text NOT NULL,
  at timestamptz NOT NULL
);
CREATE INDEX link_evidence_history_link ON link_evidence_history (tenant_id, link_id, id);
ALTER TABLE link_evidence_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE link_evidence_history FORCE ROW LEVEL SECURITY;
REVOKE ALL ON link_evidence_history FROM PUBLIC, mascli_tenant;
GRANT INSERT ON link_evidence_history TO mascli_tenant;
CREATE POLICY tenant_append_evidence_history ON link_evidence_history FOR INSERT
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)
    AND actor = COALESCE(NULLIF(current_setting('app.actor', true), ''), 'sistema')
    AND EXISTS (SELECT 1 FROM record_links l
      WHERE l.tenant_id = link_evidence_history.tenant_id AND l.id = link_evidence_history.link_id));

-- A database owner without BYPASSRLS can recover one tenant's forensic history by
-- setting app.tenant_id in its privileged transaction. Runtime still has no SELECT
-- grant, and this policy rejects its role even if that grant is changed accidentally.
-- This is database operator recovery only; there is no public application endpoint.
CREATE POLICY operator_read_evidence_history ON link_evidence_history FOR SELECT
  USING (current_user <> 'mascli_tenant'
    AND tenant_id = current_setting('app.tenant_id', true));
