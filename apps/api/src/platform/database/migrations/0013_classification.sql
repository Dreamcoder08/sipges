-- Classification markings (docs/adr/0012-observability-and-classification.md).
-- Every record carries a marking. Rows marked 'restringido' are invisible unless the tenant
-- transaction runs with app.clearance = 'full' (set by withTenant from the session role).
-- Unknown or missing clearance is treated as limited: the check fails closed.

ALTER TABLE module_records ADD COLUMN marking text NOT NULL DEFAULT 'interno'
  CHECK (marking IN ('publico', 'interno', 'restringido'));

CREATE FUNCTION mascli_can_see(marking text) RETURNS boolean
  LANGUAGE sql STABLE PARALLEL SAFE AS $$
  SELECT marking <> 'restringido' OR current_setting('app.clearance', true) = 'full'
$$;
GRANT EXECUTE ON FUNCTION mascli_can_see(text) TO mascli_tenant;

DROP POLICY tenant_rows ON module_records;
CREATE POLICY tenant_rows ON module_records
  USING (tenant_id = current_setting('app.tenant_id', true) AND mascli_can_see(marking))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true));

-- History follows the record's current marking.
ALTER TABLE record_versions ADD COLUMN marking text NOT NULL DEFAULT 'interno';
DROP POLICY tenant_rows ON record_versions;
CREATE POLICY tenant_rows ON record_versions FOR SELECT
  USING (tenant_id = current_setting('app.tenant_id', true) AND mascli_can_see(marking));
CREATE POLICY trigger_updates ON record_versions FOR UPDATE USING (true) WITH CHECK (true);

CREATE OR REPLACE FUNCTION record_version_capture() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  actor text := COALESCE(NULLIF(current_setting('app.actor', true), ''), 'sistema');
BEGIN
  IF TG_OP = 'DELETE' THEN
    INSERT INTO record_versions (tenant_id, module, record_id, operation, payload, actor, at, marking)
    VALUES (OLD.tenant_id, OLD.module, OLD.id, 'DELETE', NULL, actor, clock_timestamp(), OLD.marking);
    RETURN OLD;
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.marking IS DISTINCT FROM OLD.marking THEN
    UPDATE record_versions SET marking = NEW.marking
    WHERE tenant_id = NEW.tenant_id AND module = NEW.module AND record_id = NEW.id;
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.payload IS NOT DISTINCT FROM OLD.payload THEN
    RETURN NEW;
  END IF;
  INSERT INTO record_versions (tenant_id, module, record_id, operation, payload, actor, at, marking)
  VALUES (NEW.tenant_id, NEW.module, NEW.id,
          CASE TG_OP WHEN 'INSERT' THEN 'CREATE' ELSE 'UPDATE' END,
          NEW.payload, actor, NEW.updated_at, NEW.marking);
  RETURN NEW;
END;
$$;

-- Attachments and links are visible only when every record they touch is visible.
DROP POLICY tenant_rows ON attachments;
CREATE POLICY tenant_read ON attachments FOR SELECT
  USING (tenant_id = current_setting('app.tenant_id', true) AND EXISTS (
    SELECT 1 FROM module_records r
    WHERE r.tenant_id = attachments.tenant_id AND r.module = attachments.record_module
      AND r.id = attachments.linked_record_id));
CREATE POLICY tenant_insert ON attachments FOR INSERT
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true));
CREATE POLICY tenant_delete ON attachments FOR DELETE
  USING (tenant_id = current_setting('app.tenant_id', true));

DROP POLICY tenant_rows ON record_links;
CREATE POLICY tenant_read ON record_links FOR SELECT
  USING (tenant_id = current_setting('app.tenant_id', true)
    AND EXISTS (SELECT 1 FROM module_records r WHERE r.tenant_id = record_links.tenant_id
                  AND r.module = record_links.source_module AND r.id = record_links.source_id)
    AND EXISTS (SELECT 1 FROM module_records r WHERE r.tenant_id = record_links.tenant_id
                  AND r.module = record_links.target_module AND r.id = record_links.target_id));
CREATE POLICY tenant_insert ON record_links FOR INSERT
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true));
CREATE POLICY tenant_delete ON record_links FOR DELETE
  USING (tenant_id = current_setting('app.tenant_id', true));
