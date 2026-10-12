# MASCLI Python Behavior Contract (migration reference)

Source of truth for the TypeScript rewrite (`odd/tasks/typescript-hexagonal-migration.md`, T1, S6–S7).
Baseline: commit `c7fec1b`. `app.py:N` refers to the Python source. No real record values were read; `data/seed.json` and `.db` files are described by shape only.

## 1. Endpoints (65 routes)

Auth: **A** anonymous/exempt from middleware, **S** any session, **Adm** admin. Non-GET calls are also subject to the role gates in §2.

| Method · path | Line | Auth | Response | Notable codes |
|---|---|---|---|---|
| GET /health | 617 | A | JSON | 200 |
| GET / | 621 | S | HTML | 303→/login, 303→/select-project |
| GET /login | 262 | A | HTML (inline form + script) | |
| POST /login (form: username, password, otp) | 266 | A | JSON + Set-Cookie | 401 bad creds/inactive/bad TOTP |
| POST /logout | 281 | A | JSON, deletes `mascli_session` | |
| GET /select-project | 315 | S (self-check) | HTML | 303→/login |
| POST /select-project (form: scope) | 324 | S (self-check) | 303 + Set-Cookie `mascli_scope` | 401, 403 |
| GET /system/auth/me | 288 | A | JSON identity or null | |
| GET /system/auth/current-scope | 337 | S | JSON | |
| GET /system/auth/scopes | 342 | A (self-check) | JSON list | 401 |
| POST /system/auth/scopes | 355 | A (self-check, admin) | JSON | 403 (also anonymous), 404, 409, 422 |
| POST /system/auth/grants | 383 | Adm | JSON | 404 |
| GET /system/auth/accounts | 310 | Adm | JSON (no hashes) | |
| POST /system/auth/accounts | 298 | Adm | JSON | 409, 422 (password < 12) |
| POST /system/auth/totp/setup | 394 | S (analista and admin) | JSON secret + otpauth URI | 409 MFA already enabled |
| POST /system/auth/totp/enable | 412 | S | JSON | 422 |
| GET /system/export | 1329 | Adm | octet-stream `mascli.db` (scoped) | 403 no scope |
| GET /system/audit?limit | 1324 | Adm | JSON | |
| GET /system/irsa | 1011 | S | JSON | |
| GET /system/irsa/config | 1015 | S | JSON | |
| POST /system/irsa/config | 1019 | Adm | JSON | 400 weights not ≈1 (±0.02) |
| POST /system/irsa/snapshot | 1040 | S (not coordinador/consulta) | JSON | |
| GET /system/irsa/history?limit | 1053 | S | JSON | |
| GET /system/situational-analysis (+ `/system/situational-report.docx`) | 675/679 | S | JSON / DOCX | |
| GET /system/strategic-assessment (+ `/system/strategic-report.docx`) | 722/955 | S | JSON / DOCX | |
| GET /system/integrated-analysis (+ `.docx`) | 881/906 | S | JSON / DOCX | |
| GET /system/consensus-engine (+ `.docx`) | 932/936 | S | JSON / DOCX | |
| GET /api/dashboard | 984 | S | JSON | |
| GET /api/{module} (`limit`, `q`) | 1155 | S (usuarios, roles: Adm) | JSON | 404 unknown module |
| GET /api/{module}/{id} | 1169 | S | JSON | 404 |
| POST /api/{module} | 1176 | S | JSON `{id}` | 404, 403 project mismatch |
| PUT /api/{module}/{id} | 1189 | S | JSON (full replace) | 404 |
| DELETE /api/{module}/{id} | 1200 | S | JSON | 200 even if missing |
| POST /system/uploads (multipart) | 1076 | S | JSON | 400, 404, 413, 415 |
| GET /system/uploads (`linked_module`, `linked_record_id`, `q`, `limit` 1–500) | 1126 | S | JSON | |
| GET /system/uploads/{id} (+ `/download`) | 1141/1147 | S | JSON / file | 404, 410 file missing |
| POST /system/analyze | 1251 | S | JSON | |
| GET /system/indicators, /model-status, /validation-template | 1657/1663/1681 | S | JSON | |
| GET /system/canonical-entities | 1667 | S | JSON; `{}` outside default scope | |
| GET /system/project-coordinates | 1672 | S | JSON | 404 non-default scope |
| POST /system/document-lab/analyze (multipart) | 1762 | S | JSON | 413, 415, 422 |
| POST /system/document-lab/report.docx | 1782 | S | DOCX | |
| POST /system/document-lab/review/import | 1829 | S | JSON | 413 > 75 items, 422 bad sha256 |
| GET /system/document-lab/review (`status`) | 1848 | S | JSON | |
| PATCH /system/document-lab/review/{id} | 1857 | S | JSON | 404, 422 |
| POST /system/document-lab/compare (2 files) | 1876 | S | JSON | 413, 415, 422 |
| POST /system/intelligence/analyze-text | 1939 | S | JSON | 413 > 20,000 chars, 422 |
| POST /system/intelligence/semantic-analyze | 2013 | S | JSON | 422, 503 (`semantic` mode, Ollama down) |
| POST/GET/PATCH /system/intelligence/territorial-alerts | 2066/2085/2097 | S (writes: analista, coordinador) | JSON | 404, 422 |
| GET /system/intelligence/territorial-summary | 2111 | S | JSON | |
| POST/GET/PATCH /system/prevention/actions | 2161/2180/2185 | S (writes: analista, coordinador) | JSON | 404, 409, 422 |
| GET /system/prevention/summary | 2205 | S | JSON | |
| GET /system/management/overview | 2260 | S | JSON | |
| GET /system/management/report.csv | 2264 | S | `text/csv; charset=utf-8` with BOM | |

