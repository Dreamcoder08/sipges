//! JSON request/response ABI shared by every host (see engines/README.md).

use crate::defaults::{default_of, defaults};
use crate::error::EngineError;
use crate::indicators::compute_indicators;
use crate::irsa::{apply_irsa_config_patch, compute_irsa, select_band};
use crate::js;
use crate::records::{Records, RecordsSeed};
use serde::de::{self, DeserializeSeed, IgnoredAny, MapAccess, SeqAccess, Visitor};
use serde_json::{Map, Value};
use std::fmt;

/// Operations accepted in the request's `op` field.
pub const OPERATIONS: [&str; 5] = [
    "indicators",
    "irsa",
    "irsa_config_patch",
    "select_band",
    "defaults",
];

/// A request: `records` is parsed straight into rows (see `records`), every other field as JSON.
struct Request {
    records: Option<Records>,
    fields: Map<String, Value>,
}

/// Parses the request; `Ok(None)` when it is valid JSON but not an object.
struct RequestSeed;

impl<'de> DeserializeSeed<'de> for RequestSeed {
    type Value = Option<Request>;
    fn deserialize<D: de::Deserializer<'de>>(self, d: D) -> Result<Self::Value, D::Error> {
        d.deserialize_any(self)
    }
}

impl<'de> Visitor<'de> for RequestSeed {
    type Value = Option<Request>;
    fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("a JSON request")
    }
    fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Self::Value, A::Error> {
        let mut request = Request {
            records: None,
            fields: Map::new(),
        };
        while let Some(key) = map.next_key::<String>()? {
            if key == "records" {
                request.records = Some(map.next_value_seed(RecordsSeed)?);
            } else {
                request.fields.insert(key, map.next_value()?);
            }
        }
        Ok(Some(request))
    }
    fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> Result<Self::Value, A::Error> {
        while seq.next_element::<IgnoredAny>()?.is_some() {}
        Ok(None)
    }
    fn visit_unit<E: de::Error>(self) -> Result<Self::Value, E> {
        Ok(None)
    }
    fn visit_bool<E: de::Error>(self, _: bool) -> Result<Self::Value, E> {
        Ok(None)
    }
    fn visit_i64<E: de::Error>(self, _: i64) -> Result<Self::Value, E> {
        Ok(None)
    }
    fn visit_u64<E: de::Error>(self, _: u64) -> Result<Self::Value, E> {
        Ok(None)
    }
    fn visit_f64<E: de::Error>(self, _: f64) -> Result<Self::Value, E> {
        Ok(None)
    }
    fn visit_str<E: de::Error>(self, _: &str) -> Result<Self::Value, E> {
        Ok(None)
    }
}

fn parse(input: &[u8]) -> Result<Request, EngineError> {
    let invalid = |e: serde_json::Error| {
        EngineError::InvalidRequest(format!("request is not valid JSON: {e}"))
    };
    let mut de = serde_json::Deserializer::from_slice(input);
    let request = RequestSeed.deserialize(&mut de).map_err(invalid)?;
    de.end().map_err(invalid)?;
    request.ok_or_else(|| EngineError::InvalidRequest("request must be a JSON object".into()))
}

fn optional<'a>(
    request: &'a Map<String, Value>,
    key: &str,
    default_key: &str,
) -> Result<&'a Value, EngineError> {
    match request.get(key) {
        None | Some(Value::Null) => default_of(default_key),
        Some(v) => Ok(v),
    }
}

