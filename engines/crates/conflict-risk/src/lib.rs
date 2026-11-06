//! Conflict-risk prediction engine: port of `conflictRisk`
//! (`apps/api/src/contexts/analytics/domain/conflict-risk/{signals,features,calibration,predict}.ts`,
//! docs/adr/0031). Localities and actors ranked by their escalation risk in 30 and 90 days: a
//! transparent factor score with fixed weights, calibrated with the project's own history by a
//! time-split back-test and Platt scaling.
//!
//! [`run`] takes the `RiskInput` as a JSON object and returns the value whose `js::stringify`
//! equals `JSON.stringify(conflictRisk(input))` byte for byte:
//!
//! | Field | Shape |
//! | --- | --- |
//! | `records` | array of `{module: string, id: string, payload: object, updatedAt: string \| null}` |
//! | `alerts` | array of `{id: string, createdAt: string, territory: string \| null, level: string, status: string, reviewedAt: string \| null}` |
//! | `irsa` | array of `{ts: string, irsa: number}` |
//! | `today` | `YYYY-MM-DD` (month 01–12, day 01–31; `2026-02-30` rolls over as `Date.parse` does) |
//!
//! Every field is required; another shape is `invalid_input`. `unsupported_value` reports what
//! TypeScript cannot answer: a record whose `module` names an `Object.prototype` property (it
//! throws a `TypeError`).
//!
//! JavaScript runtime pieces reproduced here: `Math.exp`/`log`/`log1p` as V8's fdlibm port
//! (`jsmath`), `localeCompare(…, 'es')` for tied scores (`collation`, exact for the repertoire
//! it documents), `normalize('NFD')` with `unicode-normalization` 0.1.25 and `\p{Mn}` measured on
//! Node (`tables`).

mod calibration;
mod collation;
mod dates;
mod features;
mod jsmath;
mod signals;
mod tables;
mod text;

use std::collections::HashMap;

use serde_json::{Map, Value};
pub use sipges_analytics_common::EngineError;
use sipges_analytics_common::js;

use calibration::{Platt, Sample};
use features::{Factor, escalated_within, features_at, recent_signals, round3, score_of};
use signals::{IrsaPoint, RiskAlert, RiskInput, RiskRecord, SignalIndex, index_signals};

const HORIZONS: [i64; 2] = [30, 90];
const CUTOFF_STEP: i64 = 30;
const MAX_CUTOFFS: i64 = 24;
const MIN_HISTORY: i64 = 90;
const MIN_TRAIN_EVENTS: usize = 5;
const MIN_TRAIN_SAMPLES: usize = 30;
const MIN_TEST_SAMPLES: usize = 10;
const MAX_UNITS: usize = 50;

const METHOD: &str = "Puntaje transparente de factores con pesos fijos, calibrado con el historial del propio proyecto (ADR 0031). Se calcula dentro de SIPGES, sin IA externa.";

const LIMITATIONS: [&str; 4] = [
    "Es una ayuda para priorizar, no un pronóstico de hechos: la probabilidad tiene el error que muestra el back-test.",
    "Solo cuenta lo que el proyecto registró; la falta de registros no demuestra ausencia de riesgo.",
    "El IRSA se mide por proyecto, así que sube o baja el riesgo de todas las localidades y actores por igual.",
    "Validar con el equipo territorial antes de decidir o comunicar.",
];

// --- request ------------------------------------------------------------------------------------

fn array<'a>(request: &'a Map<String, Value>, key: &str) -> Result<&'a [Value], EngineError> {
    match request.get(key) {
        Some(Value::Array(items)) => Ok(items),
        _ => Err(EngineError::input(format!("{key} must be an array"))),
    }
}

fn string<'a>(item: &'a Value, key: &str, what: &str) -> Result<&'a str, EngineError> {
    match item.get(key) {
        Some(Value::String(s)) => Ok(s),
        _ => Err(EngineError::input(format!("{what}.{key} must be a string"))),
    }
}

fn nullable<'a>(item: &'a Value, key: &str, what: &str) -> Result<Option<&'a str>, EngineError> {
    match item.get(key) {
        Some(Value::String(s)) => Ok(Some(s)),
        Some(Value::Null) => Ok(None),
        _ => Err(EngineError::input(format!(
            "{what}.{key} must be a string or null"
        ))),
    }
}

