//! IRSA v0.4 (app.py:1619 `compute_irsa`; apps/api/src/contexts/indicators/domain/irsa.ts).

use crate::error::EngineError;
use crate::indicators::{DIMENSIONS, VALIDATION_STATUS};
use crate::js;
use crate::python::py_round;
use serde_json::{Map, Value};

type Result<T> = std::result::Result<T, EngineError>;

/// `CONFIG_VERSION`.
pub const CONFIG_VERSION: &str = "0.4-indicators";
const FALLBACK_LEVEL: &str = "Rojo";
const MAX_DRIVERS: usize = 15;
/// Dimension I measures traceability, not field evidence: it never counts as data.
const EVIDENCE_DIMENSIONS: [&str; 5] = ["G", "A", "D", "N", "E"];
const WEIGHT_TOLERANCE: f64 = 0.02;
const NOTES: [&str; 3] = [
    "El IRSA V0.4 se calcula desde indicadores desagregados G1–I6.",
    "Los indicadores no calculables por falta de datos se excluyen del promedio de su dimensión.",
    "Los métodos actuales son reglas/proxies transparentes para prototipado; requieren validación y calibración.",
];

/// `value[key] ?? 0` for a numeric field. Property reads on primitives give `undefined` (0);
/// non-numeric values are rejected instead of being coerced the JavaScript way.
fn number_or_zero(container: Option<&Value>, key: &str, path: &str) -> Result<f64> {
    let Some(Value::Object(map)) = container else {
        return Ok(0.0);
    };
    match map.get(key) {
        None | Some(Value::Null) => Ok(0.0),
        Some(Value::Number(n)) => Ok(n.as_f64().unwrap_or(f64::NAN)),
        Some(_) => Err(EngineError::input(format!("{path}.{key} must be a number"))),
    }
}

/// A container read with `container[key]` in TypeScript: `null`/`undefined` make it throw.
fn required<'a>(value: Option<&'a Value>, path: &str) -> Result<&'a Value> {
    match value {
        None | Some(Value::Null) => Err(EngineError::input(format!("{path} is required"))),
        Some(v) => Ok(v),
    }
}

/// First band whose inclusive range contains the value; gaps, overflow and NaN fall back to Rojo.
///
/// # Errors
/// `InvalidInput` when `thresholds` is not an object of `[low, high]` number arrays.
pub fn select_band(irsa: f64, thresholds: &Value) -> Result<String> {
    let Value::Object(bands) = thresholds else {
        return Err(EngineError::input(
            "thresholds must be an object of [low, high] arrays",
        ));
    };
    for (name, range) in js::entries(bands) {
        let Value::Array(bounds) = range else {
            return Err(EngineError::input(format!(
                "thresholds.{name} must be a [low, high] array"
            )));
        };
        // `[lo, hi]` destructuring: a missing bound is undefined and every comparison is false.
        let bound = |i: usize| -> Result<Option<f64>> {
            match bounds.get(i) {
                None => Ok(None),
                Some(Value::Number(n)) => Ok(n.as_f64()),
                Some(_) => Err(EngineError::input(format!(
                    "thresholds.{name}[{i}] must be a number"
                ))),
            }
        };
        if let (Some(lo), Some(hi)) = (bound(0)?, bound(1)?)
            && lo <= irsa
            && irsa <= hi
        {
            return Ok(name.clone());
        }
    }
    Ok(FALLBACK_LEVEL.to_owned())
}

