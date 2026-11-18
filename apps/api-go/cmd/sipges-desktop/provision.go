package main

import (
	"context"
	"fmt"

	"github.com/jackc/pgx/v5"
)

// The roles and database of deploy/local/db-init/10-roles.sh, which the local install runs once on
// an empty volume (TestRolesMatchTheLocalInstall pins them to it). The API logs in as appRole,
// which owns the tables and cannot bypass row-level security; the migrations name both tenant
// roles, and an owner without CREATEROLE cannot create them. The backup role is left out: the
// desktop has no backup job on this server yet.
const (
	appRole              = "sipges_app"
	appDatabase          = "sipges"
	appRoleAttributes    = "NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS"
	tenantRoleAttributes = "NOLOGIN NOINHERIT"
	grantTenantRoles     = "GRANT mascli_tenant, sipges_tenant TO " + appRole + " WITH ADMIN OPTION"
	revokePublic         = "REVOKE ALL ON DATABASE " + appDatabase + " FROM PUBLIC"
)

var tenantRoles = []string{"mascli_tenant", "sipges_tenant"}

// provision creates what is missing and sets the API login's password, so every start converges
// on the same roles whatever a previous start completed.
func provision(ctx context.Context, superURL, appPassword string) error {
	conn, err := pgx.Connect(ctx, superURL)
	if err != nil {
		return fmt.Errorf("connect as superuser: %w", err)
	}
	defer func() { _ = conn.Close(context.WithoutCancel(ctx)) }()

	if err := createRoleIfMissing(ctx, conn, appRole, "LOGIN "+appRoleAttributes); err != nil {
		return err
	}
	// The password is quoted by the server (%L), never spliced into the statement here.
	var setPassword string
	if err := conn.QueryRow(ctx, "SELECT format('ALTER ROLE "+appRole+" LOGIN PASSWORD %L "+appRoleAttributes+"', $1::text)", appPassword).Scan(&setPassword); err != nil {
		return fmt.Errorf("quote the %s password: %w", appRole, err)
	}
	if _, err := conn.Exec(ctx, setPassword); err != nil {
		return fmt.Errorf("set the %s password: %w", appRole, err)
	}
	for _, role := range tenantRoles {
		if err := createRoleIfMissing(ctx, conn, role, tenantRoleAttributes); err != nil {
			return err
		}
	}
	if _, err := conn.Exec(ctx, grantTenantRoles); err != nil {
		return fmt.Errorf("grant the tenant roles: %w", err)
	}
	var exists bool
	if err := conn.QueryRow(ctx, "SELECT EXISTS (SELECT 1 FROM pg_database WHERE datname = $1)", appDatabase).Scan(&exists); err != nil {
		return fmt.Errorf("look for the database: %w", err)
	}
	if !exists {
		if _, err := conn.Exec(ctx, "CREATE DATABASE "+appDatabase+" OWNER "+appRole); err != nil {
			return fmt.Errorf("create the database: %w", err)
		}
	}
	if _, err := conn.Exec(ctx, revokePublic); err != nil {
		return fmt.Errorf("revoke public access: %w", err)
	}
	return nil
}

// createRoleIfMissing runs CREATE ROLE for one of the fixed names above.
func createRoleIfMissing(ctx context.Context, conn *pgx.Conn, role, attributes string) error {
	var exists bool
	if err := conn.QueryRow(ctx, "SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = $1)", role).Scan(&exists); err != nil {
		return fmt.Errorf("look for role %s: %w", role, err)
	}
	if exists {
		return nil
	}
	if _, err := conn.Exec(ctx, "CREATE ROLE "+role+" "+attributes); err != nil {
		return fmt.Errorf("create role %s: %w", role, err)
	}
	return nil
}
