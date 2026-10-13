-- Evidence attachments (docs/migration/evidence.md): metadata only; file bytes live in the
-- object storage adapter. Tenant-owned under forced RLS like module_records.

CREATE TABLE attachments (
  tenant_id        text NOT NULL,
  id               text NOT NULL,
  storage_key      text NOT NULL,
  original_name    text NOT NULL,
  content_type     text NOT NULL,
  size_bytes       bigint NOT NULL CHECK (size_bytes > 0),
  sha256           text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  linked_module    text NOT NULL,
  record_module    text NOT NULL,
  linked_record_id text NOT NULL,
  document_type    text NOT NULL,
  author           text NOT NULL,
  verification     text NOT NULL,
  notes            text NOT NULL,
  project_id       text NOT NULL,
  project_name     text NOT NULL,
  created_at       timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, id),
  UNIQUE (storage_key),
  -- Deleting a record deletes its attachment rows (docs/adr/0008 #10).
  FOREIGN KEY (tenant_id, record_module, linked_record_id)
    REFERENCES module_records (tenant_id, module, id) ON DELETE CASCADE
);
CREATE INDEX attachments_recent ON attachments (tenant_id, created_at DESC, id DESC);
CREATE INDEX attachments_record ON attachments (tenant_id, record_module, linked_record_id);

ALTER TABLE attachments ENABLE ROW LEVEL SECURITY;
ALTER TABLE attachments FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_rows ON attachments
  USING (tenant_id = current_setting('app.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true));

-- No UPDATE grant: metadata is immutable once written; rows go away only with their record.
GRANT SELECT, INSERT, DELETE ON attachments TO mascli_tenant;
