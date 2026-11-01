# Tenancy foundation

The TypeScript API separates global access administration from tenant-owned business operations.

## Request ordering

1. Session authentication and Origin validation.
2. Scope resolution: `X-SIPGES-Scope`, then `sipges_scope`, then the only granted project.
3. Query and JSON body project checks on scoped routes.
4. Role authorization.
5. Route handler.

`/system/auth/scopes` and `/system/auth/grants` are global directory operations: they require a session and Origin validation, and writes require an administrator. The grant target is not a business-write scope (ADR 0008, correction 15).

`POST /select-project` accepts a `scope` form field, verifies a grant, sets the HttpOnly/SameSite=Strict scope cookie and redirects home. Cookie Secure policy is shared with session cookies.

## Access administration

All operations below require an authenticated administrator and pass the shared Origin check. Their targets are global directory entries, not business-write scopes.

| Operation | Request | Outcome |
|---|---|---|
| Revoke a project grant | `DELETE /system/auth/grants` with JSON `{ "username": "viewer", "company_id": "SIPGES", "project_id": "PRJ-SECHURA" }` | `200 { "ok": true }`; missing user/project/grant returns `404` |
| Disable an account | `POST /system/auth/accounts/viewer/deactivate` | `200 { "ok": true }`; unknown user returns `404`; repeating an existing deactivation succeeds |

Revoking a grant does not destroy the user's session: `/system/auth/scopes` immediately removes the project and scoped requests are denied unless another authorized project is selected. `POST /system/auth/grants` restores access.

Deactivation atomically sets the account inactive and deletes every session. Future logins return `401 { "detail": "Credenciales inválidas" }`. Session insertion holds a user-row lock and rechecks active status, so a login paused before insertion cannot create a usable session after deactivation. Disabling oneself clears session/scope cookies when another active administrator remains.

The last active administrator cannot be disabled: `409 { "detail": "No se permite desactivar el último administrador" }`. A shared transaction-scoped advisory lock serializes that guard. No account, tenant or business records are deleted by deactivation. Admins are bootstrapped with the default project at startup; global administrators can always administer grants, even with no selected project.

Grant removal validates nonempty lookup fields of at most 120 characters and rejects NULs (`422`). Invalid account lookup names return `422 { "detail": "Usuario inválido" }`.

## Database boundary

`withTenant(sql, tenantId, callback)` sets `app.tenant_id` transaction-locally and changes to the restricted `sipges_tenant` role. Tenant tables must:

- have a `tenant_id` column;
- enable and force row-level security;
- use matching `USING` and `WITH CHECK` policies;
- grant only the required privileges to `sipges_tenant`.

The tenant role has no access to identity tables. Connection settings revert when the transaction ends. The startup/migration role needs permission to create and grant `sipges_tenant`; do not configure production with a superuser runtime role.

## Tenant JSON export

`GET /system/export` requires an administrator with an active, granted scope. It returns `Content-Type: application/json; charset=UTF-8`, `Content-Disposition: attachment; filename="sipges-tenant.json"` and `Cache-Control: no-store`.

The version 1 envelope contains `format: "sipges.tenant-export"`, `version: 1`, `scope: { company_id, project_id }`, `exported_at` (UTC seconds) and `data: { module_records, audit, attachments, document_review, digital_alert_reviews, preventive_actions, preventive_action_log }`. Only these explicitly allowed business tables are read; future contexts must extend the reader and its tests explicitly. Tables not installed yet produce empty arrays. Existing tables without forced RLS, tenant columns or required role privileges cause a generic `500`, never a partial dump or owner-role fallback.

All table reads use one repeatable-read, read-only transaction with transaction-local tenant ID and restricted `sipges_tenant` role, plus an explicit `tenant_id` predicate. Identity, sessions, grants and TOTP tables are not export sources. Transaction settings reset on success or failure. The artifact is an in-memory JSON business-data snapshot, not a SQLite file, PostgreSQL backup, import tool or attachment-binary archive. The format change from legacy `sipges.db` was selected explicitly (ODD S8).

## Current limits

The foundation includes scope/grant creation and selection, access-lifecycle routes, and an isolated RLS probe table in tests. Tenant-owned business tables remain open ODD tasks; export currently exercises synthetic business-table fixtures and returns empty arrays for contexts not installed yet. An RLS helper alone does not establish isolation for every future repository. Access-lifecycle implementation still requires the final task-level security verification and commit recorded in the ODD ledger.
