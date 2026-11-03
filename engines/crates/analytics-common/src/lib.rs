//! Shared helpers of the analytics engines: the Python value semantics of
//! `apps/api/src/contexts/analytics/domain/python.ts`, the record shapes of `records.ts`, the
//! closed-state constants of `strategic.ts`, and request parsing for the JSON ABI
//! (engines/README.md). JavaScript number text, `JSON.stringify` and `trim` come from
//! `sipges_indicators::js`.

use serde_json::{Map, Value};
pub use sipges_indicators::{EngineError, js};

/// A record as the engines see it (`AnalysisRecord`): its payload with the record id under `_id`.
pub type Record = Map<String, Value>;

/// `pyStr`: Python `str()` of a JSON value; a missing value (`undefined`) is `""`.
#[must_use]
pub fn py_str(value: Option<&Value>) -> String {
    match value {
        None => String::new(),
        Some(Value::Null) => "None".to_owned(),
        Some(Value::Bool(true)) => "True".to_owned(),
        Some(Value::Bool(false)) => "False".to_owned(),
        Some(Value::String(s)) => s.clone(),
        Some(Value::Number(n)) => js::number_to_string(n.as_f64().unwrap_or(f64::NAN)),
        Some(other) => js::stringify(other),
    }
}

/// `pyTruthy`: Python truthiness of a JSON value; a missing value is falsy.
#[must_use]
pub fn py_truthy(value: Option<&Value>) -> bool {
    match value {
        None | Some(Value::Null) => false,
        Some(Value::Bool(b)) => *b,
        Some(Value::Number(n)) => n.as_f64().is_some_and(|x| x != 0.0),
        Some(Value::String(s)) => !s.is_empty(),
        Some(Value::Array(items)) => !items.is_empty(),
        Some(Value::Object(map)) => !map.is_empty(),
    }
}

/// `pyStrip`: `pyStr(value).trim()` with ECMAScript whitespace.
#[must_use]
pub fn py_strip(value: Option<&Value>) -> String {
    js::trim(&py_str(value)).to_owned()
}

/// The empty string, the default of `pyGet`.
pub static EMPTY: Value = Value::String(String::new());

/// `pyGet(record, key)`: the stored value even when `null`, `""` only when the key is absent.
#[must_use]
pub fn py_get<'a>(record: &'a Record, key: &str) -> &'a Value {
    record.get(key).unwrap_or(&EMPTY)
}

/// `pyGet(record, key, fallback)`.
#[must_use]
pub fn py_get_or<'a>(record: &'a Record, key: &str, fallback: &'a Value) -> &'a Value {
    record.get(key).unwrap_or(fallback)
}

/// `mostCommon`: `Counter(values).most_common(limit)`, count descending, ties in first-seen order.
#[must_use]
pub fn most_common<S: AsRef<str>>(values: &[S], limit: Option<usize>) -> Vec<(String, usize)> {
    let mut counts: Vec<(String, usize)> = Vec::new();
    let mut index: std::collections::HashMap<&str, usize> = std::collections::HashMap::new();
    for value in values {
        let value = value.as_ref();
        if let Some(&i) = index.get(value) {
            if let Some(entry) = counts.get_mut(i) {
                entry.1 += 1;
            }
        } else {
            index.insert(value, counts.len());
            counts.push((value.to_owned(), 1));
        }
    }
    counts.sort_by_key(|entry| std::cmp::Reverse(entry.1)); // stable, like Array.prototype.sort
    if let Some(limit) = limit {
        counts.truncate(limit);
    }
    counts
}

/// Legacy project of the Python installation (`DEFAULT_PROJECT_ID`).
pub const DEFAULT_PROJECT_ID: &str = "PRJ-SECHURA";

/// `SITUATIONAL_MODULES`, in order.
pub const SITUATIONAL_MODULES: [&str; 8] = [
    "Eventos",
    "Actores",
    "Demandas",
    "Compromisos",
    "Narrativas",
    "Alertas",
    "Acciones",
    "Fuentes",
];

