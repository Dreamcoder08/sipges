-- Tenancy (docs/adr/0003). Global tables; tenant-owned tables reference tenants.tenant_id and
-- are isolated by RLS policies evaluated as the least-privilege role mascli_tenant.

CREATE TABLE tenants (
  company_id text NOT NULL CHECK (company_id ~ '^[A-Za-z0-9_-]{2,64}$'),
  project_id text NOT NULL CHECK (project_id ~ '^[A-Za-z0-9_-]{2,64}$'),
  tenant_id  text GENERATED ALWAYS AS (company_id || '/' || project_id) STORED UNIQUE,
  label      text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, project_id)
);

CREATE TABLE grants (
  username   text NOT NULL REFERENCES users (username) ON DELETE CASCADE,
  tenant_id  text NOT NULL REFERENCES tenants (tenant_id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (username, tenant_id)
);

-- Roles are cluster-wide, so creation must be idempotent across databases.
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'mascli_tenant') THEN
    CREATE ROLE mascli_tenant NOLOGIN NOINHERIT;
  END IF;
END
$$;

-- The application role must be able to SET ROLE mascli_tenant inside tenant transactions.
GRANT mascli_tenant TO CURRENT_USER;
GRANT USAGE ON SCHEMA public TO mascli_tenant;
