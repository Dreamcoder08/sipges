//! JavaScript semantics the TypeScript engine relies on: `String(number)`, `JSON.stringify`,
//! property enumeration order, `String.prototype.trim` and truthiness.

use serde_json::{Map, Value};
use std::fmt::Write as _;

/// ECMAScript `Number::toString(x)` (radix 10): shortest round-trip digits, JavaScript layout.
#[must_use]
pub fn number_to_string(x: f64) -> String {
    if x.is_nan() {
        return "NaN".to_owned();
    }
    if x == 0.0 {
        return "0".to_owned();
    }
    if x.is_infinite() {
        return if x > 0.0 { "Infinity" } else { "-Infinity" }.to_owned();
    }
    let sign = if x < 0.0 { "-" } else { "" };
    let (digits, n) = shortest_digits(x.abs());
    let k = i64::try_from(digits.len()).unwrap_or(i64::MAX);
    let body = if k <= n && n <= 21 {
        format!(
            "{digits}{}",
            "0".repeat(usize::try_from(n - k).unwrap_or(0))
        )
    } else if 0 < n && n <= 21 {
        let (int, frac) = digits.split_at(usize::try_from(n).unwrap_or(0));
        format!("{int}.{frac}")
    } else if -6 < n && n <= 0 {
        format!("0.{}{digits}", "0".repeat(usize::try_from(-n).unwrap_or(0)))
    } else {
        let e = n - 1;
        let e_sign = if e >= 0 { '+' } else { '-' };
        let (first, rest) = digits.split_at(1.min(digits.len()));
        if rest.is_empty() {
            format!("{first}e{e_sign}{}", e.abs())
        } else {
            format!("{first}.{rest}e{e_sign}{}", e.abs())
        }
    };
    format!("{sign}{body}")
}

/// Shortest round-trip digits `d` and position `n` with `x = 0.d × 10^n` (`x` finite, > 0).
///
/// Rust's `{:e}` already yields the shortest digits closest to `x`, but on an exact tie between
/// two candidates it rounds up, while ECMAScript `Number::toString` picks the even one
/// (1128632177133113.25 prints as `...113.2`). The tie is detected exactly and resolved here.
#[allow(clippy::many_single_char_names)] // k, n, p as in the ECMAScript algorithm
fn shortest_digits(x: f64) -> (String, i64) {
    let exp_form = format!("{x:e}");
    let (mantissa, exponent) = exp_form.split_once('e').unwrap_or((exp_form.as_str(), "0"));
    let mut digits: Vec<u8> = mantissa.bytes().filter(u8::is_ascii_digit).collect();
    let n = exponent.parse::<i64>().unwrap_or(0) + 1;
    let k = i64::try_from(digits.len()).unwrap_or(i64::MAX);
    let p = n - k; // x ≈ D × 10^p, D = digits as an integer
    let d: u128 = digits
        .iter()
        .fold(0, |acc, b| acc * 10 + u128::from(b - b'0'));
    if let Some(&last) = digits.last() {
        let last = last - b'0';
        // Only the last digit can move: a carry or borrow would leave a trailing zero, i.e. a
        // shorter candidate, which cannot round-trip because the digits are already shortest.
        for (alt, alt_last) in [(d.wrapping_sub(1), last.wrapping_sub(1)), (d + 1, last + 1)] {
            if !(1..=9).contains(&alt_last) || !alt_last.is_multiple_of(2) || last.is_multiple_of(2)
            {
                continue;
            }
            let round_trips = format!("{alt}e{p}")
                .parse::<f64>()
                .is_ok_and(|y| y.to_bits() == x.to_bits());
            if round_trips
                && is_midpoint(x, d.min(alt), p)
                && let Some(slot) = digits.last_mut()
            {
                *slot = b'0' + alt_last;
            }
        }
    }
    (String::from_utf8(digits).unwrap_or_default(), n)
}

/// Whether `x` is exactly `(2·low + 1) × 10^p / 2`, the midpoint of `low × 10^p` and
/// `(low + 1) × 10^p`. With `x = odd × 2^a` the identity reduces to integer equalities.
fn is_midpoint(x: f64, low: u128, p: i64) -> bool {
    let bits = x.to_bits();
    let biased = i64::try_from((bits >> 52) & 0x7ff).unwrap_or(0);
    let fraction = bits & ((1u64 << 52) - 1);
    let (mut m, mut e) = if biased == 0 {
        (fraction, -1074)
    } else {
        (fraction | (1 << 52), biased - 1075)
    };
    if m == 0 {
        return false;
    }
    let zeros = m.trailing_zeros();
    m >>= zeros;
    e += i64::from(zeros);
    // midpoint = (2·low + 1) × 5^p × 2^(p - 1); 2·low + 1 is odd, so are m and 5^|p|.
    if e != p - 1 {
        return false;
    }
    let odd = 2 * low + 1;
    let five = |q: i64| u32::try_from(q).ok().and_then(|q| 5u128.checked_pow(q));
    if p >= 0 {
        five(p).and_then(|f| odd.checked_mul(f)) == Some(u128::from(m))
    } else {
        five(-p).and_then(|f| u128::from(m).checked_mul(f)) == Some(odd)
    }
}

