# Territorial records and audit trail (T6)

Generic CRUD for the 19 territorial modules (`/api/{module}`) and the tenant audit trail
(`GET /system/audit`), ported from `app.py:67-78, 1155-1205, 1324-1327`.

## Contract

| Route | Result | Errors |
| --- | --- | --- |
| `GET /api/{module}?limit=200&q=` | payloads + `_id`, `_updated_at`, newest updated first | 404 `Módulo no válido`, 422 non-integer `limit` |
| `GET /api/{module}/{id}` | payload + `_id` | 404 `Registro no encontrado` |
| `POST /api/{module}` `{payload}` | `{ok: true, id}` | 404, 422, 403 body project mismatch |
| `PUT /api/{module}/{id}` `{payload}` | `{ok: true}` (full replace) | 404, 422 |
| `DELETE /api/{module}/{id}` | `{ok: true}` | 404 |
| `GET /system/audit?limit=100` | `{id, ts, module, record_id, action, detail}` newest first | 403 non-admin, 422 |

Record ids follow `rid_for`: the module id field when truthy (`ID_Evento`, `Codigo`,
`Proyecto_ID`, ...), otherwise `<prefix>-<8 hex>`; a taken id gets `-<4 hex>`. Projects store
their id in `Proyecto_ID`. Audit details keep the Python texts.

## Deliberate differences (docs/adr/0008 #10)

- **Validation:** `payload` must be a JSON object; the module id field, when present, must be a
  string or finite number of at most 200 characters; NUL is rejected anywhere in the payload
  (PostgreSQL cannot store it). All return 422 in FastAPI shape. Extra fields stay free-form.
- **Limits:** `limit` is capped at 500 (a negative value, which meant "no limit" in SQLite,
  also becomes 500).
- **`q` filter** runs in SQL over the id and payload text before `LIMIT`; Python filtered after
  `LIMIT`, so it could return fewer matches than existed.
- **DELETE of a missing record** returns 404 and writes no audit entry.
- **Timestamps** are UTC `YYYY-MM-DDTHH:MM:SSZ` on the wire; payload key order is not preserved
  (`jsonb`).
- **Attachment cascade:** deleting a record cascades its `attachments` rows (T8, see
  docs/migration/evidence.md).

## Isolation and atomicity

`module_records` and `audit` (migration `0004_records_audit.sql`) are tenant-owned under forced
RLS and accessed only through `withTenant` as `sipges_tenant`. Each change and its audit entry
commit in the same transaction (`platform/database/audit-trail.ts`); the role may only `SELECT`
and `INSERT` on `audit`, so the trail is append-only for the application. Other contexts append
audit entries the same way inside their own tenant transaction.