`/static/*` passes through the same middleware and requires a session.

## 2. Identity and security

- **Passwords** (`:162-173`): PBKDF2-HMAC-SHA256, 310,000 iterations, 16-byte salt, 32-byte digest; format `pbkdf2_sha256$310000$<saltHex>$<digestHex>`; constant-time compare; malformed → false. Minimum 12 chars at creation/bootstrap.
- **Sessions**: `token_hex(32)`; only SHA-256 hex stored in `auth_sessions`; 8 h absolute lifetime; no sliding refresh; no purge.
- **Cookies**: `mascli_session` and `mascli_scope`: HttpOnly, SameSite=Strict, Path=/, Max-Age 8 h, Secure per policy. Logout deletes only the session.
- **Secure policy** (`:10-18`): unset or `"1"` → Secure; `"0"` → not Secure; anything else fails at startup before resource init.
- **TOTP** (`:175-185`, `:394-420`): SHA-1, 6 digits, 30 s, ±1 step window, `\d{6}`. 20-byte base32 secret stored in plaintext. Setup only while `totp_enabled=0` (else 409) and regenerates the secret. Enable sets the flag and deletes the user's other sessions. No replay protection.
- **Roles**: `admin, analista, coordinador, consulta`.
- **Middleware order** (`enforce_auth`, `:194-260`):
  1. Exempt (all methods): `/health`, `/login`, `/logout`, `/select-project`, `/system/auth/me`, `/system/auth/scopes`.
  2. Session → identity; missing → 303 for `GET /`, else 401.
  3. Non-GET with `Origin` netloc ≠ `Host` → 403.
  4. Scope: `X-MASCLI-Scope` header → `mascli_scope` cookie → sole grant. Not granted → 403 (303 for `GET /`).
  5. Scoped DB missing → 503.
  6. Query `project_id` ≠ scope → 403.
  7. JSON body `project_id` / `payload.Proyecto_ID` ≠ scope on POST/PUT/PATCH under `/api/` or `/system/` → 403.
  8. Role gates: accounts/export/audit/non-GET irsa config → admin; `/api/usuarios`, `/api/roles` → admin; non-GET `/api/proyectos` → admin; non-GET: `consulta` 403; `coordinador` 403 except `/system/prevention/*` and `/system/intelligence/territorial-alerts*`.
  9. Handler; scope reset in `finally`.
  10. Headers: `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, `Cache-Control: no-store`. No CSP, no HSTS.
- **Environment**: `MASCLI_COOKIE_SECURE`, `MASCLI_DB_PATH`, `MASCLI_UPLOAD_DIR`, `MASCLI_MAX_UPLOAD_BYTES` (default 10 MiB, unchecked), `MASCLI_AUTH_DB_PATH`, `MASCLI_TENANT_DIR`, `MASCLI_ADMIN_USERNAME` (default `admin`), `MASCLI_ADMIN_PASSWORD` (required ≥ 12 when no users), `MASCLI_OLLAMA_EMBED_MODEL` (default `nomic-embed-text`; Ollama URL hard-coded `127.0.0.1:11434`).

## 3. Tenancy

- `auth_global.db`: `auth_users(username PK, full_name, password_hash, role, active, created_at, totp_secret, totp_enabled)`, `auth_sessions(token_hash PK, username, expires_at, created_at)`, `tenant_projects(company_id, project_id, label)`, `access_grants(username, company_id, project_id)`.
- Legacy migration copies `auth_users` from default DB without TOTP fields. Bootstrap creates `MASCLI/PRJ-SECHURA` and grants it to all admins.
- Tenant DB: `MASCLI/PRJ-SECHURA` → `data/mascli.db`; others → `TENANT_DIR/<sha256("company/project")[:24]>.db`.
- Scoped settings copied on first use to `TENANT_DIR/<stem>_settings/`; uploads under `UPLOAD_DIR/<hash>/` for non-default scopes.
- Records without `Proyecto_ID` count as `PRJ-SECHURA` in analysis filters; generic CRUD isolates only by DB file.
- Grants many-to-many; `POST /system/auth/scopes` copies schema (no data), seeds one `Proyectos` record and grants the user. No revoke.
- Outcomes: 403 (no grant/scope, mismatch, role, origin), 404 (unknown module/record, reference data outside default scope), 503 (tenant DB missing), 410 (upload file missing).

## 4. Persistence

- Scoped: `records(module, record_id, payload JSON, created_at, updated_at; PK(module, record_id))`; `audit(id, ts, module, record_id, action, detail)`; `irsa_snapshots(id, ts, irsa, level, scores JSON, config_version, note)`; `attachments(id, stored_name, original_name, content_type, size_bytes, sha256, linked_module, linked_record_id, document_type, author, verification, notes, project_id, project_name, created_at)`.
- Lazy: `document_review` (UNIQUE project/sha256/location/theme/excerpt), `digital_alert_reviews`, `preventive_actions` + `idx_rc27_project`, `preventive_action_log` + `idx_rc27_log_action`.
- JSON config: `irsa_config.json` (weights G,A,D,N,E,I; thresholds Verde/Amarillo/Naranja/Rojo; contributions; notes), `indicator_config.json`, `model_status.json`, `canonical_entities.json`, `project_coordinates.json`, `seed.json` (module arrays).
- Uploads: `<root>/<uuid4hex>_<safe_name>`; ID `ADJ-<12 hex>`; file written before DB row.

## 5. Domain modules and engines

- **Generic CRUD**: 19 modules (eventos, actores, demandas, compromisos, narrativas, fuentes, indicadores, alertas, acciones, directorio, priorizados, usuarios, roles, proyectos, intereses, dialogos, oportunidades, hechos, aarc). No field validation; ID from payload key (`rid_for`, `:67-78`) with random suffix on collision; PUT replaces.
- **Situational** (`:627`): counts over 8 modules, closed-state set, top-8 aggregations, 8-section DOCX.
- **Strategic** (`:722`), **Consensus** (`:745`, 13 rule families, dedup by type/origin/title), **Candidate links** (`:859`, ID equality or ≥ 2 shared 4+-letter tokens, cap 120), **Integrated** (`:881`).
- **IRSA v0.4** (`:1362`, `:1619`): 32 indicators across G/A/D/N/E/I; dimension = mean of non-null; A3 always null; IRSA = Σ weight × dimension, 2 decimals; first matching band else `Rojo`; top 15 drivers; `config_version` hard-coded `0.4-indicators`.
- **Classifier** (`/system/analyze`, `:1212-1320`): lexicon (strong +4.0, weak +1.5), confidence capped 94, `review_required` if confidence < 70 or margin < 3; version `0.5.1-calibracion`; not persisted.
- **Document lab** (`:1723-1805`): PDF ≤ 100 pages, DOCX paragraphs/tables, TXT/MD UTF-8-SIG; 7 themes; caps 12/theme, 75 total. Compare: ≥ 5-letter fingerprints, Jaccard ≥ 0.11, top 40.
- **Digital text** (`:1939`): score `min(50, 15·signals) + min(30, 6·topics)`; Alta ≥ 65, Media ≥ 35. **Semantic** (`:1997-2052`): Ollama embeddings, cosine ≥ 0.38, 12 s timeout each, rules fallback.
- **Territorial alerts / prevention** (`:2066-2220`): state machines; action requires alert `Corroborado`/`En seguimiento` (409); completed ⇒ progress 100; pending ⇒ 0; closing/cancelling needs note; evidence URL `^https?://`.
- **Management** (`:2224-2270`): metrics over alerts, actions, Compromisos; CSV with BOM.