/// Whether `key` is an array index (`0` to `2^32 - 2` in canonical form): JavaScript enumerates
/// those keys first, in ascending numeric order, before the other keys in insertion order.
fn array_index(key: &str) -> Option<u32> {
    let bytes = key.as_bytes();
    if bytes.is_empty() || bytes.len() > 10 || !bytes.iter().all(u8::is_ascii_digit) {
        return None;
    }
    if bytes.len() > 1 && bytes.first() == Some(&b'0') {
        return None;
    }
    key.parse::<u64>()
        .ok()
        .filter(|&n| n < u64::from(u32::MAX))
        .and_then(|n| u32::try_from(n).ok())
}

/// Own enumerable properties in JavaScript order (`Object.entries`, `JSON.stringify`).
#[must_use]
pub fn entries(map: &Map<String, Value>) -> Vec<(&String, &Value)> {
    let mut indexed: Vec<(u32, &String, &Value)> = Vec::new();
    let mut named: Vec<(&String, &Value)> = Vec::with_capacity(map.len());
    for (key, value) in map {
        match array_index(key) {
            Some(i) => indexed.push((i, key, value)),
            None => named.push((key, value)),
        }
    }
    if indexed.is_empty() {
        return named;
    }
    indexed.sort_by_key(|&(i, _, _)| i);
    indexed
        .into_iter()
        .map(|(_, k, v)| (k, v))
        .chain(named)
        .collect()
}

/// `JSON.stringify(value)` without indentation.
#[must_use]
pub fn stringify(value: &Value) -> String {
    let mut out = String::new();
    write_json(&mut out, value);
    out
}

/// Appends `JSON.stringify(value)` to `out`.
pub fn write_json(out: &mut String, value: &Value) {
    match value {
        Value::Null => out.push_str("null"),
        Value::Bool(b) => out.push_str(if *b { "true" } else { "false" }),
        Value::Number(n) => match n.as_f64() {
            Some(x) if x.is_finite() => out.push_str(&number_to_string(x)),
            _ => out.push_str("null"),
        },
        Value::String(s) => write_string(out, s),
        Value::Array(items) => {
            out.push('[');
            for (i, item) in items.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                write_json(out, item);
            }
            out.push(']');
        }
        Value::Object(map) => {
            out.push('{');
            for (i, (key, item)) in entries(map).into_iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                write_string(out, key);
                out.push(':');
                write_json(out, item);
            }
            out.push('}');
        }
    }
}

/// ECMAScript `QuoteJSONString`.
fn write_string(out: &mut String, s: &str) {
    out.push('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\u{8}' => out.push_str("\\b"),
            '\u{c}' => out.push_str("\\f"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if u32::from(c) < 0x20 => {
                let _ = write!(out, "\\u{:04x}", u32::from(c));
            }
            c => out.push(c),
        }
    }
    out.push('"');
}

/// ECMAScript `WhiteSpace` and `LineTerminator` code points (what `trim` removes). Unlike Rust's
/// `char::is_whitespace` it includes U+FEFF and excludes U+0085.
#[must_use]
pub fn is_whitespace(c: char) -> bool {
    matches!(
        c,
        '\t' | '\n' | '\u{b}' | '\u{c}' | '\r' | ' ' | '\u{a0}' | '\u{1680}' | '\u{2000}'
            ..='\u{200a}'
                | '\u{2028}'
                | '\u{2029}'
                | '\u{202f}'
                | '\u{205f}'
                | '\u{3000}'
                | '\u{feff}'
    )
}

/// `String.prototype.trim`.
#[must_use]
pub fn trim(s: &str) -> &str {
    s.trim_matches(is_whitespace)
}

/// JavaScript truthiness (`if (value)`); `None` is `undefined`.
#[must_use]
pub fn truthy(value: Option<&Value>) -> bool {
    match value {
        None | Some(Value::Null) => false,
        Some(Value::Bool(b)) => *b,
        Some(Value::Number(n)) => n.as_f64().is_some_and(|x| x != 0.0 && !x.is_nan()),
        Some(Value::String(s)) => !s.is_empty(),
        Some(Value::Array(_) | Value::Object(_)) => true,
    }
}

/// A JSON number from an `f64`; non-finite values become `null`, as `JSON.stringify` writes them.
#[must_use]
pub fn number(x: f64) -> Value {
    serde_json::Number::from_f64(x).map_or(Value::Null, Value::Number)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn enumerates_array_indices_first() {
        let map: Map<String, Value> = serde_json::from_str(
            r#"{"b":1,"10":2,"a":3,"2":4,"01":5,"4294967295":6,"4294967294":7}"#,
        )
        .unwrap_or_default();
        let keys: Vec<&str> = entries(&map).into_iter().map(|(k, _)| k.as_str()).collect();
        assert_eq!(
            keys,
            ["2", "10", "4294967294", "b", "a", "01", "4294967295"]
        );
    }

    #[test]
    fn trims_like_javascript() {
        assert_eq!(trim("\u{feff}\u{a0} x \u{3000}"), "x");
        assert_eq!(trim("\u{85}x"), "\u{85}x");
    }

    #[test]
    fn escapes_like_json_stringify() {
        let v = Value::String("a\"\\\u{1}\u{7f}\u{2028}\n".to_owned());
        assert_eq!(stringify(&v), "\"a\\\"\\\\\\u0001\u{7f}\u{2028}\\n\"");
    }
}
