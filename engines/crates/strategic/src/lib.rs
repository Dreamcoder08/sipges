//! Strategic assessment engine: port of `apps/api/src/contexts/analytics/domain/strategic.ts`
//! (app.py:715), the descriptive metrics of the RC 1.7 second layer.
//!
//! `js::stringify(&run(request)?)` equals `JSON.stringify(strategicAssessment(extendedRecords(
//! records), project_id, generated_at))` byte for byte (fixtures in `engines/fixtures/strategic.ts`).

use serde_json::{Map, Value};
pub use sipges_analytics_common::EngineError;
use sipges_analytics_common::{
    AARC_DIMENSIONS, DIALOGUE_CLOSED, Extended, FACT_CLOSED, OPPORTUNITY_CLOSED, Record,
    extended_records, py_get, py_str, py_strip, records_field, str_field,
};

const LIMITATIONS: [&str; 3] = [
    "Métricas descriptivas sobre registros: no representan un índice de consenso ni una estimación predictiva.",
    "Las calificaciones AARC, cuando existan, son observaciones cualitativas; no se incorporan al IRSA.",
    "Registrar fuentes, fecha y validación antes de tomar decisiones o comunicar resultados.",
];

const ATTENTION_FACTS: &str =
    "Existen hechos o datos pendientes de contraste documental y validación conjunta.";
const ATTENTION_DIALOGUES: &str =
    "Existen procesos de diálogo registrados que requieren seguimiento.";
const ATTENTION_OPPORTUNITIES: &str =
    "Existen oportunidades registradas cuya viabilidad y responsables deben revisarse.";

/// `state(x)`: `pyStr(pyGet(x, 'Estado')).toLowerCase()`.
fn state(record: &Record) -> String {
    py_str(Some(py_get(record, "Estado"))).to_lowercase()
}

/// Records whose state is not in `closed`.
fn open_count(records: &[Record], closed: &[&str]) -> usize {
    records
        .iter()
        .filter(|x| !closed.contains(&state(x).as_str()))
        .count()
}

/// Runs the engine on a JSON request `{records, project_id, generated_at}`.
///
/// # Errors
/// `InvalidInput` when `project_id` or `generated_at` is not a string, or `records` is not a
/// `RecordsByModule` object.
pub fn run(request: &Map<String, Value>) -> Result<Value, EngineError> {
    let project_id = str_field(request, "project_id")?;
    let generated_at = str_field(request, "generated_at")?;
    let records = extended_records(&records_field(request))?;
    strategic_assessment(&records, project_id, generated_at)
}

/// `strategicAssessment(r, projectId, generatedAt)`.
///
/// # Errors
/// None today; the `Result` keeps the engine signature uniform.
pub fn strategic_assessment(
    r: &Extended,
    project_id: &str,
    generated_at: &str,
) -> Result<Value, EngineError> {
    let pending = open_count(&r.hechos, &FACT_CLOSED);
    let opportunities = open_count(&r.oportunidades, &OPPORTUNITY_CLOSED);
    let dialogues = open_count(&r.dialogos, &DIALOGUE_CLOSED);
    let completed = r
        .aarc
        .iter()
        .filter(|x| {
            AARC_DIMENSIONS
                .iter()
                .all(|(key, _)| !py_strip(Some(py_get(x, key))).is_empty())
        })
        .count();

    let mut attention = Vec::new();
    if pending > 0 {
        attention.push(Value::from(ATTENTION_FACTS));
    }
    if dialogues > 0 {
        attention.push(Value::from(ATTENTION_DIALOGUES));
    }
    if opportunities > 0 {
        attention.push(Value::from(ATTENTION_OPPORTUNITIES));
    }

    let mut out = Map::new();
    out.insert("project_id".to_owned(), Value::from(project_id));
    out.insert("generated_at".to_owned(), Value::from(generated_at));
    out.insert("counts".to_owned(), r.counts());
    out.insert("facts_pending".to_owned(), Value::from(pending));
    out.insert("opportunities_open".to_owned(), Value::from(opportunities));
    out.insert("dialogues_open".to_owned(), Value::from(dialogues));
    out.insert("aarc_complete".to_owned(), Value::from(completed));
    out.insert("attention".to_owned(), Value::Array(attention));
    out.insert(
        "limitations".to_owned(),
        Value::Array(LIMITATIONS.iter().copied().map(Value::from).collect()),
    );
    Ok(Value::Object(out))
}
