//! Values as `node:sqlite` hands them to the mapping, and the coercions of `domain/mapping.ts`.

use std::rc::Rc;

use sipges_indicators::js::number_to_string;
use sipges_tools_common::js;

use crate::js_date;

/// A SQLite value: a JavaScript `number`, `string`, `Uint8Array` or `null`.
#[derive(Clone, Debug, PartialEq)]
pub enum Legacy {
    /// `NULL` or a column the row does not have.
    Null,
    /// An integer or a real.
    Num(f64),
    /// Text, with invalid UTF-8 already replaced by U+FFFD.
    Text(String),
    /// A blob.
    Blob(Vec<u8>),
}

/// One row of a `SELECT *`.
#[derive(Clone, Debug)]
pub struct Row {
    names: Rc<[String]>,
    values: Vec<Legacy>,
}

static NULL: Legacy = Legacy::Null;

impl Row {
    /// A row over shared column names.
    #[must_use]
    pub const fn new(names: Rc<[String]>, values: Vec<Legacy>) -> Self {
        Self { names, values }
    }

    /// `row[name]`; a missing column reads as `Null`, as `undefined` does through every `??`.
    #[must_use]
    pub fn get(&self, name: &str) -> &Legacy {
        self.names
            .iter()
            .position(|known| known == name)
            .and_then(|at| self.values.get(at))
            .unwrap_or(&NULL)
    }
}

/// `asText`.
#[must_use]
pub fn as_text(value: &Legacy) -> Option<String> {
    match value {
        Legacy::Null => None,
        Legacy::Num(x) => Some(number_to_string(*x)),
        Legacy::Text(text) => Some(text.clone()),
        Legacy::Blob(bytes) => Some(String::from_utf8_lossy(bytes).into_owned()),
    }
}

/// `textOr`.
#[must_use]
pub fn text_or(value: &Legacy, fallback: &str) -> String {
    as_text(value).unwrap_or_else(|| fallback.to_owned())
}

/// `String(value)` for a value that is not null: `Uint8Array` joins its bytes with commas.
#[must_use]
pub fn js_string(value: &Legacy) -> Option<String> {
    match value {
        Legacy::Blob(bytes) => Some(
            bytes
                .iter()
                .map(u8::to_string)
                .collect::<Vec<_>>()
                .join(","),
        ),
        other => as_text(other),
    }
}

/// Digits of a radix prefix; lengths past 128 bits accumulate in floating point.
#[allow(clippy::cast_precision_loss)]
fn radix_number(digits: &str, radix: u32) -> f64 {
    if digits.is_empty() {
        return f64::NAN;
    }
    if let Ok(exact) = u128::from_str_radix(digits, radix)
        && !digits.starts_with('+')
    {
        return exact as f64;
    }
    let mut value = 0.0;
    for c in digits.chars() {
        match c.to_digit(radix) {
            Some(digit) => value = value * f64::from(radix) + f64::from(digit),
            None => return f64::NAN,
        }
    }
    value
}

/// `Number(text)`.
#[must_use]
pub fn js_number(text: &str) -> f64 {
    let t = js::trim(text);
    if t.is_empty() {
        return 0.0;
    }
    for (prefix, radix) in [
        ("0x", 16),
        ("0X", 16),
        ("0o", 8),
        ("0O", 8),
        ("0b", 2),
        ("0B", 2),
    ] {
        if let Some(digits) = t.strip_prefix(prefix) {
            return radix_number(digits, radix);
        }
    }
    let unsigned = t.strip_prefix(['+', '-']).unwrap_or(t);
    if unsigned == "Infinity" {
        return if t.starts_with('-') {
            f64::NEG_INFINITY
        } else {
            f64::INFINITY
        };
    }
    // Rust also reads `inf` and `nan`: only a StrDecimalLiteral reaches its parser.
    let (mantissa, exponent) = match unsigned.find(['e', 'E']) {
        Some(at) => (unsigned.get(..at).unwrap_or(""), unsigned.get(at + 1..)),
        None => (unsigned, None),
    };
    let digits = |s: &str| s.bytes().all(|b| b.is_ascii_digit());
    let (whole, fraction) = mantissa.split_once('.').unwrap_or((mantissa, ""));
    let valid_exponent = exponent.is_none_or(|e| {
        let e = e.strip_prefix(['+', '-']).unwrap_or(e);
        !e.is_empty() && digits(e)
    });
    if !digits(whole)
        || !digits(fraction)
        || (whole.is_empty() && fraction.is_empty())
        || !valid_exponent
    {
        return f64::NAN;
    }
    t.parse::<f64>().unwrap_or(f64::NAN)
}

/// `asNumber`.
#[must_use]
pub fn as_number(value: &Legacy) -> Option<f64> {
    let number = match value {
        Legacy::Num(x) => *x,
        Legacy::Text(text) if !js::trim(text).is_empty() => js_number(text),
        _ => return None,
    };
    number.is_finite().then_some(number)
}

/// `asBoolean`.
#[must_use]
pub fn as_boolean(value: &Legacy) -> bool {
    if let Some(number) = as_number(value) {
        return number != 0.0;
    }
    matches!(as_text(value).as_deref(), Some("true" | "1"))
}

/// `value ?? fallback` before `asBoolean`.
#[must_use]
pub fn boolean_or(value: &Legacy, fallback: bool) -> bool {
    if *value == Legacy::Null {
        fallback
    } else {
        as_boolean(value)
    }
}