/// `EXTENDED_MODULES` (key, module), in its key order.
pub const EXTENDED_MODULES: [(&str, &str); 5] = [
    ("intereses", "Intereses"),
    ("dialogos", "Dialogos"),
    ("oportunidades", "Oportunidades"),
    ("hechos", "Hechos_Compartidos"),
    ("aarc", "Evaluaciones_AARC"),
];

/// `FACT_CLOSED` (strategic.ts).
pub const FACT_CLOSED: [&str; 3] = ["validado", "cerrado", "descartado"];
/// `OPPORTUNITY_CLOSED` (strategic.ts).
pub const OPPORTUNITY_CLOSED: [&str; 4] = ["descartada", "descartado", "cerrada", "cerrado"];
/// `DIALOGUE_CLOSED` (strategic.ts).
pub const DIALOGUE_CLOSED: [&str; 3] = ["cerrado", "cerrada", "finalizado"];
/// `AARC_DIMENSIONS` (label, field) (strategic.ts).
pub const AARC_DIMENSIONS: [(&str, &str); 4] = [
    ("Reconocimiento", "reconocimiento"),
    ("Agencia", "agencia"),
    ("Reciprocidad", "reciprocidad"),
    ("Claridad", "claridad"),
];

/// `ExtendedRecords`: the RC 1.7 second-layer records, by key.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Extended {
    /// `Intereses`.
    pub intereses: Vec<Record>,
    /// `Dialogos`.
    pub dialogos: Vec<Record>,
    /// `Oportunidades`.
    pub oportunidades: Vec<Record>,
    /// `Hechos_Compartidos`.
    pub hechos: Vec<Record>,
    /// `Evaluaciones_AARC`.
    pub aarc: Vec<Record>,
}

impl Extended {
    /// The records under an `EXTENDED_MODULES` key (`r[key]`); unknown keys have none.
    #[must_use]
    pub fn get(&self, key: &str) -> &[Record] {
        match key {
            "intereses" => &self.intereses,
            "dialogos" => &self.dialogos,
            "oportunidades" => &self.oportunidades,
            "hechos" => &self.hechos,
            "aarc" => &self.aarc,
            _ => &[],
        }
    }

    /// `extendedCounts`: `{intereses, dialogos, oportunidades, hechos, aarc}` record counts.
    #[must_use]
    pub fn counts(&self) -> Value {
        let mut out = Map::new();
        for (key, _) in EXTENDED_MODULES {
            out.insert(key.to_owned(), Value::from(self.get(key).len()));
        }
        Value::Object(out)
    }
}

/// `recordWithId`: `{...payload, _id: id}` (an existing `_id` key keeps its position).
#[must_use]
pub fn record_with_id(id: &str, payload: &Map<String, Value>) -> Record {
    let mut record = payload.clone();
    record.insert("_id".to_owned(), Value::String(id.to_owned()));
    record
}

/// `(byModule[module] ?? []).map(recordWithId)` for a `RecordsByModule` JSON object
/// (`{module: [{id, payload}]}`).
///
/// # Errors
/// `InvalidInput` when `by_module` is not an object, a module is not an array, or a record lacks a
/// string `id` or an object `payload`.
pub fn module_records(by_module: &Value, module: &str) -> Result<Vec<Record>, EngineError> {
    let Value::Object(map) = by_module else {
        return Err(EngineError::input(
            "records must be an object of module arrays",
        ));
    };
    // `byModule[module] ?? []`: an absent or `null` module has no records.
    let rows = match map.get(module) {
        None | Some(Value::Null) => return Ok(Vec::new()),
        Some(rows) => rows,
    };
    let Value::Array(rows) = rows else {
        return Err(EngineError::input(format!(
            "records.{module} must be an array"
        )));
    };
    rows.iter()
        .map(|row| match (row.get("id"), row.get("payload")) {
            (Some(Value::String(id)), Some(Value::Object(payload))) => {
                Ok(record_with_id(id, payload))
            }
            _ => Err(EngineError::input(format!(
                "records.{module} items must be {{id: string, payload: object}}"
            ))),
        })
        .collect()
}