fn dispatch(parsed: &Request) -> Result<Value, EngineError> {
    let request = &parsed.fields;
    let op = match request.get("op") {
        Some(Value::String(op)) => op.as_str(),
        _ => return Err(EngineError::InvalidRequest("op must be a string".into())),
    };
    let records = || {
        parsed
            .records
            .as_ref()
            .ok_or_else(|| EngineError::input("records is required"))
    };
    match op {
        "indicators" => {
            compute_indicators(records()?, optional(request, "meta", "indicator_config")?)
        }
        "irsa" => {
            let config = optional(request, "config", "irsa_config")?;
            if let Some(report) = request.get("report") {
                compute_irsa(config, report)
            } else {
                let report =
                    compute_indicators(records()?, optional(request, "meta", "indicator_config")?)?;
                compute_irsa(config, &report)
            }
        }
        "irsa_config_patch" => {
            let patch = request
                .get("patch")
                .ok_or_else(|| EngineError::input("patch is required"))?;
            apply_irsa_config_patch(optional(request, "config", "irsa_config")?, patch)
        }
        "select_band" => {
            let Some(irsa) = request.get("irsa").and_then(Value::as_f64) else {
                return Err(EngineError::input("irsa must be a number"));
            };
            let thresholds = request.get("thresholds").unwrap_or(&Value::Null);
            select_band(irsa, thresholds).map(Value::String)
        }
        "defaults" => defaults().cloned(),
        other => Err(EngineError::InvalidRequest(format!(
            "unknown op {other:?}; expected one of {}",
            OPERATIONS.join(", ")
        ))),
    }
}

/// Runs one request (UTF-8 JSON) and returns the response as `JSON.stringify` would write it:
/// `{"ok":true,"value":...}` or `{"ok":false,"error":{"code":...,"message":...}}`. Never panics.
#[must_use]
pub fn compute(input: &[u8]) -> Vec<u8> {
    let result = parse(input).and_then(|request| dispatch(&request));
    let mut envelope = Map::new();
    match result {
        Ok(value) => {
            envelope.insert("ok".into(), Value::Bool(true));
            envelope.insert("value".into(), value);
        }
        Err(error) => {
            let mut detail = Map::new();
            detail.insert("code".into(), Value::String(error.code().into()));
            detail.insert("message".into(), Value::String(error.message().into()));
            envelope.insert("ok".into(), Value::Bool(false));
            envelope.insert("error".into(), Value::Object(detail));
        }
    }
    js::stringify(&Value::Object(envelope)).into_bytes()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn code(request: &str) -> String {
        let response: Value =
            serde_json::from_slice(&compute(request.as_bytes())).unwrap_or_default();
        response
            .pointer("/error/code")
            .and_then(Value::as_str)
            .unwrap_or("ok")
            .to_owned()
    }

    #[test]
    fn rejects_malformed_requests() {
        assert_eq!(code(""), "invalid_request");
        assert_eq!(code("{\"op\":"), "invalid_request");
        assert_eq!(code("{} trailing"), "invalid_request");
        assert_eq!(code("[1]"), "invalid_request");
        assert_eq!(code("{\"op\":1}"), "invalid_request");
        assert_eq!(code("{\"op\":\"nope\"}"), "invalid_request");
        assert_eq!(code("{\"op\":\"x\",\"s\":\"\\ud800\"}"), "invalid_request");
    }

    /// Values outside the TypeScript types are rejected instead of coerced (engines/README.md).
    #[test]
    fn rejects_untyped_values_instead_of_coercing() {
        assert_eq!(
            code(r#"{"op":"irsa_config_patch","patch":{"weights":{"G":"1"}}}"#),
            "invalid_input"
        );
        assert_eq!(
            code(r#"{"op":"select_band","irsa":1,"thresholds":{"V":["0",2]}}"#),
            "invalid_input"
        );
        assert_eq!(
            code(r#"{"op":"select_band","irsa":"1","thresholds":{}}"#),
            "invalid_input"
        );
        assert_eq!(
            code(r#"{"op":"indicators","records":null}"#),
            "invalid_input"
        );
        assert_eq!(code(r#"{"op":"indicators"}"#), "invalid_input");
        let empty = r#""Eventos":[],"Actores":[],"Demandas":[],"Compromisos":[],"Narrativas":[],"Alertas":[],"Acciones":[]"#;
        assert_eq!(
            code(&format!(
                r#"{{"op":"indicators","records":{{{empty},"Directorio_Territorial":[null]}}}}"#
            )),
            "invalid_input"
        );
        assert_eq!(
            code(&format!(
                r#"{{"op":"indicators","records":{{{empty},"Directorio_Territorial":{{}}}}}}"#
            )),
            "invalid_input"
        );
        assert_eq!(
            code(&format!(
                r#"{{"op":"indicators","records":{{{empty},"Directorio_Territorial":[1,"x",[]]}}}}"#
            )),
            "ok"
        );
    }
}
