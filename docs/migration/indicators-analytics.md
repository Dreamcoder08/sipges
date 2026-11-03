# Indicators, IRSA and strategic analytics (T7)

Two bounded contexts port the Python engines as pure domain functions behind tenant-scoped read ports.

## Indicators & IRSA (`contexts/indicators`)

- Endpoints: `GET /system/irsa`, `GET|POST /system/irsa/config`, `POST /system/irsa/snapshot`, `GET /system/irsa/history?limit`, `GET /system/indicators`, `GET /system/model-status`, `GET /system/validation-template`.
- The 32 indicators match `app.py` `compute_indicators` exactly on a golden synthetic fixture (`test/indicators/python-parity.fixture.json`); rounding reproduces Python `round()` ties-to-even.
- Config is stored per tenant in `irsa_configs` (defaults from `data/irsa_config.json`); snapshots in `irsa_snapshots`. Both live in migration `0005_irsa.sql` with forced RLS; `sipges_tenant` has no DELETE. Values are stored as `json`, not `jsonb`, so band order (first match wins) is preserved.
- Config updates and snapshots append audit rows in the same tenant transaction.
- `computeIrsa` (V0.4) uses only the 32 indicators: IRSA = Σ weight × dimension score, where a dimension score is the mean of its calculable indicators. The `contributions` block (active alert 18, open demand 7, …) is kept from the prototype for comparison and is **not** part of the calculation; the IRSA screen says so. The default config `version` is `0.4-indicators`, the engine's `CONFIG_VERSION`.
- Deliberate differences from Python: malformed weights, contributions or bands return 422 instead of 500; timestamps are UTC ISO seconds with `Z`.

## Strategic analytics (`contexts/analytics`)

- Endpoints: `GET /system/situational-analysis`, `GET /system/strategic-assessment`, `GET /system/consensus-engine`, `GET /system/integrated-analysis`. The project comes from the selected tenant scope; a mismatching `project_id` query is rejected by the tenancy middleware.
- Project filters keep both Python rules: situational treats any falsy `Proyecto_ID` as `PRJ-SECHURA`; extended modules default only a missing key.

## Shared rules

- Both readers return empty data while `module_records` is absent and refuse to read it without forced row-level security.
- DOCX variants of these reports are deferred to T9.

## Known limits (verifier advisories, not blockers)

- A NUL nested inside an object snapshot `note` is accepted (stored as escaped JSON text).
- NUL characters in IRSA config object keys are accepted for administrators.
- `limit=1e3` and an empty `limit` are accepted, unlike FastAPI's `int`.