fn driver(x: &Value, i: usize) -> Result<Option<(f64, Value)>> {
    let Value::Object(x) = x else {
        return Err(EngineError::input(format!(
            "report.indicators[{i}] must be an object"
        )));
    };
    let score = match x.get("score") {
        Some(Value::Null) => return Ok(None),
        Some(Value::Number(n)) => n.as_f64().unwrap_or(f64::NAN),
        _ => {
            return Err(EngineError::input(format!(
                "report.indicators[{i}].score must be a number or null"
            )));
        }
    };
    let points = py_round(score, 2)?;
    let mut d = Map::new();
    let mut copy = |to: &str, from: &str| {
        if let Some(v) = x.get(from) {
            d.insert(to.to_owned(), v.clone());
        }
    };
    copy("dimension", "dimension");
    copy("dimension_label", "dimension_label");
    d.insert("type".into(), Value::String("indicador".into()));
    let mut copy = |to: &str, from: &str| {
        if let Some(v) = x.get(from) {
            d.insert(to.to_owned(), v.clone());
        }
    };
    copy("id", "code");
    copy("label", "name");
    d.insert("points".into(), js::number(points));
    for key in ["confidence", "explanation"] {
        if let Some(v) = x.get(key) {
            d.insert(key.to_owned(), v.clone());
        }
    }
    Ok(Some((points, Value::Object(d))))
}

/// `coverageOf(report)`: per dimension, the largest `evidence_count` among its scored indicators
/// (0 when none is scored).
fn coverage_of(report: &Map<String, Value>) -> Result<Vec<(&'static str, f64)>> {
    let dimensions = required(report.get("dimensions"), "report.dimensions")?;
    let mut coverage = Vec::with_capacity(DIMENSIONS.len());
    for (d, _) in DIMENSIONS {
        let path = format!("report.dimensions.{d}");
        let Some(Value::Array(items)) = dimensions.get(d) else {
            return Err(EngineError::input(format!("{path} must be an array")));
        };
        let mut largest = 0.0_f64;
        for (i, x) in items.iter().enumerate() {
            let Value::Object(x) = x else {
                return Err(EngineError::input(format!("{path}[{i}] must be an object")));
            };
            if matches!(x.get("score"), Some(Value::Null)) {
                continue;
            }
            let Some(count) = x.get("evidence_count").and_then(Value::as_f64) else {
                return Err(EngineError::input(format!(
                    "{path}[{i}].evidence_count must be a number"
                )));
            };
            largest = largest.max(count);
        }
        coverage.push((d, largest));
    }
    Ok(coverage)
}

/// `computeIrsa(config, report)`: weighted dimension scores, band and top drivers.
///
/// # Errors
/// `InvalidInput` for shapes the TypeScript engine throws on; `UnsupportedValue` when a value to
/// round reaches 1e21.
pub fn compute_irsa(config: &Value, report: &Value) -> Result<Value> {
    let Value::Object(config) = config else {
        return Err(EngineError::input("config must be an object"));
    };
    let Value::Object(report) = report else {
        return Err(EngineError::input("report must be an object"));
    };
    let weights = required(config.get("weights"), "config.weights")?;
    let scores = required(report.get("dimension_scores"), "report.dimension_scores")?;
    let thresholds = required(config.get("thresholds"), "config.thresholds")?;
    let mut sum = 0.0;
    for (d, _) in DIMENSIONS {
        let s = number_or_zero(Some(scores), d, "report.dimension_scores")?;
        let w = number_or_zero(Some(weights), d, "config.weights")?;
        sum += s * w;
    }
    let irsa = py_round(sum, 2)?;
    let Some(Value::Array(indicators)) = report.get("indicators") else {
        return Err(EngineError::input("report.indicators must be an array"));
    };
    let mut drivers = Vec::new();
    for (i, x) in indicators.iter().enumerate() {
        if let Some(entry) = driver(x, i)? {
            drivers.push(entry);
        }
    }
    // Stable, like Array.prototype.sort and Python sorted(); points are finite.
    drivers.sort_by(|a, b| b.0.total_cmp(&a.0));
    drivers.truncate(MAX_DRIVERS);
    let level = select_band(irsa, thresholds)?;
    let coverage = coverage_of(report)?;
    let insufficient = EVIDENCE_DIMENSIONS.iter().all(|d| {
        coverage
            .iter()
            .any(|(name, count)| name == d && *count == 0.0)
    });
    let mut out = Map::new();
    out.insert("irsa".into(), js::number(irsa));
    out.insert("level".into(), Value::String(level));
    out.insert("scores".into(), scores.clone());
    out.insert("weights".into(), weights.clone());
    out.insert("thresholds".into(), thresholds.clone());
    out.insert(
        "drivers".into(),
        Value::Array(drivers.into_iter().map(|(_, d)| d).collect()),
    );
    for (to, from) in [("details", "dimensions"), ("availability", "availability")] {
        if let Some(v) = report.get(from) {
            out.insert(to.into(), v.clone());
        }
    }
    let mut counts = Map::new();
    for (d, count) in coverage {
        counts.insert(d.to_owned(), js::number(count));
    }
    out.insert("coverage".into(), Value::Object(counts));
    out.insert("insufficient_data".into(), Value::Bool(insufficient));
    if let Some(v) = report.get("indicators") {
        out.insert("indicators".into(), v.clone());
    }
    out.insert(
        "config_version".into(),
        Value::String(CONFIG_VERSION.into()),
    );
    out.insert("status".into(), Value::String(VALIDATION_STATUS.into()));
    out.insert(
        "notes".into(),
        Value::Array(NOTES.iter().map(|n| Value::String((*n).into())).collect()),
    );
    Ok(Value::Object(out))
}

