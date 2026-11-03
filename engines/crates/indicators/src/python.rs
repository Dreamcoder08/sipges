//! Python semantics the indicator rules of app.py depend on (apps/api/src/contexts/indicators/domain/python.ts).

use crate::error::EngineError;
use crate::js;
use serde_json::Value;

/// Python truthiness for JSON values; `None` is a missing field.
#[must_use]
pub fn truthy(value: Option<&Value>) -> bool {
    match value {
        None | Some(Value::Null) => false,
        Some(Value::Bool(b)) => *b,
        Some(Value::Number(n)) => n.as_f64().is_some_and(|x| x != 0.0),
        Some(Value::String(s)) => !s.is_empty(),
        Some(Value::Array(items)) => !items.is_empty(),
        Some(Value::Object(map)) => !map.is_empty(),
    }
}

/// `pyStr`: Python-like `str(value)` as the TypeScript engine spells it (`None`, `True`,
/// JavaScript number text, `JSON.stringify` for arrays and objects).
#[must_use]
pub fn py_str(value: Option<&Value>) -> String {
    match value {
        None | Some(Value::Null) => "None".to_owned(),
        Some(Value::Bool(true)) => "True".to_owned(),
        Some(Value::Bool(false)) => "False".to_owned(),
        Some(Value::String(s)) => s.clone(),
        Some(Value::Number(n)) => js::number_to_string(n.as_f64().unwrap_or(f64::NAN)),
        Some(other) => js::stringify(other),
    }
}

/// Python `str(value or "")`.
#[must_use]
pub fn text(value: Option<&Value>) -> String {
    if truthy(value) {
        py_str(value)
    } else {
        String::new()
    }
}

/// Python `a or b or ...`: the first truthy value, else the last one.
#[must_use]
pub fn first_truthy<'a>(values: &[Option<&'a Value>]) -> Option<&'a Value> {
    values
        .iter()
        .copied()
        .find(|v| truthy(*v))
        .unwrap_or_else(|| values.last().copied().flatten())
}

const POW10: [f64; 4] = [1.0, 10.0, 100.0, 1000.0];

/// Python `round(x, digits)` for `digits` ≤ 3: correctly rounded on the exact binary value, ties
/// to even, then `Number(scaled) / 10 ** digits` as the TypeScript helper does.
///
/// # Errors
/// `UnsupportedValue` when `|x| ≥ 1e21` (the TypeScript helper throws there: `toFixed` switches to
/// exponent notation) or when `digits` > 3.
pub fn py_round(x: f64, digits: u32) -> Result<f64, EngineError> {
    if !x.is_finite() {
        return Ok(x);
    }
    if x == 0.0 {
        return Ok(0.0);
    }
    let scale = usize::try_from(digits)
        .ok()
        .and_then(|d| POW10.get(d).copied())
        .ok_or_else(|| EngineError::UnsupportedValue(format!("round to {digits} digits")))?;
    let magnitude = x.abs();
    if magnitude >= 1e21 {
        return Err(EngineError::UnsupportedValue(format!(
            "cannot round {} (|x| >= 1e21)",
            js::number_to_string(x)
        )));
    }
    let bits = magnitude.to_bits();
    let biased = i32::try_from((bits >> 52) & 0x7ff).unwrap_or(0);
    let fraction = bits & ((1u64 << 52) - 1);
    // magnitude = mantissa × 2^exponent exactly.
    let (mantissa, exponent) = if biased == 0 {
        (fraction, -1074)
    } else {
        (fraction | (1u64 << 52), biased - 1075)
    };
    let power = 10u128.pow(digits);
    let scaled = if exponent >= 0 {
        // magnitude < 1e21 < 2^70, so the shifted value and its scaled form fit in 128 bits.
        (u128::from(mantissa) << exponent) * power
    } else {
        let shift = exponent.unsigned_abs();
        let numerator = u128::from(mantissa) * power; // < 2^63
        if shift >= 127 {
            0 // numerator < 2^(shift - 1): below half a unit, rounds to zero.
        } else {
            let quotient = numerator >> shift;
            let remainder = numerator & ((1u128 << shift) - 1);
            let half = 1u128 << (shift - 1);
            if remainder > half || (remainder == half && quotient & 1 == 1) {
                quotient + 1
            } else {
                quotient
            }
        }
    };
    #[allow(clippy::cast_precision_loss)] // Number(BigInt): nearest double, ties to even.
    let result = scaled as f64 / scale;
    Ok(if x < 0.0 { -result } else { result })
}

/// Python `str(float)` as the TypeScript helper spells it: integral values keep one decimal
/// (`toFixed(1)`, which falls back to `String(x)` from 1e21 on).
#[must_use]
pub fn py_float(x: f64) -> String {
    if x.is_finite() && x.fract() == 0.0 && x.abs() < 1e21 {
        // `toFixed` writes the exact integer (123456789012345683968.0), not the shortest digits;
        // below 1e21 < 2^70 the conversion is exact. -0 prints as 0.0, like toFixed.
        #[allow(clippy::cast_possible_truncation)]
        let exact = x as i128;
        format!("{exact}.0")
    } else {
        js::number_to_string(x)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rounds_binary_ties_like_python() {
        assert_eq!(py_round(0.125, 2), Ok(0.12));
        assert_eq!(py_round(0.375, 2), Ok(0.38));
        assert_eq!(py_round(2.675, 2), Ok(2.67));
        assert_eq!(py_round(83.33333, 1), Ok(83.3));
        assert_eq!(py_round(-0.0, 2).map(f64::to_bits), Ok(0));
        assert!(py_round(1e21, 2).is_err());
    }

    #[test]
    fn python_truthiness() {
        let empty = Value::Array(vec![]);
        assert!(!truthy(Some(&empty)));
        assert!(!truthy(Some(&serde_json::json!(-0.0))));
        assert_eq!(text(Some(&serde_json::json!(12.0))), "12");
        assert_eq!(first_truthy(&[Some(&Value::Null), None]), None);
    }
}
