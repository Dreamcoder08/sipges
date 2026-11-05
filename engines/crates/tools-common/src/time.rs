//! JavaScript `Date` behaviour for timestamps read from or written to PostgreSQL.

use std::time::{Duration, SystemTime, UNIX_EPOCH};

/// `new Date()`: the current time truncated to whole milliseconds, as JavaScript holds it.
#[must_use]
pub fn now_ms() -> SystemTime {
    truncate_ms(SystemTime::now())
}

/// Drops sub-millisecond precision (postgres.js reads `timestamptz` into a millisecond `Date`).
#[must_use]
pub fn truncate_ms(at: SystemTime) -> SystemTime {
    let (negative, offset) = match at.duration_since(UNIX_EPOCH) {
        Ok(after) => (false, after),
        Err(before) => (true, before.duration()),
    };
    let millis = offset.as_millis();
    let whole = Duration::from_millis(u64::try_from(millis).unwrap_or(u64::MAX));
    if negative {
        // Towards negative infinity, like the integer milliseconds of a JavaScript Date.
        let rounded = if whole == offset {
            whole
        } else {
            whole + Duration::from_millis(1)
        };
        UNIX_EPOCH.checked_sub(rounded).unwrap_or(UNIX_EPOCH)
    } else {
        UNIX_EPOCH + whole
    }
}

/// Milliseconds since the epoch, floored.
#[must_use]
pub fn epoch_ms(at: SystemTime) -> i128 {
    match at.duration_since(UNIX_EPOCH) {
        Ok(after) => i128::try_from(after.as_millis()).unwrap_or(i128::MAX),
        Err(before) => {
            let d = before.duration();
            let ms = i128::try_from(d.as_millis()).unwrap_or(i128::MAX);
            if Duration::from_millis(u64::try_from(ms).unwrap_or(u64::MAX)) == d {
                -ms
            } else {
                -ms - 1
            }
        }
    }
}

/// Largest absolute value of a valid JavaScript `Date` (8.64e15 ms).
const MAX_DATE_MS: i128 = 8_640_000_000_000_000;

/// Civil date of a day count since 1970-01-01 (Howard Hinnant's algorithm).
fn civil(days: i128) -> (i128, u32, u32) {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = if m <= 2 { y + 1 } else { y };
    (
        year,
        u32::try_from(m).unwrap_or(1),
        u32::try_from(d).unwrap_or(1),
    )
}

/// `date.toISOString()`, or `None` where JavaScript throws `RangeError` (invalid date).
#[must_use]
pub fn to_iso_string(at: SystemTime) -> Option<String> {
    let ms = epoch_ms(at);
    if ms.abs() > MAX_DATE_MS {
        return None;
    }
    let days = ms.div_euclid(86_400_000);
    let in_day = ms.rem_euclid(86_400_000);
    let (year, month, day) = civil(days);
    let year = if (0..=9999).contains(&year) {
        format!("{year:04}")
    } else if year < 0 {
        format!("-{:06}", -year)
    } else {
        format!("+{year:06}")
    };
    Some(format!(
        "{year}-{month:02}-{day:02}T{:02}:{:02}:{:02}.{:03}Z",
        in_day / 3_600_000,
        in_day / 60_000 % 60,
        in_day / 1000 % 60,
        in_day % 1000
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn at(ms: i64) -> SystemTime {
        if ms >= 0 {
            UNIX_EPOCH + Duration::from_millis(ms.unsigned_abs())
        } else {
            UNIX_EPOCH - Duration::from_millis(ms.unsigned_abs())
        }
    }

    #[test]
    fn formats_like_to_iso_string() {
        // Values checked with Node: new Date(ms).toISOString().
        assert_eq!(
            to_iso_string(at(0)).as_deref(),
            Some("1970-01-01T00:00:00.000Z")
        );
        assert_eq!(
            to_iso_string(at(1_793_836_800_123)).as_deref(),
            Some("2026-11-05T00:00:00.123Z")
        );
        assert_eq!(
            to_iso_string(at(-1)).as_deref(),
            Some("1969-12-31T23:59:59.999Z")
        );
        assert_eq!(
            to_iso_string(at(253_402_300_800_000)).as_deref(),
            Some("+010000-01-01T00:00:00.000Z")
        );
        assert_eq!(
            to_iso_string(at(-62_198_755_200_000)).as_deref(),
            Some("-000001-01-01T00:00:00.000Z")
        );
        assert_eq!(to_iso_string(at(8_640_000_000_000_001)), None);
    }

    #[test]
    fn truncates_to_milliseconds() {
        let precise = UNIX_EPOCH + Duration::from_micros(1_500);
        assert_eq!(truncate_ms(precise), UNIX_EPOCH + Duration::from_millis(1));
        let before = UNIX_EPOCH - Duration::from_micros(1_500);
        assert_eq!(epoch_ms(truncate_ms(before)), -2);
    }
}
