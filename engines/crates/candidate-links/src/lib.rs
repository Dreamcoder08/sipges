//! Candidate links between extended records: the port of
//! `apps/api/src/contexts/analytics/domain/candidate-links.ts` (app.py `candidate_pairs`, RC 1.9).
//! A link is a reproducible hypothesis; it never implies consent, representation or approval.
//!
//! `String.prototype.normalize('NFKD')` and the `\p{M}` removal use `unicode-normalization`
//! (Unicode 17.0.0); Node takes both from ICU, so a Node whose ICU implements an older Unicode
//! version can differ only on characters assigned or re-categorised after that version.

use std::collections::HashSet;

use serde_json::{Map, Value};
use sipges_analytics_common::{
    Extended, Record, extended_records, py_get, py_str, py_strip, py_truthy, records_field,
};
use unicode_normalization::UnicodeNormalization;
use unicode_normalization::char::is_combining_mark;

pub use sipges_analytics_common::EngineError;

/// app.py STOPWORDS (RC 1.9), verbatim.
const STOPWORDS: &[&str] = &[
    "para",
    "como",
    "entre",
    "desde",
    "sobre",
    "este",
    "esta",
    "estos",
    "estas",
    "donde",
    "cuando",
    "porque",
    "alguno",
    "alguna",
    "unas",
    "unos",
    "los",
    "las",
    "del",
    "por",
    "con",
    "que",
    "una",
    "uno",
    "algo",
    "ante",
    "bajo",
    "frente",
    "proyecto",
    "actor",
    "actores",
    "local",
    "locales",
    "comunidad",
    "comunidades",
    "territorio",
    "registro",
    "propuesta",
    "proceso",
    "potencial",
    "posible",
    "sus",
    "suyo",
    "caso",
    "debe",
    "estar",
    "parte",
    "mediante",
];

/// `thematicTerms`: accent-insensitive 4+ letter tokens without stopwords, in first-seen order
/// (a JavaScript `Set` of `text.toLowerCase().normalize('NFKD').replace(/\p{M}/gu, '')`
/// matched by `/[a-z]{4,}/g`).
#[must_use]
pub fn thematic_terms(value: Option<&Value>) -> Vec<String> {
    let text = py_str(if py_truthy(value) { value } else { None });
    terms_of(&text)
}

fn terms_of(text: &str) -> Vec<String> {
    let lower = text.to_lowercase();
    let mut out: Vec<String> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();
    let mut word = String::new();
    let mut flush = |word: &mut String| {
        if word.len() >= 4 && !STOPWORDS.contains(&word.as_str()) && seen.insert(word.clone()) {
            out.push(word.clone());
        }
        word.clear();
    };
    for c in lower.nfkd().filter(|&c| !is_combining_mark(c)) {
        if c.is_ascii_lowercase() {
            word.push(c);
        } else {
            flush(&mut word);
        }
    }
    flush(&mut word);
    out
}

const ID_FIELDS: [&str; 5] = [
    "ID_Actor",
    "ID_Demanda",
    "ID_Proceso",
    "Tema_ID",
    "Vinculo_ID",
];
const REFERENCE_FIELDS: [&str; 2] = ["Registros_Relacionados", "Referencias_ID"];

/// `references`: the trimmed, non-empty comma-separated values of a field, in first-seen order.
fn references(x: &Record, field: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for token in py_str(Some(py_get(x, field))).split(',') {
        let token = sipges_analytics_common::js::trim(token);
        if !token.is_empty() && !out.iter().any(|t| t == token) {
            out.push(token.to_owned());
        }
    }
    out
}

/// What `record_links` compares, computed once per record.
struct LinkKeys {
    id: String,
    /// Stripped, lower-cased `ID_FIELDS` values (`""` when empty), in field order.
    ids: [String; 5],
    /// `REFERENCE_FIELDS` values as sets, in field order.
    refs: [HashSet<String>; 2],
}

fn record_id(x: &Record) -> String {
    match x.get("_id") {
        Some(Value::String(s)) => s.clone(),
        other => py_str(other),
    }
}