/// `extendedRecords(byModule)`.
///
/// # Errors
/// As [`module_records`].
pub fn extended_records(by_module: &Value) -> Result<Extended, EngineError> {
    Ok(Extended {
        intereses: module_records(by_module, "Intereses")?,
        dialogos: module_records(by_module, "Dialogos")?,
        oportunidades: module_records(by_module, "Oportunidades")?,
        hechos: module_records(by_module, "Hechos_Compartidos")?,
        aarc: module_records(by_module, "Evaluaciones_AARC")?,
    })
}

/// A required string field of the request (for example `project_id`, `generated_at`).
///
/// # Errors
/// `InvalidInput` when the field is absent or not a string.
pub fn str_field<'a>(request: &'a Map<String, Value>, key: &str) -> Result<&'a str, EngineError> {
    match request.get(key) {
        Some(Value::String(s)) => Ok(s),
        _ => Err(EngineError::input(format!("{key} must be a string"))),
    }
}

/// The request's `records` field (`RecordsByModule`); absent or `null` is `{}`.
#[must_use]
pub fn records_field(request: &Map<String, Value>) -> Value {
    match request.get("records") {
        None | Some(Value::Null) => Value::Object(Map::new()),
        Some(v) => v.clone(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn py_str_matches_the_typescript_helper() {
        assert_eq!(py_str(None), "");
        assert_eq!(py_str(Some(&Value::Null)), "None");
        assert_eq!(py_str(Some(&json!(true))), "True");
        assert_eq!(py_str(Some(&json!(1.5))), "1.5");
        assert_eq!(py_str(Some(&json!(10))), "10");
        assert_eq!(py_str(Some(&json!({"a": [1]}))), r#"{"a":[1]}"#);
        assert_eq!(py_strip(Some(&json!("\u{feff} x \n"))), "x");
    }

    #[test]
    fn truthiness_and_get() {
        assert!(!py_truthy(None));
        assert!(!py_truthy(Some(&json!(0))));
        assert!(!py_truthy(Some(&json!([]))));
        assert!(!py_truthy(Some(&json!({}))));
        assert!(py_truthy(Some(&json!("0"))));
        let record: Record = serde_json::from_value(json!({"a": null})).unwrap_or_default();
        assert_eq!(py_get(&record, "a"), &Value::Null);
        assert_eq!(py_get(&record, "b"), &EMPTY);
    }

    #[test]
    fn most_common_keeps_first_seen_order_on_ties() {
        let got = most_common(&["b", "a", "a", "b", "c"], None);
        assert_eq!(got, vec![("b".into(), 2), ("a".into(), 2), ("c".into(), 1)]);
        assert_eq!(most_common(&["x", "y"], Some(1)), vec![("x".into(), 1)]);
    }

    #[test]
    fn records_keep_payload_order_and_reject_bad_shapes() {
        let by_module = json!({"Intereses": [{"id": "I-1", "payload": {"_id": "old", "b": 1}}]});
        let ext = extended_records(&by_module).unwrap_or_default();
        assert_eq!(
            ext.intereses
                .first()
                .map(|r| js::stringify(&Value::Object(r.clone())))
                .unwrap_or_default(),
            r#"{"_id":"I-1","b":1}"#
        );
        assert_eq!(
            js::stringify(&ext.counts()),
            r#"{"intereses":1,"dialogos":0,"oportunidades":0,"hechos":0,"aarc":0}"#
        );
        assert_eq!(
            module_records(&json!({"Intereses": null}), "Intereses"),
            Ok(Vec::new())
        );
        assert!(module_records(&json!({"Intereses": "x"}), "Intereses").is_err());
        assert!(module_records(&json!([]), "Intereses").is_err());
        assert!(
            module_records(
                &json!({"Intereses": [{"id": 1, "payload": {}}]}),
                "Intereses"
            )
            .is_err()
        );
    }
}
