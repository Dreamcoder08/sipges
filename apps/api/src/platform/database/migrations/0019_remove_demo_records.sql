-- Removes the synthetic academic case (`demo:seed`, dataset mascli-academic-v1) so each project
-- keeps only its own records. A demo record carries `Dato_Sintetico: true` or a non-empty
-- `Demo_Dataset` in its payload; nothing people entered, imported or migrated has those keys.
-- Evidence, links and embeddings of those records go with them (ON DELETE CASCADE); the
-- history trigger records each deletion. Tables use forced RLS, so every tenant is visited with
-- its own app.tenant_id and full clearance (restricted rows included).

DO $$
DECLARE
  tenant text;
BEGIN
  PERFORM set_config('app.clearance', 'full', true);
  PERFORM set_config('app.actor', 'migración', true);
  FOR tenant IN SELECT tenant_id FROM tenants LOOP
    PERFORM set_config('app.tenant_id', tenant, true);
    DELETE FROM attachments
    WHERE notes ~ 'mascli-academic-v1:DEMO-[A-Z]+-[0-9]+';
    DELETE FROM module_records
    WHERE payload->'Dato_Sintetico' = 'true'::jsonb
       OR COALESCE(payload->>'Demo_Dataset', '') <> '';
    DELETE FROM irsa_snapshots
    WHERE note LIKE 'DEMO mascli-academic-v1:%';
  END LOOP;
  PERFORM set_config('app.tenant_id', '', true);
END
$$;
