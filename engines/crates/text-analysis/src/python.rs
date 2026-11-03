//! The helpers of `apps/api/src/contexts/intelligence/domain/python.ts` the two engines use, with
//! JavaScript string semantics. `pyStr` and `pyTruthy` equal the analytics versions and are
//! reused from `sipges-analytics-common`.

use std::fmt::Write as _;

use serde_json::Value;
use sipges_analytics_common::js;
use unicode_normalization::UnicodeNormalization;

use crate::unicode_tables::{L, MN, N};

/// Whether `c` lies in one of the sorted inclusive `ranges`.
fn in_table(ranges: &[(u32, u32)], c: char) -> bool {
    let cp = u32::from(c);
    ranges
        .binary_search_by(|&(lo, hi)| {
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

/// `/\p{Mn}/u`.
fn is_nonspacing_mark(c: char) -> bool {
    in_table(&MN, c)
}

/// `[\p{L}\p{N}_]` (with the `u` flag: whole code points, Unicode categories).
fn is_word_char(c: char) -> bool {
    c == '_' || in_table(&L, c) || in_table(&N, c)
}

/// The normalization form of [`fold_marks`].
#[derive(Clone, Copy)]
pub enum Form {
    /// `normalize('NFKD')`.
    Nfkd,
    /// `normalize('NFD')`.
    Nfd,
}

/// `foldMarks(text, form)`: `text.toLowerCase().normalize(form).replace(/\p{Mn}/gu, '')`.
#[must_use]
pub fn fold_marks(text: &str, form: Form) -> String {
    // `str::to_lowercase` applies the same full, locale-independent mapping as
    // `String.prototype.toLowerCase`, including the final-sigma rule.
    let lower = text.to_lowercase();
    match form {
        Form::Nfkd => lower.nfkd().filter(|&c| !is_nonspacing_mark(c)).collect(),
        Form::Nfd => lower.nfd().filter(|&c| !is_nonspacing_mark(c)).collect(),
    }
}

/// `hasWholeWord(text, word)`: `word` occurs with no letter, number or `_` code point right
/// before or after it. Every occurrence is tried, overlapping ones included, as the regular
/// expression search does.
#[must_use]
pub fn has_whole_word(text: &str, word: &str) -> bool {
    let mut from = 0;
    while let Some(i) = text.get(from..).and_then(|rest| rest.find(word)) {
        let start = from + i;
        let before = text.get(..start).and_then(|t| t.chars().next_back());
        let after = text
            .get(start + word.len()..)
            .and_then(|t| t.chars().next());
        if !before.is_some_and(is_word_char) && !after.is_some_and(is_word_char) {
            return true;
        }
        let step = text
            .get(start..)
            .and_then(|t| t.chars().next())
            .map_or(1, char::len_utf8);
        from = start + step;
    }
    false
}

/// `sliceCodePoints(text, count)`.
#[must_use]
pub fn slice_code_points(text: &str, count: usize) -> &str {
    let end = text
        .char_indices()
        .nth(count)
        .map_or(text.len(), |(i, _)| i);
    text.get(..end).unwrap_or(text)
}

/// `escapeJsonString`: `json.dumps` escapes `"`, `\` and every C0 control character.
fn write_py_string(out: &mut String, text: &str) {
    out.push('"');
    for c in text.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            '\u{8}' => out.push_str("\\b"),
            '\u{c}' => out.push_str("\\f"),
            c if u32::from(c) < 0x20 => {
                let _ = write!(out, "\\u{:04x}", u32::from(c));
            }
            c => out.push(c),
        }
    }
    out.push('"');
}

fn write_py_json(out: &mut String, value: &Value) {
    match value {
        Value::Null => out.push_str("null"),
        Value::Bool(true) => out.push_str("true"),
        Value::Bool(false) => out.push_str("false"),
        Value::Number(n) => match n.as_f64() {
            Some(x) if x.is_finite() => out.push_str(&js::number_to_string(x)),
            _ => out.push_str("NaN"),
        },
        Value::String(s) => write_py_string(out, s),
        Value::Array(items) => {
            out.push('[');
            for (i, item) in items.iter().enumerate() {
                if i > 0 {
                    out.push_str(", ");
                }
                write_py_json(out, item);
            }
            out.push(']');
        }
        Value::Object(map) => {
            out.push('{');
            for (i, (key, item)) in js::entries(map).into_iter().enumerate() {
                if i > 0 {
                    out.push_str(", ");
                }
                write_py_string(out, key);
                out.push_str(": ");
                write_py_json(out, item);
            }
            out.push('}');
        }
    }
}

/// `pyJsonDumps(value)`: `json.dumps(value, ensure_ascii=False)` with `, ` and `: ` separators
/// and keys in JavaScript property order.
#[must_use]
pub fn py_json_dumps(value: &Value) -> String {
    let mut out = String::new();
    write_py_json(&mut out, value);
    out
}

/// `roundHalfEven(value, digits)` of `@sipges/kernel` (`pyRound`): scale by `10 ** digits`, then
/// an exact half goes to the even neighbor.
#[must_use]
pub fn round_half_even(value: f64, digits: i32) -> f64 {
    let factor = 10f64.powi(digits);
    let scaled = value * factor;
    let floor = scaled.floor();
    let diff = scaled - floor;
    let rounded = if diff > 0.5 {
        floor + 1.0
    } else if diff < 0.5 || floor % 2.0 == 0.0 {
        floor
    } else {
        floor + 1.0
    };
    rounded / factor
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn unicode_data_versions_agree() {
        assert_eq!(char::UNICODE_VERSION, (17, 0, 0));
        assert_eq!(unicode_normalization::UNICODE_VERSION, (17, 0, 0));
        assert_eq!(crate::unicode_tables::UNICODE_VERSION, "17.0");
    }

    #[test]
    fn folds_case_and_marks() {
        assert_eq!(fold_marks("ÑANDÚ Elección", Form::Nfkd), "nandu eleccion");
        assert_eq!(fold_marks("ﬁ ＡＧＵＡ", Form::Nfkd), "fi agua");
        assert_eq!(fold_marks("ﬁ", Form::Nfd), "ﬁ");
        assert_eq!(fold_marks("ΑΣ ΣΑ", Form::Nfkd), "ας σα");
        assert_eq!(fold_marks("İ", Form::Nfkd), "i");
    }

    #[test]
    fn whole_words_use_unicode_letters_and_numbers() {
        assert!(has_whole_word("(agua)", "agua"));
        assert!(!has_whole_word("aguas", "agua"));
        assert!(!has_whole_word("éagua", "agua"));
        assert!(!has_whole_word("agua_", "agua"));
        assert!(!has_whole_word("agua٣", "agua"));
        assert!(has_whole_word("aguas agua", "agua"));
        assert!(has_whole_word("agua😀", "agua"));
    }

    #[test]
    fn dumps_like_python() {
        assert_eq!(
            py_json_dumps(&json!({"a": [1, "ñ\"\n"], "b": null, "c": true})),
            r#"{"a": [1, "ñ\"\n"], "b": null, "c": true}"#
        );
        assert_eq!(
            py_json_dumps(&json!({"b": 1, "2": [], "1": {}})),
            r#"{"1": {}, "2": [], "b": 1}"#
        );
        assert_eq!(py_json_dumps(&json!("\u{1}\u{7f}")), "\"\\u0001\u{7f}\"");
    }

    #[test]
    fn rounds_halves_to_even() {
        let r: Vec<f64> = [0.5, 1.5, 2.5, 84.5]
            .iter()
            .map(|&x| round_half_even(x, 0))
            .collect();
        assert_eq!(r, [0.0, 2.0, 2.0, 84.0]);
        assert!((round_half_even(12.25, 1) - 12.2).abs() < f64::EPSILON);
    }

    #[test]
    fn slices_code_points() {
        assert_eq!(slice_code_points("a😀b", 2), "a😀");
        assert_eq!(slice_code_points("ab", 5), "ab");
    }
}