/// `applyIrsaConfigPatch(config, patch)`: weights over every dimension must sum to 1 ± 0.02.
/// Returns the TypeScript `Result`: `{"ok":true,"value":config}` or `{"ok":false,"error":"weights_sum"}`.
///
/// # Errors
/// `InvalidInput` when `config` or `patch` is not an object or a patched field has a shape the
/// TypeScript engine does not type (non-numeric weights, non-object contributions).
pub fn apply_irsa_config_patch(config: &Value, patch: &Value) -> Result<Value> {
    let Value::Object(config) = config else {
        return Err(EngineError::input("config must be an object"));
    };
    let Value::Object(patch) = patch else {
        return Err(EngineError::input("patch must be an object"));
    };
    let mut next = config.clone();
    if js::truthy(patch.get("weights")) {
        let w = patch.get("weights");
        let mut weights = Map::new();
        let mut total = 0.0;
        for (d, _) in DIMENSIONS {
            let x = number_or_zero(w, d, "patch.weights")?;
            total += x;
            weights.insert(d.to_owned(), js::number(x));
        }
        if (total - 1.0).abs() > WEIGHT_TOLERANCE {
            let mut err = Map::new();
            err.insert("ok".into(), Value::Bool(false));
            err.insert("error".into(), Value::String("weights_sum".into()));
            return Ok(Value::Object(err));
        }
        next.insert("weights".into(), Value::Object(weights));
    }
    if let Some(thresholds) = patch.get("thresholds").filter(|t| js::truthy(Some(t))) {
        next.insert("thresholds".into(), thresholds.clone());
    }
    if let Some(extra) = patch.get("contributions").filter(|c| js::truthy(Some(c))) {
        let Value::Object(extra) = extra else {
            return Err(EngineError::input("patch.contributions must be an object"));
        };
        let mut merged = match next.get("contributions") {
            None | Some(Value::Null) => Map::new(),
            Some(Value::Object(base)) => base.clone(),
            Some(_) => return Err(EngineError::input("config.contributions must be an object")),
        };
        // `{ ...base, ...extra }`: existing keys keep their position, new ones are appended.
        for (key, value) in js::entries(extra) {
            merged.insert(key.clone(), value.clone());
        }
        next.insert("contributions".into(), Value::Object(merged));
    }
    let mut ok = Map::new();
    ok.insert("ok".into(), Value::Bool(true));
    ok.insert("value".into(), Value::Object(next));
    Ok(Value::Object(ok))
}

#[cfg(test)]
mod tests {
    use crate::compute;
    use serde_json::{Value, json};

    const EMPTY_RECORDS: &str = r#"{"Eventos":[],"Actores":[],"Demandas":[],"Compromisos":[],"Narrativas":[],"Alertas":[],"Acciones":[],"Directorio_Territorial":[]}"#;

