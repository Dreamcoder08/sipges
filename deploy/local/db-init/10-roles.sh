#!/bin/bash
# Runs once, on an empty data volume, as the superuser. The API logs in as sipges_app, which owns
# the tables and holds no attribute that bypasses row-level security; Go refuses any other kind.
# The migrations still name mascli_tenant, and an owner without CREATEROLE cannot create either
# tenant role, so they exist first. sipges_backup bypasses row-level security because pg_dump
# cannot read a table under FORCE otherwise; it can read, not write, and only the backup job has it.
set -Eeuo pipefail
psql --no-psqlrc -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname postgres \
  -v app_password="$SIPGES_DB_PASSWORD" -v backup_password="$SIPGES_DB_BACKUP_PASSWORD" <<'SQL'
CREATE ROLE sipges_app LOGIN PASSWORD :'app_password' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
CREATE ROLE mascli_tenant NOLOGIN NOINHERIT;
CREATE ROLE sipges_tenant NOLOGIN NOINHERIT;
GRANT mascli_tenant, sipges_tenant TO sipges_app WITH ADMIN OPTION;
CREATE ROLE sipges_backup LOGIN PASSWORD :'backup_password' NOSUPERUSER NOCREATEDB NOCREATEROLE BYPASSRLS;
GRANT pg_read_all_data TO sipges_backup;
CREATE DATABASE sipges OWNER sipges_app;
REVOKE ALL ON DATABASE sipges FROM PUBLIC;
GRANT CONNECT ON DATABASE sipges TO sipges_backup;
SQL
