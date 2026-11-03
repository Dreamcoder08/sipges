//! JavaScript string semantics the engine relies on: `String(value)`, the unit-key `fold`, the
//! kernel's `normalizeSpanishStatus`, `\p{Mn}`, `\s` and UTF-16 lengths.

use serde_json::Value;
use sipges_analytics_common::js;
use unicode_normalization::UnicodeNormalization;

use crate::tables::MN;

/// Whether `c` is a `\p{Mn}` (non-spacing mark) code point.
#[must_use]
pub fn is_mn(c: char) -> bool {
    let cp = u32::from(c);
    MN.binary_search_by(|&(lo, hi)| {
        if hi < cp {
            std::cmp::Ordering::Less
        } else if lo > cp {
            std::cmp::Ordering::Greater
        } else {
            std::cmp::Ordering::Equal
        }
    })
    .is_ok()
}

/// `String(value)` for a JSON value (`None` is `undefined`, written `"undefined"`).
#[must_use]
pub fn to_js_string(value: Option<&Value>) -> String {
    match value {
        None => "undefined".to_owned(),
        Some(Value::Null) => "null".to_owned(),
        Some(Value::Bool(b)) => b.to_string(),
        Some(Value::Number(n)) => js::number_to_string(n.as_f64().unwrap_or(f64::NAN)),
        Some(Value::String(s)) => s.clone(),
        Some(Value::Object(_)) => "[object Object]".to_owned(),
        // Array.prototype.join: null and undefined elements are empty.
        Some(Value::Array(items)) => items
            .iter()
            .map(|item| match item {
                Value::Null => String::new(),
                other => to_js_string(Some(other)),
            })
            .collect::<Vec<_>>()
            .join(","),
    }
}

/// `.replace(/\s+/g, ' ')`.
fn collapse_whitespace(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut in_space = false;
    for c in s.chars() {
        if js::is_whitespace(c) {
            if !in_space {
                out.push(' ');
            }
            in_space = true;
        } else {
            out.push(c);
            in_space = false;
        }
    }
    out
}

/// `fold(value)`: `String(value ?? '').normalize('NFD').replace(/\p{Mn}/gu, '').toLowerCase()
/// .replace(/\s+/g, ' ').trim()`.
#[must_use]
pub fn fold_value(value: Option<&Value>) -> String {
    match value {
        None | Some(Value::Null) => String::new(),
        other => fold(&to_js_string(other)),
    }
}

/// [`fold_value`] of a string.
#[must_use]
pub fn fold(s: &str) -> String {
    let stripped: String = s.nfd().filter(|&c| !is_mn(c)).collect();
    js::trim(&collapse_whitespace(&stripped.to_lowercase())).to_owned()
}

/// `normalizeSpanishStatus` (`packages/kernel/src/calendar.ts`): strings only, NFD without
/// U+0300–U+036F, trimmed, lowercased, whitespace runs collapsed.
#[must_use]
pub fn normalize_spanish_status(value: Option<&Value>) -> String {
    let Some(Value::String(s)) = value else {
        return String::new();
    };
    let stripped: String = s
        .nfd()
        .filter(|&c| !('\u{300}'..='\u{36f}').contains(&c))
        .collect();
    collapse_whitespace(&js::trim(&stripped).to_lowercase())
}

/// `isTerminalStatus` (`packages/kernel/src/calendar.ts`).
#[must_use]
pub fn is_terminal_status(value: Option<&Value>) -> bool {
    const TERMINAL: [&str; 14] = [
        "cumplido",
        "cumplida",
        "completado",
        "completada",
        "cerrado",
        "cerrada",
        "atendido",
        "atendida",
        "resuelto",
        "resuelta",
        "finalizado",
        "finalizada",
        "cancelado",
        "cancelada",
    ];
    TERMINAL.contains(&normalize_spanish_status(value).as_str())
}

/// `String.prototype.length`: UTF-16 code units.
#[must_use]
pub fn utf16_len(s: &str) -> usize {
    s.chars().map(char::len_utf16).sum()
}

/// `s.slice(0, n)` in UTF-16 code units; `None` when the cut splits a surrogate pair (JavaScript
/// would keep a lone high surrogate, which a Rust string cannot hold).
#[must_use]
pub fn utf16_prefix(s: &str, n: usize) -> Option<&str> {
    let mut units = 0;
    for (at, c) in s.char_indices() {
        if units == n {
            return s.get(..at);
        }
        units += c.len_utf16();
        if units > n {
            return None;
        }
    }
    Some(s)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn folds_like_the_typescript_helper() {
        assert_eq!(fold("  San   José\tde Ñaña "), "san jose de nana");
        assert_eq!(fold("İstanbul"), "istanbul");
        assert_eq!(fold("ΣΟΦΟΣ"), "σοφο\u{3c2}");
        assert_eq!(
            fold_value(Some(&json!(["Alta", null, [1, 2]]))),
            "alta,,1,2"
        );
        assert_eq!(fold_value(Some(&json!({"a": 1}))), "[object object]");
        assert_eq!(fold_value(None), "");
    }

    #[test]
    fn terminal_statuses() {
        assert!(is_terminal_status(Some(&json!(" Atendído "))));
        assert!(is_terminal_status(Some(&json!("CANCELADA"))));
        assert!(!is_terminal_status(Some(&json!("Incumplido"))));
        assert!(!is_terminal_status(Some(&json!(["cerrado"]))));
    }

    #[test]
    fn utf16_slices() {
        assert_eq!(utf16_len("a😀"), 3);
        assert_eq!(utf16_prefix("a😀b", 3), Some("a😀"));
        assert_eq!(utf16_prefix("a😀b", 2), None);
        assert_eq!(utf16_prefix("ab", 5), Some("ab"));
    }
}
