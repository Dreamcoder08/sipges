//! Parity with the TypeScript engine: every case of `engines/fixtures/consensus.json` (generated
//! by `engines/fixtures/consensus.ts`) must produce the same `JSON.stringify` bytes.

#![allow(clippy::panic)] // a test harness reports fixture problems by panicking

use serde_json::{Map, Value};
use sipges_analytics_common::js;
use sipges_consensus::run;

fn fixtures() -> Value {
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../../fixtures/consensus.json");
    let text = std::fs::read_to_string(path).unwrap_or_else(|e| panic!("read {path}: {e}"));
    serde_json::from_str(&text).unwrap_or_else(|e| panic!("parse {path}: {e}"))
}

fn str_of<'a>(v: &'a Value, key: &str) -> &'a str {
    v.get(key)
        .and_then(Value::as_str)
        .unwrap_or_else(|| panic!("fixture field {key} must be a string"))
}

#[test]
fn every_case_matches_the_typescript_engine_byte_for_byte() {
    let fixtures = fixtures();
    let cases = fixtures
        .get("cases")
        .and_then(Value::as_array)
        .unwrap_or_else(|| panic!("fixture field cases must be an array"));
    assert!(cases.len() >= 25, "expected the full fixture set");
    let mut failures = Vec::new();
    for case in cases {
        let name = str_of(case, "name");
        let expected = str_of(case, "value");
        let request: Map<String, Value> = serde_json::from_str(str_of(case, "request"))
            .unwrap_or_else(|e| panic!("{name}: request is not an object: {e}"));
        let actual = match run(&request) {
            Ok(value) => js::stringify(&value),
            Err(e) => format!("error {e}"),
        };
        if actual != expected {
            let at = actual
                .bytes()
                .zip(expected.bytes())
                .position(|(a, b)| a != b)
                .unwrap_or(actual.len().min(expected.len()));
            let from = at.saturating_sub(80);
            failures.push(format!(
                "{name} differs at byte {at}:\n  rust: {}\n  ts:   {}",
                actual.get(from..(at + 80).min(actual.len())).unwrap_or(""),
                expected
                    .get(from..(at + 80).min(expected.len()))
                    .unwrap_or(""),
            ));
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}
