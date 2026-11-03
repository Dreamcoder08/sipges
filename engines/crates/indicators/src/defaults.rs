//! Embedded defaults (`INDICATOR_CONFIG`, `DEFAULT_IRSA_CONFIG`), generated from the TypeScript
//! engine by engines/fixtures/generate.ts into defaults.json.

use crate::error::EngineError;
use serde_json::Value;
use std::sync::OnceLock;

const DEFAULTS_JSON: &str = include_str!("defaults.json");

/// `{"indicator_config": ..., "irsa_config": ...}`.
///
/// # Errors
/// Only if the embedded JSON were corrupt, which the unit tests rule out.
pub fn defaults() -> Result<&'static Value, EngineError> {
    static DEFAULTS: OnceLock<Option<Value>> = OnceLock::new();
    DEFAULTS
        .get_or_init(|| serde_json::from_str(DEFAULTS_JSON).ok())
        .as_ref()
        .ok_or_else(|| EngineError::UnsupportedValue("embedded defaults are not valid JSON".into()))
}

/// One embedded default by key.
///
/// # Errors
/// As [`defaults`].
pub fn default_of(key: &str) -> Result<&'static Value, EngineError> {
    defaults()?
        .get(key)
        .ok_or_else(|| EngineError::UnsupportedValue(format!("embedded default {key} is missing")))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn embedded_defaults_parse() {
        assert!(default_of("indicator_config").is_ok_and(Value::is_object));
        assert!(default_of("irsa_config").is_ok_and(Value::is_object));
    }
}
