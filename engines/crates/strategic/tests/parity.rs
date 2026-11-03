//! Byte parity with the TypeScript engine on the fixtures of `engines/fixtures/strategic.ts`.

use serde_json::{Map, Value, json};
use sipges_analytics_common::js;
use sipges_strategic::run;

fn fixtures() -> Vec<Value> {
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../../fixtures/strategic.json");
    let text = std::fs::read_to_string(path).unwrap_or_default();
    let parsed: Value = serde_json::from_str(&text).unwrap_or(Value::Null);
    match parsed.get("cases") {
        Some(Value::Array(cases)) => cases.clone(),
        _ => Vec::new(),
    }
}

#[test]
fn matches_the_typescript_engine_byte_for_byte() {
    let cases = fixtures();
    assert!(cases.len() >= 20, "fixtures missing: {}", cases.len());
    let mut failures = Vec::new();
    for case in &cases {
        let name = case.get("name").and_then(Value::as_str).unwrap_or("?");
        let request = case.get("request").and_then(Value::as_str).unwrap_or("");
        let expected = case.get("value").and_then(Value::as_str).unwrap_or("");
        let parsed: Map<String, Value> = serde_json::from_str(request).unwrap_or_default();
        match run(&parsed) {
            Ok(value) if js::stringify(&value) == expected => {}
            Ok(value) => failures.push(format!("{name}: got {}", js::stringify(&value))),
            Err(e) => failures.push(format!("{name}: error {e:?}")),
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}

fn code(request: &Value) -> Option<String> {
    let Value::Object(map) = request else {
        return None;
    };
    run(map).err().map(|e| e.code().to_owned())
}

#[test]
fn rejects_invalid_shapes() {
    let ok = |records: Value| json!({"records": records, "project_id": "P", "generated_at": "G"});
    let invalid = Some("invalid_input".to_owned());
    assert_eq!(code(&json!({"project_id": "P"})), invalid);
    assert_eq!(
        code(&json!({"project_id": 1, "generated_at": "G"})),
        invalid
    );
    assert_eq!(code(&json!({"generated_at": "G"})), invalid);
    assert_eq!(code(&ok(json!([]))), invalid);
    assert_eq!(code(&ok(json!("x"))), invalid);
    assert_eq!(code(&ok(json!({"Dialogos": {}}))), invalid);
    assert_eq!(
        code(&ok(json!({"Dialogos": [{"id": 1, "payload": {}}]}))),
        invalid
    );
    assert_eq!(
        code(&ok(
            json!({"Hechos_Compartidos": [{"id": "H", "payload": []}]})
        )),
        invalid
    );
    assert_eq!(
        code(&ok(json!({"Evaluaciones_AARC": [{"id": "A"}]}))),
        invalid
    );
    assert_eq!(code(&ok(json!({"Dialogos": [1]}))), invalid);
    assert_eq!(code(&ok(json!({"Eventos": "ignored"}))), None);
}