    fn irsa(request: &str) -> Value {
        let response: Value = serde_json::from_slice(&compute(request.as_bytes()))
            .unwrap_or_else(|e| unreachable!("the engine answers JSON: {e}"));
        assert_eq!(response.pointer("/ok"), Some(&json!(true)), "{response}");
        response.pointer("/value").cloned().unwrap_or_default()
    }

    /// `out.pointer(path)`, `null` when absent.
    fn at(out: &Value, path: &str) -> Value {
        out.pointer(path).cloned().unwrap_or_default()
    }

    /// A report whose scored indicators carry the given `evidence_count` per dimension.
    fn report(counts: [(&str, u64); 6]) -> String {
        let dimension = |d: &str, n: u64| {
            json!([
                {"code": format!("{d}1"), "score": 40, "evidence_count": n},
                {"code": format!("{d}2"), "score": null, "evidence_count": 99},
            ])
        };
        let mut dimensions = serde_json::Map::new();
        for (d, n) in counts {
            dimensions.insert(d.to_owned(), dimension(d, n));
        }
        json!({
            "dimensions": dimensions,
            "dimension_scores": {"G": 0, "A": 0, "D": 0, "N": 0, "E": 0, "I": 33.33},
            "availability": {"G": 0, "A": 0, "D": 0, "N": 0, "E": 0, "I": 0},
            "indicators": [],
        })
        .to_string()
    }

    fn with_report(counts: [(&str, u64); 6]) -> Value {
        irsa(&format!(r#"{{"op":"irsa","report":{}}}"#, report(counts)))
    }

    #[test]
    fn an_empty_project_has_insufficient_data() {
        let out = irsa(&format!(r#"{{"op":"irsa","records":{EMPTY_RECORDS}}}"#));
        assert_eq!(at(&out, "/insufficient_data"), json!(true));
        assert_eq!(
            at(&out, "/coverage"),
            json!({"G": 0, "A": 0, "D": 0, "N": 0, "E": 0, "I": 0})
        );
        // S5: the stored result keeps its values.
        assert_eq!(at(&out, "/irsa"), json!(5.55));
        assert_eq!(at(&out, "/level"), json!("Verde"));
    }

    #[test]
    fn one_input_in_one_evidence_dimension_is_enough() {
        let out = with_report([("G", 0), ("A", 0), ("D", 1), ("N", 0), ("E", 0), ("I", 0)]);
        assert_eq!(at(&out, "/insufficient_data"), json!(false));
        assert_eq!(
            at(&out, "/coverage"),
            json!({"G": 0, "A": 0, "D": 1, "N": 0, "E": 0, "I": 0})
        );
    }

    #[test]
    fn data_only_in_the_institutional_dimension_is_insufficient() {
        let out = with_report([("G", 0), ("A", 0), ("D", 0), ("N", 0), ("E", 0), ("I", 7)]);
        assert_eq!(at(&out, "/insufficient_data"), json!(true));
        assert_eq!(at(&out, "/coverage/I"), json!(7));
    }

    #[test]
    fn coverage_is_the_largest_evidence_count_of_the_scored_indicators() {
        let out = with_report([("G", 3), ("A", 0), ("D", 0), ("N", 0), ("E", 0), ("I", 0)]);
        // The unscored G2 carries 99 and must not count.
        assert_eq!(at(&out, "/coverage/G"), json!(3));
    }

    #[test]
    fn the_new_fields_sit_between_availability_and_indicators() {
        let out = with_report([("G", 1), ("A", 0), ("D", 0), ("N", 0), ("E", 0), ("I", 0)]);
        let keys: Vec<&str> = out
            .as_object()
            .map(|m| m.keys().map(String::as_str).collect())
            .unwrap_or_default();
        let place = |k: &str| keys.iter().position(|x| *x == k);
        assert_eq!(place("coverage"), place("availability").map(|i| i + 1));
        assert_eq!(place("insufficient_data"), place("coverage").map(|i| i + 1));
        assert_eq!(
            place("indicators"),
            place("insufficient_data").map(|i| i + 1)
        );
    }
}