fn parse(request: &Map<String, Value>) -> Result<RiskInput<'_>, EngineError> {
    let records = array(request, "records")?
        .iter()
        .map(|item| {
            let Some(Value::Object(payload)) = item.get("payload") else {
                return Err(EngineError::input("records[].payload must be an object"));
            };
            Ok(RiskRecord {
                module: string(item, "module", "records[]")?,
                id: string(item, "id", "records[]")?,
                payload,
                updated_at: nullable(item, "updatedAt", "records[]")?,
            })
        })
        .collect::<Result<Vec<_>, _>>()?;
    let alerts = array(request, "alerts")?
        .iter()
        .map(|item| {
            Ok(RiskAlert {
                id: string(item, "id", "alerts[]")?,
                created_at: string(item, "createdAt", "alerts[]")?,
                territory: nullable(item, "territory", "alerts[]")?,
                level: string(item, "level", "alerts[]")?,
                status: string(item, "status", "alerts[]")?,
                reviewed_at: nullable(item, "reviewedAt", "alerts[]")?,
            })
        })
        .collect::<Result<Vec<_>, EngineError>>()?;
    let irsa = array(request, "irsa")?
        .iter()
        .map(|item| {
            let Some(irsa) = item.get("irsa").and_then(Value::as_f64) else {
                return Err(EngineError::input("irsa[].irsa must be a number"));
            };
            Ok(IrsaPoint {
                ts: string(item, "ts", "irsa[]")?,
                irsa,
            })
        })
        .collect::<Result<Vec<_>, _>>()?;
    let today = match request.get("today") {
        Some(Value::String(s)) if dates::parse_day(s).is_some() => s.as_str(),
        _ => return Err(EngineError::input("today must be a YYYY-MM-DD day")),
    };
    Ok(RiskInput {
        records,
        alerts,
        irsa,
        today,
    })
}

// --- back-test and calibration --------------------------------------------------------------------

fn day(s: &str, days: i64) -> Result<String, EngineError> {
    dates::add_days(s, days)
        .ok_or_else(|| EngineError::UnsupportedValue(format!("{s} is not a day")))
}

/// Cut-offs every 30 days back from `today − horizon`, oldest first, each with 90 days before it.
fn cutoffs_for(index: &SignalIndex, today: &str, horizon: i64) -> Result<Vec<String>, EngineError> {
    let Some(first) = &index.first_day else {
        return Ok(Vec::new());
    };
    let earliest = day(first, MIN_HISTORY)?;
    let mut cutoffs = Vec::new();
    for k in 0..MAX_CUTOFFS {
        let t = day(today, -horizon - CUTOFF_STEP * k)?;
        if t < earliest {
            break;
        }
        cutoffs.push(t);
    }
    cutoffs.reverse();
    Ok(cutoffs)
}

/// Score of each unit at each cut-off, shared by both horizons.
type ScoreCache = HashMap<(usize, String), Option<f64>>;

fn samples_at(
    index: &SignalIndex,
    input: &RiskInput<'_>,
    t: &str,
    horizon: i64,
    cache: &mut ScoreCache,
) -> Result<Vec<Sample>, EngineError> {
    let mut samples = Vec::new();
    for unit in 0..index.units.len() {
        let key = (unit, t.to_owned());
        let entry = if let Some(&entry) = cache.get(&key) {
            entry
        } else {
            let entry = if recent_signals(index, unit, t)? > 0 {
                Some(score_of(&features_at(index, unit, t, &input.irsa)?))
            } else {
                None
            };
            cache.insert(key, entry);
            entry
        };
        if let Some(score) = entry {
            samples.push(Sample {
                score,
                escalated: escalated_within(index, unit, t, horizon)?,
            });
        }
    }
    Ok(samples)
}

struct Calibration {
    backtest: Value,
    platt: Option<Platt>,
    train_events: usize,
    skill: Option<f64>,
}

fn events(samples: &[Sample]) -> usize {
    samples.iter().filter(|s| s.escalated).count()
}

fn split(samples: &[Sample]) -> Value {
    let mut out = Map::new();
    out.insert("samples".into(), Value::from(samples.len()));
    out.insert("events".into(), Value::from(events(samples)));
    Value::Object(out)
}

fn optional(x: Option<f64>) -> Value {
    x.map_or(Value::Null, js::number)
}

