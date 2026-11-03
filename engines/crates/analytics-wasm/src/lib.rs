//! WebAssembly ABI of the SIPGES analytics engines (engines/README.md): `alloc`, `compute`,
//! `dealloc`, JSON in and JSON out. `op` selects the engine: `situational`, `strategic`,
//! `consensus`, `candidate_links`, `integrated`, `conflict_risk`, or the text-analysis operations
//! `text_analysis`, `classify_record`, `text_cosine` and `public_http_url`.

use std::alloc::{Layout, alloc as raw_alloc, dealloc as raw_dealloc};
use std::ptr::NonNull;

use serde_json::{Map, Value};
use sipges_analytics_common::{EngineError, js};

/// Operations accepted in the request's `op` field.
pub const OPERATIONS: [&str; 10] = [
    "situational",
    "strategic",
    "consensus",
    "candidate_links",
    "integrated",
    "conflict_risk",
    "text_analysis",
    "classify_record",
    "text_cosine",
    "public_http_url",
];

fn dispatch(input: &[u8]) -> Result<Value, EngineError> {
    let request: Value = serde_json::from_slice(input)
        .map_err(|e| EngineError::InvalidRequest(format!("request is not valid JSON: {e}")))?;
    let Value::Object(request) = request else {
        return Err(EngineError::InvalidRequest(
            "request must be a JSON object".into(),
        ));
    };
    let Some(Value::String(op)) = request.get("op") else {
        return Err(EngineError::InvalidRequest("op must be a string".into()));
    };
    match op.as_str() {
        "situational" => sipges_situational::run(&request),
        "strategic" => sipges_strategic::run(&request),
        "consensus" => sipges_consensus::run(&request),
        "candidate_links" => sipges_candidate_links::run(&request),
        "integrated" => sipges_integrated::run(&request),
        "conflict_risk" => sipges_conflict_risk::run(&request),
        "text_analysis" => sipges_text_analysis::text_analysis(&request),
        "classify_record" => sipges_text_analysis::classify_record(&request),
        "text_cosine" => sipges_text_analysis::text_cosine(&request),
        "public_http_url" => sipges_text_analysis::public_http_url(&request),
        other => Err(EngineError::InvalidRequest(format!(
            "unknown op {other:?}; expected one of {}",
            OPERATIONS.join(", ")
        ))),
    }
}

/// Runs one request and returns the response as `JSON.stringify` writes it:
/// `{"ok":true,"value":...}` or `{"ok":false,"error":{"code":...,"message":...}}`. Never panics.
#[must_use]
pub fn respond(input: &[u8]) -> Vec<u8> {
    let mut envelope = Map::new();
    match dispatch(input) {
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

fn layout(len: usize) -> Option<Layout> {
    Layout::array::<u8>(len).ok()
}

/// Reserves `len` bytes in linear memory and returns their offset (`0` on failure). A zero-length
/// request returns a dangling, aligned, non-null offset that must not be read.
#[unsafe(no_mangle)]
pub extern "C" fn alloc(len: usize) -> *mut u8 {
    if len == 0 {
        return NonNull::<u8>::dangling().as_ptr();
    }
    match layout(len) {
        // SAFETY: the layout has a non-zero size.
        Some(layout) => unsafe { raw_alloc(layout) },
        None => std::ptr::null_mut(),
    }
}

/// Frees `len` bytes at `ptr`, previously returned by [`alloc`] or [`compute`].
///
/// # Safety
/// `ptr` and `len` must come from one earlier `alloc(len)` or `compute` response that was not
/// freed yet.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn dealloc(ptr: *mut u8, len: usize) {
    if len == 0 || ptr.is_null() {
        return;
    }
    if let Some(layout) = layout(len) {
        // SAFETY: guaranteed by the caller: `ptr` was allocated with this exact layout.
        unsafe { raw_dealloc(ptr, layout) };
    }
}

/// Runs the JSON request at `ptr..ptr+len` and returns `(out_ptr << 32) | out_len`; the host
/// reads the response and frees it with `dealloc(out_ptr, out_len)`.
///
/// # Safety
/// `ptr..ptr+len` must be initialised memory the module owns (normally a buffer from [`alloc`]
/// the host wrote the request into).
#[unsafe(no_mangle)]
pub unsafe extern "C" fn compute(ptr: *const u8, len: usize) -> u64 {
    let input: &[u8] = if len == 0 || ptr.is_null() {
        &[]
    } else {
        // SAFETY: guaranteed by the caller; the slice does not outlive this call.
        unsafe { std::slice::from_raw_parts(ptr, len) }
    };
    let output = respond(input).into_boxed_slice();
    let out_len = output.len();
    // The boxed slice was allocated with `Layout::array::<u8>(out_len)`, which `dealloc` rebuilds.
    let out_ptr = Box::into_raw(output).cast::<u8>();
    pack(out_ptr as usize, out_len)
}

/// `(ptr << 32) | len`; both fit in 32 bits on wasm32.
fn pack(ptr: usize, len: usize) -> u64 {
    let ptr = u64::try_from(ptr).unwrap_or(0) & 0xffff_ffff;
    let len = u64::try_from(len).unwrap_or(0) & 0xffff_ffff;
    (ptr << 32) | len
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn allocates_writes_and_frees_a_buffer() {
        let request = br#"{"op":"strategic"}"#;
        let ptr = alloc(request.len());
        assert!(!ptr.is_null());
        // SAFETY: `ptr` holds `request.len()` writable bytes from `alloc`.
        unsafe { std::ptr::copy_nonoverlapping(request.as_ptr(), ptr, request.len()) };
        // SAFETY: the bytes were initialised above and are freed only after this read.
        let written = unsafe { std::slice::from_raw_parts(ptr, request.len()) };
        assert_eq!(written, request);
        // SAFETY: freeing the buffer `alloc` returned, once.
        unsafe { dealloc(ptr, request.len()) };
        assert!(!alloc(0).is_null());
    }

    #[test]
    fn rejects_malformed_requests_with_typed_errors() {
        let code = |input: &str| {
            let out: Value = serde_json::from_slice(&respond(input.as_bytes())).unwrap_or_default();
            out.pointer("/error/code")
                .and_then(Value::as_str)
                .unwrap_or("ok")
                .to_owned()
        };
        assert_eq!(code(""), "invalid_request");
        assert_eq!(code("[1]"), "invalid_request");
        assert_eq!(code(r#"{"op":"nope"}"#), "invalid_request");
        assert_eq!(
            code(r#"{"op":"strategic","project_id":1}"#),
            "invalid_input"
        );
        assert_eq!(
            code(r#"{"op":"strategic","project_id":"p","generated_at":"t"}"#),
            "ok"
        );
    }

    #[test]
    fn packs_offset_and_length() {
        assert_eq!(pack(0x10, 0x20), 0x0000_0010_0000_0020);
        assert_eq!(pack(0xffff_fff0, 7), 0xffff_fff0_0000_0007);
    }
}
