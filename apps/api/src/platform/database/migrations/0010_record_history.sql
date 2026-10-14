-- Record version history (docs/adr/0011-ontology-links-and-provenance.md §4).
-- A trigger appends the full payload of every change to module_records, so every writer is
-- covered. The application role can only read it: history is append-only by construction.

CREATE TABLE record_versions (
  id         integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY, -- int4: same JSON number on every driver
  tenant_id  text NOT NULL REFERENCES tenants (tenant_id) ON DELETE CASCADE,
  module     text NOT NULL,
  record_id  text NOT NULL,
  operation  text NOT NULL CHECK (operation IN ('BASELINE', 'CREATE', 'UPDATE', 'DELETE')),
  payload    jsonb,
  actor      text NOT NULL,
  at         timestamptz NOT NULL
);
CREATE INDEX record_versions_record ON record_versions (tenant_id, module, record_id, id);

ALTER TABLE record_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE record_versions FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_rows ON record_versions FOR SELECT
  USING (tenant_id = current_setting('app.tenant_id', true));
-- Only the trigger below inserts (mascli_tenant has no INSERT grant). The row's tenant is the
-- tenant of the module_records row, which that table's own policy already checked.
CREATE POLICY trigger_writes ON record_versions FOR INSERT WITH CHECK (true);
GRANT SELECT ON record_versions TO mascli_tenant;

CREATE FUNCTION record_version_capture() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  actor text := COALESCE(NULLIF(current_setting('app.actor', true), ''), 'sistema');
BEGIN
  IF TG_OP = 'DELETE' THEN
    INSERT INTO record_versions (tenant_id, module, record_id, operation, payload, actor, at)
    VALUES (OLD.tenant_id, OLD.module, OLD.id, 'DELETE', NULL, actor, clock_timestamp());
    RETURN OLD;
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.payload IS NOT DISTINCT FROM OLD.payload THEN
    RETURN NEW;
  END IF;
  INSERT INTO record_versions (tenant_id, module, record_id, operation, payload, actor, at)
  VALUES (NEW.tenant_id, NEW.module, NEW.id,
          CASE TG_OP WHEN 'INSERT' THEN 'CREATE' ELSE 'UPDATE' END,
          NEW.payload, actor, NEW.updated_at);
  RETURN NEW;
END;
$$;

CREATE TRIGGER module_records_history
  AFTER INSERT OR UPDATE OR DELETE ON module_records
  FOR EACH ROW EXECUTE FUNCTION record_version_capture();

INSERT INTO record_versions (tenant_id, module, record_id, operation, payload, actor, at)
SELECT tenant_id, module, id, 'BASELINE', payload, 'migración', updated_at
FROM module_records ORDER BY tenant_id, module, id;