#[allow(
    clippy::cast_precision_loss,
    clippy::cast_possible_truncation,
    clippy::cast_sign_loss
)] // at most 24 cut-offs and far fewer than 2^53 samples
fn calibrate(
    index: &SignalIndex,
    input: &RiskInput<'_>,
    horizon: i64,
    cache: &mut ScoreCache,
) -> Result<Calibration, EngineError> {
    let cutoffs = cutoffs_for(index, input.today, horizon)?;
    let n_train = ((cutoffs.len() as f64) * 0.7).floor() as usize;
    let mut train = Vec::new();
    let mut test = Vec::new();
    for (i, t) in cutoffs.iter().enumerate() {
        let samples = samples_at(index, input, t, horizon, cache)?;
        if i < n_train {
            train.extend(samples);
        } else {
            test.extend(samples);
        }
    }
    let mut backtest = Map::new();
    backtest.insert("horizon".into(), Value::from(horizon));
    backtest.insert("cutoffs".into(), Value::from(cutoffs.len()));
    backtest.insert(
        "from".into(),
        cutoffs
            .first()
            .map_or(Value::Null, |t| Value::from(t.as_str())),
    );
    backtest.insert(
        "to".into(),
        cutoffs
            .last()
            .map_or(Value::Null, |t| Value::from(t.as_str())),
    );
    backtest.insert("train".into(), split(&train));
    backtest.insert("test".into(), split(&test));
    let train_events = events(&train);
    if train_events < MIN_TRAIN_EVENTS
        || train.len() < MIN_TRAIN_SAMPLES
        || test.len() < MIN_TEST_SAMPLES
    {
        backtest.insert("calibrated".into(), Value::Bool(false));
        backtest.insert(
            "reason".into(),
            Value::String(format!(
                "Historial insuficiente para calibrar: {} muestras y {} escalamientos en {} cortes (se necesitan al menos {} muestras y {MIN_TRAIN_EVENTS} escalamientos para entrenar).",
                train.len() + test.len(),
                train_events + events(&test),
                cutoffs.len(),
                MIN_TRAIN_SAMPLES + MIN_TEST_SAMPLES,
            )),
        );
        backtest.insert("brier".into(), Value::Null);
        backtest.insert("brierReference".into(), Value::Null);
        backtest.insert("skill".into(), Value::Null);
        backtest.insert("bins".into(), calibration::reliability_bins(&[]));
        return Ok(Calibration {
            backtest: Value::Object(backtest),
            platt: None,
            train_events,
            skill: None,
        });
    }
    let platt = calibration::fit_platt(&train);
    let rate = train_events as f64 / train.len() as f64;
    let pairs: Vec<(f64, bool)> = test
        .iter()
        .map(|s| (calibration::probability(platt, s.score), s.escalated))
        .collect();
    let model = calibration::brier(&pairs);
    let reference =
        calibration::brier(&test.iter().map(|s| (rate, s.escalated)).collect::<Vec<_>>());
    // `model !== null && reference ? … : null`: a zero or NaN reference is falsy.
    let skill = match (model, reference) {
        (Some(m), Some(r)) if r != 0.0 && !r.is_nan() => Some(round3(1.0 - m / r)),
        _ => None,
    };
    backtest.insert("calibrated".into(), Value::Bool(true));
    backtest.insert("reason".into(), Value::Null);
    backtest.insert("brier".into(), optional(model.map(round3)));
    backtest.insert("brierReference".into(), optional(reference.map(round3)));
    backtest.insert("skill".into(), optional(skill));
    backtest.insert("bins".into(), calibration::reliability_bins(&pairs));
    Ok(Calibration {
        backtest: Value::Object(backtest),
        platt: Some(platt),
        train_events,
        skill,
    })
}

fn confidence_of(calibration: &Calibration, signals: usize) -> (&'static str, String) {
    if calibration.platt.is_none() {
        return (
            "baja",
            "Historial insuficiente para calibrar; el detalle está en el back-test.".to_owned(),
        );
    }
    if signals < 2 {
        return (
            "baja",
            "Una sola señal registrada en los últimos 180 días.".to_owned(),
        );
    }
    if calibration.skill.unwrap_or(0.0) <= 0.0 {
        return (
            "baja",
            "En el back-test el modelo no supera la tasa base del proyecto.".to_owned(),
        );
    }
    let events = calibration.train_events;
    if events >= 20 {
        (
            "alta",
            format!(
                "Supera la tasa base en el back-test ({events} escalamientos de entrenamiento)."
            ),
        )
    } else {
        (
            "media",
            format!("Supera la tasa base en el back-test, con pocos escalamientos ({events})."),
        )
    }
}