fn link_keys(x: &Record) -> LinkKeys {
    LinkKeys {
        id: record_id(x),
        ids: ID_FIELDS.map(|field| py_strip(Some(py_get(x, field))).to_lowercase()),
        refs: REFERENCE_FIELDS.map(|field| references(x, field).into_iter().collect()),
    }
}

/// `linkBetween`: the criterion and the matched id field, or `None`.
fn link_between(a: &LinkKeys, b: &LinkKeys) -> Option<(&'static str, Option<&'static str>)> {
    for ((field, left), right) in ID_FIELDS.iter().zip(&a.ids).zip(&b.ids) {
        if !left.is_empty() && left == right {
            return Some(("referencia explícita", Some(field)));
        }
    }
    for (left, right) in a.refs.iter().zip(&b.refs) {
        if right.contains(&a.id) || left.contains(&b.id) || left.iter().any(|t| right.contains(t)) {
            return Some(("referencia cruzada", None));
        }
    }
    None
}

/// `recordLinks(a, b)`: `["referencia explícita", [field]]`, `["referencia cruzada", []]` or
/// `null`.
#[must_use]
pub fn record_links(a: &Record, b: &Record) -> Value {
    match link_between(&link_keys(a), &link_keys(b)) {
        None => Value::Null,
        Some((criterion, field)) => Value::Array(vec![
            Value::from(criterion),
            Value::Array(field.into_iter().map(Value::from).collect()),
        ]),
    }
}

/// (left module, right module, left fields, right fields).
type PairSpec = (
    &'static str,
    &'static str,
    &'static [&'static str],
    &'static [&'static str],
);

const SPECS: [PairSpec; 4] = [
    (
        "intereses",
        "oportunidades",
        &["Interes", "Preocupacion"],
        &["Oportunidad", "Tipo", "Beneficiarios"],
    ),
    (
        "hechos",
        "dialogos",
        &["Asunto", "Preguntas"],
        &["Tema", "Proceso"],
    ),
    (
        "intereses",
        "dialogos",
        &["Posicion", "Interes", "Preocupacion"],
        &["Tema", "Proceso"],
    ),
    (
        "hechos",
        "oportunidades",
        &["Asunto", "Preguntas"],
        &["Oportunidad", "Restricciones"],
    ),
];

const PER_MODULE: usize = 150;
const MAX_PAIRS: usize = 120;
const LEXICAL: &str = "coincidencia léxica (no implica relación probada)";
const ESTADO: &str = "Hipótesis de vínculo; verificar con fuentes y participantes";
const USO_SUGERIDO: &str = "Revisar pertinencia del vínculo, intereses expresados y posibles restricciones antes de diseñar opciones";

