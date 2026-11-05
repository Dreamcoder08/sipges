//! The part of the API configuration (`apps/api/src/platform/config.ts`) the tools read.
//!
//! The TypeScript tools call `loadConfig(process.env)`, which also validates settings they never
//! use; these tools check the database URL and the data key only (`SIPGES_DATA_KEY` is required
//! there, so a missing or malformed key fails both the same way).

use std::fmt;

/// A configuration error; Node reports it as a plain `Error`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ConfigError(pub String);

impl fmt::Display for ConfigError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for ConfigError {}

/// Decodes standard base64 as `/^[A-Za-z0-9+/]+={0,2}$/` then `Buffer.from(value, 'base64')`.
///
/// Node's decoder ignores leftover bits of a final partial group; so does this one.
#[must_use]
pub fn decode_base64(value: &str) -> Option<Vec<u8>> {
    let body = value.trim_end_matches('=');
    if body.is_empty() || value.len() - body.len() > 2 {
        return None;
    }
    let mut out = Vec::with_capacity(body.len() * 3 / 4);
    let mut buffer: u32 = 0;
    let mut bits = 0;
    for byte in body.bytes() {
        let sextet = match byte {
            b'A'..=b'Z' => byte - b'A',
            b'a'..=b'z' => byte - b'a' + 26,
            b'0'..=b'9' => byte - b'0' + 52,
            b'+' => 62,
            b'/' => 63,
            _ => return None,
        };
        buffer = (buffer << 6) | u32::from(sextet);
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push(u8::try_from((buffer >> bits) & 0xFF).unwrap_or(0));
        }
    }
    Some(out)
}

/// `decodeDataKey`: base64 of exactly 32 bytes.
///
/// # Errors
/// `<name> must decode to 32 bytes`.
pub fn decode_data_key(name: &str, value: &str) -> Result<[u8; 32], ConfigError> {
    decode_base64(value)
        .and_then(|bytes| <[u8; 32]>::try_from(bytes).ok())
        .ok_or_else(|| ConfigError(format!("{name} must decode to 32 bytes")))
}

/// `SIPGES_DATA_KEY`, required by `loadConfig`.
///
/// # Errors
/// Missing or not 32 bytes of base64.
pub fn data_key(env: &dyn Fn(&str) -> Option<String>) -> Result<[u8; 32], ConfigError> {
    let value = env("SIPGES_DATA_KEY")
        .ok_or_else(|| ConfigError("SIPGES_DATA_KEY is required (base64, 32 bytes)".into()))?;
    decode_data_key("SIPGES_DATA_KEY", &value)
}

/// `SIPGES_DATABASE_URL` (an empty value counts as unset).
///
/// # Errors
/// Unset: the TypeScript tools fall back to embedded `PGlite`, which the Rust tools do not
/// support.
pub fn database_url(env: &dyn Fn(&str) -> Option<String>) -> Result<String, ConfigError> {
    match env("SIPGES_DATABASE_URL") {
        Some(url) if !url.is_empty() => Ok(url),
        _ => Err(ConfigError(
            "SIPGES_DATABASE_URL is required: the Rust tools do not support embedded PGlite".into(),
        )),
    }
}

/// Reads the process environment; bytes that are not UTF-8 become U+FFFD, as in `process.env`.
#[must_use]
pub fn process_env(name: &str) -> Option<String> {
    std::env::var_os(name).map(|value| value.to_string_lossy().into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decodes_like_node() {
        assert_eq!(decode_base64("AAEC"), Some(vec![0, 1, 2]));
        assert_eq!(decode_base64("AAE="), Some(vec![0, 1]));
        assert_eq!(decode_base64("AA=="), Some(vec![0]));
        assert_eq!(decode_base64("AA==="), None);
        assert_eq!(decode_base64("A-A"), None);
        assert_eq!(decode_base64(""), None);
        let key = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
        assert!(decode_data_key("K", key).is_ok());
        assert!(decode_data_key("K", "AAAA").is_err());
    }
}