/// `/(?:Z|[+-]\d{2}:?\d{2})$/`.
fn ends_with_zone(text: &str) -> bool {
    let bytes = text.as_bytes();
    if bytes.last() == Some(&b'Z') {
        return true;
    }
    let tail = |n: usize| bytes.len().checked_sub(n).and_then(|at| bytes.get(at..));
    let shape = |slice: &[u8], colon: bool| {
        let Some((sign, rest)) = slice.split_first() else {
            return false;
        };
        if !matches!(sign, b'+' | b'-') {
            return false;
        }
        let mut digits = rest.iter().filter(|b| **b != b':');
        let all = digits.clone().count() == 4 && digits.all(u8::is_ascii_digit);
        all && rest.contains(&b':') == colon && (!colon || rest.get(2) == Some(&b':'))
    };
    tail(5).is_some_and(|slice| shape(slice, false))
        || tail(6).is_some_and(|slice| shape(slice, true))
}

/// `parseLegacyTimestamp`, in milliseconds since the epoch.
#[must_use]
pub fn parse_timestamp(value: &Legacy) -> Option<i64> {
    if let Legacy::Num(number) = value {
        return js_date::from_number(number * 1000.0);
    }
    parse_timestamp_text(as_text(value)?.as_str())
}

/// The text branch of `parseLegacyTimestamp`.
#[must_use]
pub fn parse_timestamp_text(text: &str) -> Option<i64> {
    let text = js::trim(text);
    if text.is_empty() {
        return None;
    }
    let spaced = text.replacen(' ', "T", 1);
    if ends_with_zone(text) {
        js_date::parse(&spaced)
    } else {
        js_date::parse(&format!("{spaced}Z"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn text(value: &str) -> Legacy {
        Legacy::Text(value.to_owned())
    }

    #[test]
    fn coerces_like_mapping_ts() {
        assert_eq!(as_text(&Legacy::Num(5.0)).as_deref(), Some("5"));
        assert_eq!(as_text(&Legacy::Num(-0.0)).as_deref(), Some("0"));
        assert_eq!(as_text(&Legacy::Num(1.5)).as_deref(), Some("1.5"));
        assert_eq!(
            as_text(&Legacy::Blob(vec![0x61, 0xff])).as_deref(),
            Some("a\u{fffd}")
        );
        assert_eq!(
            js_string(&Legacy::Blob(vec![97, 98])).as_deref(),
            Some("97,98")
        );
        assert_eq!(as_number(&text("  ")), None);
        assert_eq!(as_number(&text("0x10")), Some(16.0));
        assert_eq!(as_number(&Legacy::Blob(vec![0x35])), None);
        assert_eq!(as_number(&Legacy::Num(f64::INFINITY)), None);
        assert!(as_boolean(&text("true")));
        assert!(as_boolean(&Legacy::Blob(b"1".to_vec())));
        assert!(!as_boolean(&text("0")));
        assert!(!as_boolean(&text("no")));
        assert!(boolean_or(&Legacy::Null, true));
    }

    #[test]
    fn reads_numbers_like_number() {
        // Observed with Node: Number(text).
        for (input, expected) in [
            (" 12 ", 12.0),
            ("1e3", 1000.0),
            (".5", 0.5),
            ("5.", 5.0),
            ("+5", 5.0),
            ("-5", -5.0),
            ("0b11", 3.0),
            ("0o17", 15.0),
            ("0xff", 255.0),
            ("1e400", f64::INFINITY),
            ("-Infinity", f64::NEG_INFINITY),
        ] {
            assert_eq!(js_number(input).to_bits(), expected.to_bits(), "{input}");
        }
        for input in [
            "x", "1_000", "-0x10", "0x", "0b2", "inf", "nan", "NaN", "infinity", ".", "e5", "1e",
            "1e+", "+", "1 2",
        ] {
            assert!(js_number(input).is_nan(), "{input}");
        }
    }

    #[test]
    fn appends_z_unless_the_text_ends_in_a_zone() {
        for zone in ["2026Z", "x+05:30", "x-0300", "01-02-2026"] {
            assert!(ends_with_zone(zone), "{zone}");
        }
        for plain in [
            "2026", "x+5:30", "x+05:3", "x+053", "a:b0000", "+05:300", "z", "+",
        ] {
            assert!(!ends_with_zone(plain), "{plain}");
        }
    }

    #[test]
    fn parses_timestamps_like_new_date() {
        // Observed with Node: parseLegacyTimestamp(value)?.getTime().
        assert_eq!(
            parse_timestamp(&text("2026-10-01T09:00:00")),
            Some(1_790_845_200_000)
        );
        assert_eq!(
            parse_timestamp(&text("2026-10-01 09:00:00")),
            Some(1_790_845_200_000)
        );
        assert_eq!(
            parse_timestamp(&text("2026-10-01")),
            Some(1_790_812_800_000)
        );
        assert_eq!(parse_timestamp(&Legacy::Num(1.5)), Some(1500));
        assert_eq!(parse_timestamp(&Legacy::Num(9e300)), None);
        assert_eq!(parse_timestamp(&text("   ")), None);
        assert_eq!(parse_timestamp(&Legacy::Null), None);
        assert_eq!(parse_timestamp(&text("ayer")), None);
    }

    #[test]
    fn reads_missing_columns_as_null() {
        let row = Row::new(vec!["a".to_owned()].into(), vec![Legacy::Num(1.0)]);
        assert_eq!(row.get("a"), &Legacy::Num(1.0));
        assert_eq!(row.get("b"), &Legacy::Null);
    }
}
