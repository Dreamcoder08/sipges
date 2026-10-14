-- Typed links between territorial records (docs/adr/0011-ontology-links-and-provenance.md §2).
-- Both ends reference module_records, so deleting a record deletes its links.

CREATE TABLE record_links (
  id            integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY, -- int4: same JSON number on every driver
  tenant_id     text NOT NULL,
  link_type     text NOT NULL CHECK (link_type ~ '^[a-z_]{1,40}$'),
  source_module text NOT NULL,
  source_id     text NOT NULL,
  target_module text NOT NULL,
  target_id     text NOT NULL,
  note          text NOT NULL DEFAULT '' CHECK (char_length(note) <= 500),
  created_by    text NOT NULL,
  created_at    timestamptz NOT NULL,
  CHECK (source_module <> target_module OR source_id <> target_id),
  UNIQUE (tenant_id, link_type, source_module, source_id, target_module, target_id),
  FOREIGN KEY (tenant_id, source_module, source_id)
    REFERENCES module_records (tenant_id, module, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, target_module, target_id)
    REFERENCES module_records (tenant_id, module, id) ON DELETE CASCADE
);
CREATE INDEX record_links_target ON record_links (tenant_id, target_module, target_id);

ALTER TABLE record_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE record_links FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_rows ON record_links
  USING (tenant_id = current_setting('app.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true));

-- No UPDATE: a link is replaced by deleting it and creating another.
GRANT SELECT, INSERT, DELETE ON record_links TO mascli_tenant;
