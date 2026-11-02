# ADR 0031 — Conflict-risk prediction: transparent score, calibrated on the project's history

- Status: Accepted
- Date: 2026-11-02
- Task: `odd/tasks/functional-closure.md` (T21, S12, L10); `odd/tasks/conflict-risk.md`
- Related: [ADR 0002](0002-hexagonal-architecture-and-bounded-contexts.md) (contexts and ports), [ADR 0012](0012-observability-and-classification.md) (restricted records), [ADR 0020](0020-mascli-4-situations.md) (records as dated signals), [ADR 0030](0030-external-ai-egress-guard.md) (no external AI)

## Context

The owner chose (L10): «Predice qué localidades y actores tienen más probabilidad de escalar en
30/90 días, usando demandas, narrativas, alertas e historial de IRSA. Cada predicción muestra en
qué se basa y cuán confiable es.»

Until now every analysis said it was descriptive, not predictive (situational analysis, strategic
assessment, consensus engine, scenario report). The inputs already exist: Demandas, Compromisos,
Narrativas, Alertas, Eventos and Actores in `module_records` (Territorial Records), territorial
alerts (Digital Intelligence) and IRSA snapshots (Indicators & IRSA).

Constraints:

- The records name people and organisations in social conflicts. Ley 29733 and ADR 0030 rule out
  sending them to an external model; the prediction must run inside the Worker, with no network
  call.
- A project has months, not years, of history and few escalations. A model with many parameters
  would fit noise, and a precise-looking percentage would mislead.
- Whoever reads the prediction must be able to check it against the records that produced it.

## Decision

### 1. Unit, horizon and the event predicted

- Units: each **locality** (the record's own `Territorio`, `Comunidad`, `Localidad` or `Distrito`,
  never inferred from text) and each **actor** (names in the actor fields; lists split on `,`/`;`).
  Names are folded (accents, case, spaces) to match across modules.
- Horizons: 30 and 90 days after the cut-off day.
- **Escalation** is an event the project already records, dated after the cut-off and within the
  horizon:
  - an `Alertas` record with level `Rojo` or `Naranja` that is not `Descartada`;
  - a territorial alert with level `Alta` that is not `Descartado`;
  - an `Eventos` record whose `Nivel_Preliminar` or `Relevancia_Preliminar` is red, orange, high
    or critical.

  Alerts SIPGES generated itself (`Origen = SIPGES`) never count, as in ADR 0020 (no
  self-reinforcement).

### 2. Features (as of the cut-off day `t`, only data dated on or before `t`)

| Factor | Value | Weight |
| --- | --- | --- |
| Open demands registered in the last 180 days (`Prioridad` Alta counts 1.5) | `ln(1 + n)` | 0.6 |
| Overdue commitments (due date before `t`, not fulfilled) | `ln(1 + n)` | 0.8 |
| Critical or negative narratives in the last 90 days | `ln(1 + n)` | 0.5 |
| Rise of critical narratives (last 30 days minus the monthly mean of the 60 before, 0–3) | `ln(1 + d)` | 0.4 |
| Alerts in the last 90 days, by level (Rojo/Alta 2, Naranja/Media 1.5, else 1) | `ln(1 + Σ)` | 0.9 |
| Escalations in the last 90 days (history repeats) | `ln(1 + n)` | 0.7 |
| Project IRSA at `t` (latest snapshot on or before `t`) | `IRSA / 100` | 0.8 |
| IRSA rise over the 90 days before `t` | `clamp(Δ / 25, 0, 1)` | 0.4 |
| Recency of the last signal | `exp(−days / 30)` | 0.5 |

The score is the weighted sum. Each factor's contribution (`weight × value`) is shown with the
records behind it, so the ranking can be read and disputed. The weights are fixed here, not
learned: there is too little history to learn nine weights without overfitting. IRSA is
measured per project, so it lifts every locality and actor of the project alike; the screen says
so.

Status at `t` is not today's status. A record closed today counts as closed at `t` only when its
last update (`updated_at`) is on or before `t`; a territorial alert discarded today counts as
discarded at `t` only when it was reviewed on or before `t`. Otherwise it was still open at `t`.

### 3. From score to probability: calibration on the project's own history

- **Back-test**: cut-offs every 30 days, going back from `today − horizon` (at most 24), only
  while the cut-off has 90 days of history before it. A sample is one unit at one cut-off with
  at least one signal in the 180 days before it; its label is whether that unit escalated in the
  horizon. Cut-offs whose horizon has not ended are never used.
- **Leakage guard**: features at `t` are built from signals filtered to `date ≤ t`, and the
  back-test refuses (throws) a sample whose basis contains a later signal.
- **Time split**: the oldest 70 % of cut-offs train, the newest 30 % test.
- **Calibration**: Platt scaling, `p = σ(a + b · score)`, fitted on the training samples by
  Newton steps with a small ridge on `b` and `b ≥ 0` (more signals never lower the risk).
- **Report**: training and test samples and escalations, Brier score on the test samples, the
  Brier score of the training base rate on the same samples (the reference), skill
  (`1 − Brier / reference`) and three reliability bins (mean predicted vs. observed rate).

### 4. Confidence and thin history

- With fewer than 5 training escalations, 30 training samples or 10 test samples, the model is
  **not calibrated**: no percentage is shown, only a signal band from the score (`< 1` baja,
  `< 2.5` media, otherwise alta), confidence «baja» and the reason with the sample size.
- Calibrated: probabilities are rounded to 5 points and banded (`< 15 %` baja, `< 40 %` media,
  otherwise alta). Confidence is «alta» with skill > 0 and at least 20 training escalations,
  «media» with skill > 0, otherwise «baja».
- A unit with a single signal has confidence «baja». A project without dated signals answers
  «sin datos suficientes» and lists nothing.

### 5. Where it lives

- Analytics context, pure domain under `contexts/analytics/domain/conflict-risk/`. The use case
  reads records through the Analytics record reader (with `updated_at`), territorial alerts
  through `intelligence.allAlerts` and IRSA snapshots through `indicators.history`, wired in
  `compose.ts` as ports (ADR 0002). No new table, no migration.
- Everything runs under the scope's tenant transaction (RLS); restricted records follow the
  reader's clearance (ADR 0012). Nothing leaves the Worker.
- `GET /system/conflict-risk` and the «Riesgo de conflicto» tab in Análisis, linked from Inicio
  and from the territorial map's locality card.

## Consequences

- SIPGES now predicts in one place. The descriptive engines keep their «no predicción» wording
  because they still do not predict.
- The prediction is a prioritisation aid with a measured error, not a forecast of facts. A
  ranking with confidence «baja» says so in words.
- Changing a weight or the escalation definition changes the back-test; both live in one module
  with tests. A learned model (for example logistic regression on these features) is a later
  option once a project has enough escalations to beat the fixed weights in its own back-test.
- The back-test runs on every request: units × cut-offs × signals, with each unit's score at a
  cut-off shared by both horizons. 2,800 synthetic records over 75 units take about 0.2 s on a
  laptop. If projects grow, cache the report per project and day.

## Alternatives considered

- **External model or LLM**: rejected; personal data would leave the system (ADR 0030) and the
  output would not be explainable.
- **Logistic regression fitted per project**: rejected for now; with tens of escalations its
  coefficients are unstable and would change the ranking from week to week.
- **IRSA projection only**: the owner did not choose it (L10); IRSA is one factor here.
