-- Stored embeddings for hybrid search (docs/adr/0014 §9). Plain real[] keeps PGlite and any
-- PostgreSQL working without extensions; ranking is done in the application over the
-- records the reader may see, which are few per project.

CREATE TABLE record_embeddings (
  tenant_id   text NOT NULL,
  module      text NOT NULL,
  id          text NOT NULL,
  model       text NOT NULL CHECK (char_length(model) <= 100),
  vector      real[] NOT NULL CHECK (cardinality(vector) BETWEEN 8 AND 4096),
  -- md5 of the payload that was embedded; a different payload means the vector is stale.
  source_hash text NOT NULL,
  embedded_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, module, id),
  FOREIGN KEY (tenant_id, module, id) REFERENCES module_records (tenant_id, module, id)
    ON DELETE CASCADE ON UPDATE CASCADE
);

ALTER TABLE record_embeddings ENABLE ROW LEVEL SECURITY;
ALTER TABLE record_embeddings FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_rows ON record_embeddings
  USING (tenant_id = current_setting('app.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true));
GRANT SELECT, INSERT, UPDATE, DELETE ON record_embeddings TO mascli_tenant;
