-- Territorial alert inbox and preventive action plans (docs/migration/operations.md).
-- Tenant-owned under forced RLS; neither table feeds IRSA.

CREATE TABLE digital_alert_reviews (
  tenant_id       text NOT NULL,
  id              text NOT NULL,
  project_id      text NOT NULL,
  created_at      timestamptz NOT NULL,
  source_url      text NOT NULL,
  source_type     text NOT NULL,
  excerpt         text NOT NULL,
  sha256          text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  level           text NOT NULL,
  score           integer NOT NULL,
  method          text NOT NULL,
  themes          jsonb NOT NULL,
  signals         jsonb NOT NULL,
  suggestions     jsonb NOT NULL,
  semantic_active boolean NOT NULL,
  status          text NOT NULL CHECK (status IN
                    ('Pendiente de verificación', 'Corroborado', 'Descartado', 'En seguimiento')),
  analyst_note    text NOT NULL,
  reviewer_note   text,
  reviewed_at     timestamptz,
  PRIMARY KEY (tenant_id, id)
);
CREATE INDEX digital_alert_reviews_recent
  ON digital_alert_reviews (tenant_id, project_id, created_at DESC);

CREATE TABLE preventive_actions (
  tenant_id   text NOT NULL,
  id          text NOT NULL,
  project_id  text NOT NULL,
  alert_id    text NOT NULL,
  title       text NOT NULL,
  responsible text NOT NULL,
  due_date    text NOT NULL CHECK (due_date ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'),
  description text NOT NULL,
  status      text NOT NULL CHECK (status IN ('Pendiente', 'En ejecución', 'Completada', 'Cancelada')),
  progress    integer NOT NULL CHECK (progress BETWEEN 0 AND 100),
  created_at  timestamptz NOT NULL,
  updated_at  timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, alert_id) REFERENCES digital_alert_reviews (tenant_id, id)
);
CREATE INDEX preventive_actions_project ON preventive_actions (tenant_id, project_id, due_date);

CREATE TABLE preventive_action_log (
  tenant_id    text NOT NULL,
  id           text NOT NULL,
  action_id    text NOT NULL,
  created_at   timestamptz NOT NULL,
  status       text NOT NULL,
  progress     integer NOT NULL,
  note         text NOT NULL,
  evidence_url text,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, action_id) REFERENCES preventive_actions (tenant_id, id)
);
CREATE INDEX preventive_action_log_action ON preventive_action_log (tenant_id, action_id);

ALTER TABLE digital_alert_reviews ENABLE ROW LEVEL SECURITY;
ALTER TABLE digital_alert_reviews FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_rows ON digital_alert_reviews
  USING (tenant_id = current_setting('app.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true));

ALTER TABLE preventive_actions ENABLE ROW LEVEL SECURITY;
ALTER TABLE preventive_actions FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_rows ON preventive_actions
  USING (tenant_id = current_setting('app.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true));

ALTER TABLE preventive_action_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE preventive_action_log FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_rows ON preventive_action_log
  USING (tenant_id = current_setting('app.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true));

GRANT SELECT, INSERT, UPDATE ON digital_alert_reviews TO mascli_tenant;
GRANT SELECT, INSERT, UPDATE ON preventive_actions TO mascli_tenant;
-- The action log is append-only history.
GRANT SELECT, INSERT ON preventive_action_log TO mascli_tenant;
