-- Document lab verification inbox (app.py document_review, docs/migration/documents.md):
-- excerpts of candidate findings and the reviewer's decision; never the source document.

CREATE TABLE document_review (
  tenant_id     text NOT NULL,
  id            text NOT NULL,
  project_id    text NOT NULL,
  source_file   text NOT NULL,
  source_sha256 text NOT NULL CHECK (source_sha256 ~ '^[0-9a-f]{64}$'),
  location      text NOT NULL,
  theme         text NOT NULL,
  excerpt       text NOT NULL,
  action        text NOT NULL,
  status        text NOT NULL CHECK (status IN
                  ('pendiente', 'aceptado_para_revision', 'descartado', 'corroborado_documentalmente')),
  reviewer      text NOT NULL DEFAULT '',
  note          text NOT NULL DEFAULT '',
  created_at    timestamptz NOT NULL,
  updated_at    timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, project_id, source_sha256, location, theme, excerpt)
);
CREATE INDEX document_review_recent ON document_review (tenant_id, project_id, created_at DESC);

ALTER TABLE document_review ENABLE ROW LEVEL SECURITY;
ALTER TABLE document_review FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_rows ON document_review
  USING (tenant_id = current_setting('app.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true));

GRANT SELECT, INSERT, UPDATE ON document_review TO mascli_tenant;
