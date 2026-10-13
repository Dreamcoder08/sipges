# Evidence attachments (T8)

Upload, list and download of evidence files linked to territorial records, ported from
`app.py /system/uploads` with the ADR 0008 #9 corrections.

## Contract

| Route | Result | Errors |
| --- | --- | --- |
| `POST /system/uploads` multipart `file`, `linked_module`, `linked_record_id`, optional `document_type`, `author`, `verification`, `notes` | `{ok: true, attachment}` | 400 module or empty file, 404 record, 413 too large, 415 extension or content mismatch, 422 missing field, 403 read-only role |
| `GET /system/uploads?linked_module=&linked_record_id=&q=&limit=200` | attachment list, newest first, `limit` 1–500 | 422 non-integer `limit` |
| `GET /system/uploads/{id}` | attachment | 404 |
| `GET /system/uploads/{id}/download` | file bytes, `Content-Disposition: attachment` | 404 unknown id, 410 object missing from storage |

The attachment JSON keeps the Python field names (`original_name`, `size_bytes`, `sha256`,
`Proyecto_ID`, `download_url`, ...) and never exposes the storage key.

## Behavior

- **Validation:** extension allow-list (PDF, DOC/DOCX, XLS/XLSX, CSV, TXT, JPG/PNG/WEBP) plus
  a magic-number check per extension; CSV and TXT must be UTF-8. File names are reduced to
  `[A-Za-z0-9._-]`.
- **Size:** `MASCLI_MAX_UPLOAD_BYTES` (1 byte to 100 MiB, default 10 MiB). Bodies larger than
  the limit plus 64 KiB of multipart overhead are refused before they are read.
- **Linking:** the upload appends `{id, archivo, tipo, verificacion}` to the record's `Adjuntos`
  and sets `Evidencia/Resultado` (eventos) or `Archivo_Fuente` (fuentes), in the same transaction
  as the metadata row and an `UPLOAD` audit entry. The record row is locked, so concurrent
  uploads do not lose links.
- **Compensation:** the object is written first. If the record is missing or the transaction
  fails, the object is deleted again, so a failed upload leaves neither a file nor a row.
- **Tenancy:** `attachments` has forced RLS and is read through `withTenant`. Object keys start
  with a hash of the tenant id. Tenant JSON export includes attachment metadata, not the bytes.
- **Record delete:** a foreign key cascades the metadata rows. The stored objects are not
  removed yet; a sweep of unreferenced keys is an open follow-up.

## Storage adapters

`MASCLI_STORAGE=local` (default) writes to `MASCLI_UPLOAD_DIR` (default `.data/uploads`)
with an atomic rename. `MASCLI_STORAGE=s3` speaks the S3 API with SigV4 signing on
`node:crypto` and path-style URLs, so it works with Cloudflare R2, MinIO or AWS S3. The signer
is checked against the AWS documentation test vector.
