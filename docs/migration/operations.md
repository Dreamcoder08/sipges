# Digital intelligence, prevention and management (T10)

Ports the record classifier (`app.py:1207-1320`), digital intelligence (RC 2.4 text analysis,
RC 2.5 semantic layer and territorial alerts), territorial prevention plans (RC 2.6) and the
management overview with its CSV report (RC 2.8). Three contexts:

- `intelligence`: classifier, text analysis, semantic analysis behind an `EmbeddingProvider`
  port (Ollama adapter), and the territorial alert inbox.
- `prevention`: preventive action plans linked to a corroborated alert, with a progress log.
- `management`: read-only overview and CSV built from alerts, actions and the `Compromisos`
  records. It depends only on the other contexts' application APIs.

## Contract

| Route | Result | Errors |
| --- | --- | --- |
| `POST /system/analyze` `{payload}` | classifier suggestion (`0.5.1-calibracion`) | 422 |
| `POST /system/intelligence/analyze-text` `{text, source_url?, project_id?}` | report `version: "2.4"` | 403 other project, 413 over 20 000 characters, 422 empty or bad URL |
| `POST /system/intelligence/semantic-analyze` `{text, mode?, source_url?, project_id?}` | report `version: "2.5"` with `semantic` block | as above, 422 mode, 503 `mode: "semantic"` without a model |
| `POST /system/intelligence/territorial-alerts` `{text, source_url?, source_type?, mode?}` | `{id, status, analysis, irsa_modified: false, notice}` | as above, 422 source type |
| `GET /system/intelligence/territorial-alerts?limit=` | newest first, default 50, 1-200 | |
| `PATCH /system/intelligence/territorial-alerts/{id}` `{status, reviewer_note?}` | `{ok, status, irsa_modified: false, notice}` | 404, 422 status or note over 2000 |
| `GET /system/intelligence/territorial-summary` | counts by status, priority, theme and signal | |
| `POST /system/prevention/actions` `{alert_id, title, responsible, due_date, description?}` | `{ok, action}` | 404 alert not in project, 409 alert not `Corroborado`, 422 fields |
| `GET /system/prevention/actions` | actions with history (newest first) | |
| `PATCH /system/prevention/actions/{id}` `{status, progress, note?, evidence_url?}` | `{ok, action}` | 404, 409 reactivating a cancelled action, 422 rules below |
| `GET /system/prevention/summary` | totals, overdue, average progress | |
| `GET /system/management/overview` | `version: "2.8"` metrics, critical actions, responsibles | |
| `GET /system/management/report.csv` | `sipges_rc28_reporte_gerencial.csv` (UTF-8 BOM, CRLF) | |

Analysis POSTs are read-only and open to every role (ADR 0008 #3). Creating or deciding alerts
and creating or updating actions need a writing role. Every write records an audit row in the
same transaction: `InteligenciaDigital` `CREATE`/`REVIEW` and `PrevencionTerritorial`
`CREATE`/`UPDATE`. Alerts never change the IRSA.

Action update rules, checked in app.py's order: known status; `Completada` needs 100%;
`Pendiente` needs 0%; evidence must be an http(s) link; a cancelled action cannot be
reactivated; closing or cancelling needs a note. Updates lock the row (`SELECT … FOR UPDATE`).

## Storage

Migration `0008_intelligence_prevention.sql` adds `digital_alert_reviews`,
`preventive_actions` and `preventive_action_log`, all under forced RLS and part of the tenant
JSON export.

## Configuration

| Variable | Meaning | Default |
| --- | --- | --- |
| `SIPGES_OLLAMA_URL` | http(s) base URL of the Ollama server used for embeddings | `http://127.0.0.1:11434` |
| `SIPGES_OLLAMA_EMBED_MODEL` | embedding model | `nomic-embed-text` |

Only the configured URL is contacted (12 s timeout, no redirects, 1.5 MB response cap); the
request's `source_url` is never fetched. Without a reachable model, `automatic` mode falls back
to the rules analysis and says so in `semantic.note`.

## Parity

`test/intelligence/python-parity.fixture.json` is generated from `app.py` with synthetic data by
`scripts/python-parity/operations.py`: classifier results for 8 payloads, text analysis of 4
texts against synthetic narratives, and the management CSV written by `csv.writer`. The port
reproduces `json.dumps` separators, NFKD/NFD folding, code-point slicing, half-even `round()`
and stable sorts.

## Intentional differences

- **Project:** always the active scope; another `project_id` is refused (ADR 0008 #6).
- **Errors:** generic 422 messages instead of Python exception names.
- **Limitations text:** "Sin autenticación empresarial" now reads "Acceso restringido a usuarios
  autenticados con permiso sobre el proyecto activo".
- **CSV safety:** cells starting with `=`, `+`, `-`, `@`, tab or CR are prefixed with `'` so
  spreadsheets do not run them as formulas.
- **Dates:** "today" for overdue checks and all timestamps are UTC (ADR 0008 #14).