## 6. Frontend

- Screens: dashboard, gerencia, eventos, actores (network), directorio, demandas, narrativas, inteligencia-redes, alertas, mapa (SVG), situacion, estrategia (+ document lab), irsa, validacion, fuentes, metodologia, administracion, audit.
- Project switch is client-side only (`localStorage`); server scope never changes, causing 403s.
- Risks: `app.js:223`, `:278` inline `onclick` with HTML-escaped IDs (attribute-context breakout); `app.js:66` unescaped label; inline handlers everywhere in `index.html`; inline login script; no 401 redirect.

## 7. Bounded contexts and hotspots

Contexts: Identity & Access, Tenancy, Territorial Records, Evidence, Indicators & IRSA, Strategic Analytics, Document Lab, Digital Intelligence, Prevention, Management Reporting, Reference Data.

Hotspots: `compute_indicators` (≈ 10 full scans + JSON parse per request), `candidate_pairs` (150 × 150 with regex/NFKD in inner loop), document insights and 75 × 75 compare, PDF extraction (≤ 100 pages), full-memory uploads (10 MiB). Semantic analysis is latency-bound (up to 8 sequential calls, ~96 s).

## 8. Open product decisions

1. IRSA band gaps (24.99–25 falls to `Rojo`): half-open intervals?
2. Auth roles vs. demo `Roles`/`Usuarios` records: display-only?
3. `consulta`/`coordinador` blocked on non-mutating POSTs (analyze, compare, report, semantic).
4. `/system/auth/scopes` exempt from middleware (no origin check; anonymous POST → 403).
5. UI project switch does not change server scope.
6. Default `PRJ-SECHURA` in review bodies; multipart forms unchecked for project.
7. Export may include legacy `auth_users` rows (hashes, plaintext TOTP) in the default DB.
8. No session purge, throttling, password change, deactivate, grant revoke; plaintext TOTP; no replay protection.
9. Upload hygiene: no magic-number check, orphan files, unchecked size env, broad extension list.
10. Generic CRUD: no validation, unbounded limits, DELETE audits missing rows, no attachment cascade.
11. Inconsistent "open/closed" state sets across dashboard, analysis and IRSA.
12. Dead/shadowed code (`compute_irsa` at `:507`), ignored config version, deprecated startup hook.
13. Hard-coded personal name in bootstrap admin and report footers.