fn horizon_prediction(calibration: &Calibration, score: f64) -> Value {
    let mut out = Map::new();
    match calibration.platt {
        None => {
            out.insert("probability".into(), Value::Null);
            out.insert("band".into(), Value::from(calibration::signal_band(score)));
        }
        Some(platt) => {
            let p = calibration::round_probability(calibration::probability(platt, score));
            out.insert("probability".into(), js::number(p));
            out.insert("band".into(), Value::from(calibration::probability_band(p)));
        }
    }
    Value::Object(out)
}

// --- output ---------------------------------------------------------------------------------------

fn factor_value(index: &SignalIndex, factor: &Factor) -> Value {
    let records = factor
        .records
        .iter()
        .filter_map(|&i| index.signals.get(i))
        .map(|s| {
            let mut r = Map::new();
            r.insert("module".into(), Value::from(s.module.as_str()));
            r.insert("id".into(), Value::from(s.id.as_str()));
            r.insert("title".into(), Value::from(s.title.as_str()));
            r.insert("date".into(), Value::from(s.date.as_str()));
            Value::Object(r)
        })
        .collect::<Vec<_>>();
    let mut f = Map::new();
    f.insert("id".into(), Value::from(factor.spec.id));
    f.insert("label".into(), Value::from(factor.spec.label));
    f.insert("count".into(), js::number(factor.count));
    f.insert("value".into(), js::number(factor.value));
    f.insert("contribution".into(), js::number(factor.contribution));
    f.insert("records".into(), Value::Array(records));
    Value::Object(f)
}

struct Prediction {
    locality: bool,
    name: String,
    score: f64,
    /// Built eagerly, failing only when the prediction is reported (within `MAX_UNITS`).
    value: Value,
}

