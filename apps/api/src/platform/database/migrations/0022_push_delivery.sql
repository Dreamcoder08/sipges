-- Additive; rollback retains delivery history.
ALTER TABLE notifications ADD COLUMN run_id integer;
ALTER TABLE notifications ADD CONSTRAINT notifications_run_unique UNIQUE (tenant_id,run_id);
GRANT UPDATE ON notifications TO mascli_tenant;
CREATE TABLE push_deliveries (
 id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 tenant_id text NOT NULL REFERENCES tenants(tenant_id) ON DELETE CASCADE,
 notification_id integer NOT NULL REFERENCES notifications(id) ON DELETE CASCADE,
 endpoint text NOT NULL,username text NOT NULL,restricted boolean NOT NULL,payload jsonb NOT NULL,
 status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','accepted','failed')),
 attempts integer NOT NULL DEFAULT 0,next_attempt_at timestamptz NOT NULL,last_error text NOT NULL DEFAULT '',
 UNIQUE(notification_id,endpoint)
);
CREATE INDEX push_deliveries_due ON push_deliveries(tenant_id,status,next_attempt_at);
ALTER TABLE push_deliveries ENABLE ROW LEVEL SECURITY;
ALTER TABLE push_deliveries FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_rows ON push_deliveries USING(tenant_id=current_setting('app.tenant_id',true)) WITH CHECK(tenant_id=current_setting('app.tenant_id',true));
GRANT SELECT,INSERT,UPDATE ON push_deliveries TO mascli_tenant;
