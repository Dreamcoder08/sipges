//! Text analysis and record classifier engines: ports of
//! `apps/api/src/contexts/intelligence/domain/text-analysis.ts` (`analyzeText`, `cosine`,
//! `isPublicHttpUrl`) and `classifier.ts` (`classifyRecord`), with the helpers of `python.ts`.
//! Each entry's value, written with `js::stringify`, equals `JSON.stringify` of the TypeScript
//! result byte for byte (`engines/fixtures/text-analysis.json`).
//!
//! JavaScript string semantics are kept: `trim` removes the ECMAScript white space set,
//! `toLowerCase` is Rust's full mapping (final sigma included), `normalize` comes from
//! `unicode-normalization`, and the `\p{Mn}`, `\p{L}` and `\p{N}` classes of the Unicode regular
//! expressions come from tables generated with the JavaScript engine (`unicode-tables.ts`).
//! Lengths and the evidence fragment count code points (`Array.from`), as the TypeScript does.
//!
//! | Entry | Request | Value |
//! | --- | --- | --- |
//! | [`text_analysis`] | `{text: string, project_id: string, source_url: string, narratives?: object[] \| null}` | `analyzeText` envelope: `{"ok":true,"value":report}` or `{"ok":false,"error":{"kind":"empty"\|"too_long"}}` |
//! | [`classify_record`] | `{payload: any JSON}` | `classifyRecord(payload)` |
//! | [`text_cosine`] | `{a: number[], b: number[]}` | `cosine(a, b)` (a non-finite result is `null`) |
//! | [`public_http_url`] | `{url: string}` | `isPublicHttpUrl(url)` (boolean) |
//!
//! `evidence.sha256` of the report is the SHA-256 of the trimmed text's UTF-8 bytes as
//! lowercase hex, the digest the API passes to `analyzeText`.

mod classifier;
mod python;
mod sha256;
mod text;
mod unicode_tables;

use serde_json::{Map, Value};
pub use sipges_analytics_common::EngineError;
/// Unicode version of the generated `\p{Mn}`, `\p{L}` and `\p{N}` tables.
pub use unicode_tables::UNICODE_VERSION;

fn str_field<'a>(request: &'a Map<String, Value>, key: &str) -> Result<&'a str, EngineError> {
    request
        .get(key)
        .and_then(Value::as_str)
        .ok_or_else(|| EngineError::input(format!("{key} must be a string")))
}

fn numbers(request: &Map<String, Value>, key: &str) -> Result<Vec<f64>, EngineError> {
    let message = || EngineError::input(format!("{key} must be an array of numbers"));
    request
        .get(key)
        .and_then(Value::as_array)
        .ok_or_else(message)?
        .iter()
        .map(|v| v.as_f64().ok_or_else(message))
        .collect()
}

/// `analyzeText({text, projectId, sourceUrl}, narratives, sha256)`.
///
/// # Errors
/// `InvalidInput` when `text`, `project_id` or `source_url` is not a string, or `narratives` is
/// present, not `null`, and not an array of objects. Empty and too long texts are values.
pub fn text_analysis(request: &Map<String, Value>) -> Result<Value, EngineError> {
    let text = str_field(request, "text")?;
    let project_id = str_field(request, "project_id")?;
    let source_url = str_field(request, "source_url")?;
    let narratives = match request.get("narratives") {
        None | Some(Value::Null) => Vec::new(),
        Some(Value::Array(items)) => items
            .iter()
            .map(|item| {
                item.as_object()
                    .ok_or_else(|| EngineError::input("narratives must be objects"))
            })
            .collect::<Result<Vec<_>, _>>()?,
        Some(_) => return Err(EngineError::input("narratives must be an array")),
    };
    Ok(text::analyze_text(
        text,
        project_id,
        source_url,
        &narratives,
    ))
}

/// `classifyRecord(payload)`.
///
/// # Errors
/// `InvalidInput` when `payload` is absent; any JSON value is classified.
pub fn classify_record(request: &Map<String, Value>) -> Result<Value, EngineError> {
    let payload = request
        .get("payload")
        .ok_or_else(|| EngineError::input("payload is required"))?;
    Ok(classifier::classify(payload))
}

/// `cosine(a, b)`.
///
/// # Errors
/// `InvalidInput` when `a` or `b` is not an array of numbers.
pub fn text_cosine(request: &Map<String, Value>) -> Result<Value, EngineError> {
    let a = numbers(request, "a")?;
    let b = numbers(request, "b")?;
    Ok(sipges_analytics_common::js::number(text::cosine(&a, &b)))
}

/// `isPublicHttpUrl(url)`.
///
/// # Errors
/// `InvalidInput` when `url` is not a string.
pub fn public_http_url(request: &Map<String, Value>) -> Result<Value, EngineError> {
    Ok(Value::Bool(text::is_public_http_url(str_field(
        request, "url",
    )?)))
}