/// Runs `conflictRisk` on a request (see the crate documentation for its shape).
///
/// # Errors
/// `InvalidInput` for a malformed request; `UnsupportedValue` for inputs TypeScript cannot answer.
pub fn run(request: &Map<String, Value>) -> Result<Value, EngineError> {
    let input = parse(request)?;
    let index = index_signals(&input)?;
    let mut cache = ScoreCache::new();
    let [h30, h90] = HORIZONS;
    let c30 = calibrate(&index, &input, h30, &mut cache)?;
    let c90 = calibrate(&index, &input, h90, &mut cache)?;

    let mut predictions = Vec::new();
    for (unit, key) in index.units.iter().enumerate() {
        let signals = recent_signals(&index, unit, input.today)?;
        if signals == 0 {
            continue;
        }
        let factors = features_at(&index, unit, input.today, &input.irsa)?;
        let score = score_of(&factors);
        let (confidence, reason) = confidence_of(&c90, signals);
        let name = index
            .names
            .get(key)
            .cloned()
            .unwrap_or_else(|| key.chars().skip(2).collect());
        let locality = key.starts_with("L:");
        let mut horizons = Map::new();
        horizons.insert("30".into(), horizon_prediction(&c30, score));
        horizons.insert("90".into(), horizon_prediction(&c90, score));
        let mut p = Map::new();
        p.insert("key".into(), Value::from(key.as_str()));
        p.insert(
            "kind".into(),
            Value::from(if locality { "locality" } else { "actor" }),
        );
        p.insert("name".into(), Value::from(name.as_str()));
        p.insert("score".into(), js::number(score));
        p.insert("signals".into(), Value::from(signals));
        p.insert("horizons".into(), Value::Object(horizons));
        p.insert("confidence".into(), Value::from(confidence));
        p.insert("confidenceReason".into(), Value::String(reason));
        let factors = factors
            .iter()
            .take(4)
            .map(|f| factor_value(&index, f))
            .collect();
        p.insert("factors".into(), Value::Array(factors));
        predictions.push(Prediction {
            locality,
            name,
            score,
            value: Value::Object(p),
        });
    }
    // `b.score − a.score || a.name.localeCompare(b.name, 'es')`, stable.
    predictions.sort_by(|a, b| {
        features::descending(a.score, b.score).then_with(|| collation::compare(&a.name, &b.name))
    });
    let status = if predictions.is_empty() {
        "sin datos suficientes"
    } else {
        "ok"
    };
    let (localities, actors): (Vec<Prediction>, Vec<Prediction>) =
        predictions.into_iter().partition(|p| p.locality);
    let list = |items: Vec<Prediction>| {
        Value::Array(items.into_iter().take(MAX_UNITS).map(|p| p.value).collect())
    };

    let mut backtest = Map::new();
    backtest.insert("30".into(), c30.backtest);
    backtest.insert("90".into(), c90.backtest);
    let mut out = Map::new();
    out.insert("generatedOn".into(), Value::from(input.today));
    out.insert("status".into(), Value::from(status));
    out.insert("method".into(), Value::from(METHOD));
    out.insert("backtest".into(), Value::Object(backtest));
    out.insert("localities".into(), list(localities));
    out.insert("actors".into(), list(actors));
    out.insert(
        "limitations".into(),
        Value::Array(LIMITATIONS.iter().map(|&l| Value::from(l)).collect()),
    );
    Ok(Value::Object(out))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn fixtures() -> Value {
        let path = concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../fixtures/conflict-risk.json"
        );
        std::fs::read_to_string(path)
            .ok()
            .and_then(|text| serde_json::from_str(&text).ok())
            .unwrap_or_default()
    }

    fn section<'a>(fixtures: &'a Value, path: &[&str]) -> &'a [Value] {
        path.iter()
            .try_fold(fixtures, |v, key| v.get(key))
            .and_then(Value::as_array)
            .map_or(&[], Vec::as_slice)
    }

    #[test]
    fn collation_matches_node_locale_compare() {
        let fixtures = fixtures();
        let pairs = section(&fixtures, &["collation"]);
        assert!(pairs.len() > 1000);
        let mut failures = Vec::new();
        for pair in pairs {
            let (Some(a), Some(b), Some(sign)) = (
                pair.get(0).and_then(Value::as_str),
                pair.get(1).and_then(Value::as_str),
                pair.get(2).and_then(Value::as_i64),
            ) else {
                failures.push(format!("malformed pair {pair}"));
                continue;
            };
            let got = collation::compare(a, b) as i64;
            if got != sign {
                failures.push(format!("{a:?} vs {b:?}: node {sign}, rust {got}"));
            }
        }
        assert!(failures.is_empty(), "{}", failures.join("\n"));
    }

    #[test]
    fn math_matches_v8_bit_for_bit() {
        type Function = (&'static str, fn(f64) -> f64);
        let fixtures = fixtures();
        let functions: [Function; 3] = [
            ("exp", jsmath::exp),
            ("log", jsmath::log),
            ("log1p", jsmath::log1p),
        ];
        let mut failures = Vec::new();
        for (name, f) in functions {
            let pairs = section(&fixtures, &["math", name]);
            assert!(pairs.len() > 1000, "{name}");
            for pair in pairs {
                let x = pair.get(0).and_then(Value::as_f64).unwrap_or(f64::NAN);
                let expected = pair.get(1).and_then(Value::as_f64).unwrap_or(f64::NAN);
                if f(x).to_bits() != expected.to_bits() {
                    failures.push(format!("{name}({x:e}) = {:e}, V8 {expected:e}", f(x)));
                }
            }
        }
        assert!(failures.is_empty(), "{}", failures.join("\n"));
    }

    #[test]
    fn mn_table_matches_node() {
        let fixtures = fixtures();
        let ranges: Vec<(u32, u32)> = section(&fixtures, &["mn"])
            .iter()
            .filter_map(|r| {
                let lo = u32::try_from(r.get(0)?.as_u64()?).ok()?;
                let hi = u32::try_from(r.get(1)?.as_u64()?).ok()?;
                Some((lo, hi))
            })
            .collect();
        assert_eq!(ranges.as_slice(), tables::MN);
    }

    #[test]
    fn empty_input_has_no_predictions() {
        let request = json!({"records": [], "alerts": [], "irsa": [], "today": "2026-11-02"});
        let value = request
            .as_object()
            .map(run)
            .and_then(Result::ok)
            .unwrap_or_default();
        assert_eq!(
            value.get("status").and_then(Value::as_str),
            Some("sin datos suficientes")
        );
    }
}