/// `joined`: the fields' Python strings (`''` when falsy) joined by spaces.
fn joined(x: &Record, fields: &[&str]) -> String {
    fields
        .iter()
        .map(|k| {
            let v = py_get(x, k);
            if py_truthy(Some(v)) {
                py_str(Some(v))
            } else {
                String::new()
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

fn first(records: &[Record]) -> &[Record] {
    records.get(..PER_MODULE).unwrap_or(records)
}

/// `candidatePairs(r)`: at most `MAX_PAIRS` `CandidateLink` objects, in spec and record order.
///
/// # Errors
/// Never in practice; the `Result` keeps the engine signature uniform.
pub fn candidate_pairs(r: &Extended) -> Result<Vec<Value>, EngineError> {
    let mut out: Vec<Value> = Vec::new();
    for (mod_a, mod_b, fields_a, fields_b) in SPECS {
        let right: Vec<(String, LinkKeys, HashSet<String>)> = first(r.get(mod_b))
            .iter()
            .map(|y| {
                (
                    record_id(y),
                    link_keys(y),
                    terms_of(&joined(y, fields_b)).into_iter().collect(),
                )
            })
            .collect();
        for x in first(r.get(mod_a)) {
            let keys = link_keys(x);
            let left = terms_of(&joined(x, fields_a));
            for (other_id, other_keys, other_terms) in &right {
                let link = link_between(&keys, other_keys);
                let mut shared: Vec<&String> =
                    left.iter().filter(|t| other_terms.contains(*t)).collect();
                if link.is_none() && shared.len() < 2 {
                    continue;
                }
                // ASCII terms: byte order is UTF-16 code unit order.
                shared.sort();
                shared.truncate(8);
                let mut pair = Map::new();
                pair.insert("origen".into(), Value::from(format!("{mod_a}/{}", keys.id)));
                pair.insert("destino".into(), Value::from(format!("{mod_b}/{other_id}")));
                pair.insert(
                    "criterio".into(),
                    Value::from(link.map_or(LEXICAL, |(criterion, _)| criterion)),
                );
                pair.insert(
                    "terminos_compartidos".into(),
                    Value::Array(
                        shared
                            .into_iter()
                            .map(|t| Value::from(t.as_str()))
                            .collect(),
                    ),
                );
                pair.insert("estado".into(), Value::from(ESTADO));
                pair.insert("uso_sugerido".into(), Value::from(USO_SUGERIDO));
                out.push(Value::Object(pair));
                // Only the first MAX_PAIRS are returned, so later pairs cannot change the result.
                if out.len() == MAX_PAIRS {
                    return Ok(out);
                }
            }
        }
    }
    Ok(out)
}

/// Engine entry: `candidatePairs(extendedRecords(request.records ?? {}))`.
///
/// # Errors
/// `InvalidInput` when `records` is not a `RecordsByModule` object.
pub fn run(request: &Map<String, Value>) -> Result<Value, EngineError> {
    let records = extended_records(&records_field(request))?;
    Ok(Value::Array(candidate_pairs(&records)?))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn request(v: &Value) -> Map<String, Value> {
        v.as_object().cloned().unwrap_or_default()
    }

    fn code(v: &Value) -> &'static str {
        run(&request(v)).err().map_or("ok", |e| e.code())
    }

    #[test]
    fn invalid_shapes_are_invalid_input() {
        assert_eq!(code(&json!({"records": []})), "invalid_input");
        assert_eq!(code(&json!({"records": "x"})), "invalid_input");
        assert_eq!(
            code(&json!({"records": {"Intereses": {}}})),
            "invalid_input"
        );
        assert_eq!(
            code(&json!({"records": {"Dialogos": [{"id": 1, "payload": {}}]}})),
            "invalid_input"
        );
        assert_eq!(
            code(&json!({"records": {"Hechos_Compartidos": [{"id": "H", "payload": []}]}})),
            "invalid_input"
        );
        assert_eq!(
            code(&json!({"records": {"Intereses": [null]}})),
            "invalid_input"
        );
        // Modules the engine does not read are not validated, as in TypeScript.
        assert_eq!(code(&json!({"records": {"Actores": "x"}})), "ok");
    }

    #[test]
    fn thematic_terms_follow_the_typescript_helper() {
        assert_eq!(
            thematic_terms(Some(&json!("Educación ﬁscal PARA agua agua rio"))),
            vec!["educacion", "fiscal", "agua"]
        );
        assert!(thematic_terms(Some(&json!(false))).is_empty());
        assert!(thematic_terms(None).is_empty());
        assert_eq!(thematic_terms(Some(&json!(true))), vec!["true"]);
    }

    #[test]
    fn record_links_report_the_criterion() {
        let rec = |v: Value| -> Record { v.as_object().cloned().unwrap_or_default() };
        let a = rec(json!({"_id": "A", "Tema_ID": " T-1 "}));
        let b = rec(json!({"_id": "B", "Tema_ID": "t-1"}));
        assert_eq!(
            record_links(&a, &b),
            json!(["referencia explícita", ["Tema_ID"]])
        );
        let c = rec(json!({"_id": "C", "Referencias_ID": "A"}));
        assert_eq!(record_links(&a, &c), json!(["referencia cruzada", []]));
        assert_eq!(record_links(&b, &c), Value::Null);
    }
}
