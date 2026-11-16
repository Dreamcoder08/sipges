//! Day strings as `signals.ts` handles them: `dayOf`, `addDays`, `daysBetween` and the kernel's
//! `recordDueDate`. A day is `YYYY-MM-DD`; arithmetic runs on days since 1970-01-01, which is what
//! `Date.parse(`${day}T00:00:00Z`)` / `toISOString().slice(0, 10)` amount to.

use serde_json::{Map, Value};

/// Days since 1970-01-01 of a proleptic Gregorian date (Howard Hinnant's `days_from_civil`).
fn days_from_civil(year: i64, month: i64, day: i64) -> i64 {
    let y = if month <= 2 { year - 1 } else { year };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let mp = (month + 9) % 12;
    let doy = (153 * mp + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

/// `(year, month, day)` of a day count (`civil_from_days`).
fn civil_from_days(days: i64) -> (i64, i64, i64) {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    (yoe + era * 400 + i64::from(month <= 2), month, day)
}

fn digits(s: &str) -> Option<i64> {
    if s.bytes().all(|b| b.is_ascii_digit()) {
        s.parse().ok()
    } else {
        None
    }
}

/// `(year, month, day)` of an exact `YYYY-MM-DD` string.
fn parts(s: &str) -> Option<(i64, i64, i64)> {
    let b = s.as_bytes();
    if b.len() != 10 || b.get(4) != Some(&b'-') || b.get(7) != Some(&b'-') {
        return None;
    }
    Some((
        digits(s.get(..4)?)?,
        digits(s.get(5..7)?)?,
        digits(s.get(8..)?)?,
    ))
}

fn days_in_month(year: i64, month: i64) -> i64 {
    let leap = year % 4 == 0 && (year % 100 != 0 || year % 400 == 0);
    match month {
        2 if leap => 29,
        2 => 28,
        4 | 6 | 9 | 11 => 30,
        _ => 31,
    }
}

/// Days since the epoch of `Date.parse(`${day}T00:00:00Z`)` for a `YYYY-MM-DD` day: V8 accepts
/// months 01–12 and days 01–31 and rolls `2026-02-30` over to March. `None` where it is `NaN`.
#[must_use]
pub fn parse_day(day: &str) -> Option<i64> {
    let (year, month, d) = parts(day)?;
    ((1..=12).contains(&month) && (1..=31).contains(&d))
        .then(|| days_from_civil(year, month, 1) + d - 1)
}

/// `new Date(ms).toISOString().slice(0, 10)` of a day count: `YYYY-MM-DD` for years 0–9999,
/// otherwise the first ten characters of the expanded `±YYYYYY-MM-DD` form.
#[must_use]
pub fn format_day(days: i64) -> String {
    let (year, month, day) = civil_from_days(days);
    if (0..=9999).contains(&year) {
        format!("{year:04}-{month:02}-{day:02}")
    } else {
        let sign = if year < 0 { '-' } else { '+' };
        let full = format!("{sign}{:06}-{month:02}-{day:02}", year.abs());
        full.get(..10).unwrap_or(&full).to_owned()
    }
}

/// `addDays(day, days)` for a day [`parse_day`] accepts.
#[must_use]
pub fn add_days(day: &str, days: i64) -> Option<String> {
    parse_day(day).map(|d| format_day(d + days))
}

/// `daysBetween(from, to)`.
#[must_use]
pub fn days_between(from: &str, to: &str) -> Option<i64> {
    Some(parse_day(to)? - parse_day(from)?)
}

fn real_day(year: i64, month: i64, day: i64) -> bool {
    (1..=12).contains(&month) && day >= 1 && day <= days_in_month(year, month)
}

/// `dayOf(value)`: `YYYY-MM-DD` from a value starting with an ISO day or `d/m/yyyy`, when it is a
/// real calendar day.
#[must_use]
pub fn day_of(value: &str) -> Option<String> {
    let b = value.as_bytes();
    let digit = |i: usize| b.get(i).is_some_and(u8::is_ascii_digit);
    if (0..4).all(digit)
        && b.get(4) == Some(&b'-')
        && digit(5)
        && digit(6)
        && b.get(7) == Some(&b'-')
        && digit(8)
        && digit(9)
    {
        let day = value.get(..10)?;
        let (y, m, d) = parts(day)?;
        return real_day(y, m, d).then(|| day.to_owned());
    }
    // ^(\d{1,2})\/(\d{1,2})\/(\d{4})
    let field = |start: usize| -> Option<(usize, usize)> {
        let len = (0..2).take_while(|&k| digit(start + k)).count();
        (len > 0).then_some((start, start + len))
    };
    let (d0, d1) = field(0)?;
    if b.get(d1) != Some(&b'/') {
        return None;
    }
    let (m0, m1) = field(d1 + 1)?;
    if b.get(m1) != Some(&b'/') || !(m1 + 1..m1 + 5).all(digit) {
        return None;
    }
    let pad = |s: &str| {
        if s.len() == 1 {
            format!("0{s}")
        } else {
            s.to_owned()
        }
    };
    let day = format!(
        "{}-{}-{}",
        value.get(m1 + 1..m1 + 5)?,
        pad(value.get(m0..m1)?),
        pad(value.get(d0..d1)?)
    );
    let (y, m, d) = parts(&day)?;
    real_day(y, m, d).then_some(day)
}

/// Peru keeps UTC−5 all year (`LIMA_OFFSET_MINUTES` in `signals.ts`).
const LIMA_OFFSET_MINUTES: i64 = -300;

/// Two ASCII digits at `at`, as a number.
fn two_digits(b: &[u8], at: usize) -> Option<i64> {
    match (b.get(at), b.get(at + 1)) {
        (Some(&h), Some(&l)) if h.is_ascii_digit() && l.is_ascii_digit() => {
            Some(i64::from(h - b'0') * 10 + i64::from(l - b'0'))
        }
        _ => None,
    }
}

/// The zone of `Z|([+-])(\d{2})(?::?(\d{2}))?` at `at`, ending the value, in minutes east of UTC.
fn zone_minutes(b: &[u8], at: usize) -> Option<i64> {
    let sign = match b.get(at)? {
        b'Z' => return (b.len() == at + 1).then_some(0),
        b'+' => 1,
        b'-' => -1,
        _ => return None,
    };
    let hours = two_digits(b, at + 1)?;
    let rest = at + 3;
    let minutes = if b.len() == rest {
        0
    } else {
        let from = if b.get(rest) == Some(&b':') {
            rest + 1
        } else {
            rest
        };
        (b.len() == from + 2).then_some(())?;
        two_digits(b, from)?
    };
    (hours <= 23 && minutes <= 59).then_some(sign * (hours * 60 + minutes))
}

/// The Lima day of a full timestamp with a zone,
/// `^(\d{4}-\d{2}-\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(Z|[+-]\d{2}(?::?\d{2})?)$`.
fn zoned_lima_day(value: &str) -> Option<String> {
    let b = value.as_bytes();
    let day = value.get(..10)?;
    let (y, m, d) = parts(day)?;
    if !real_day(y, m, d) || !matches!(b.get(10), Some(b'T' | b' ')) || b.get(13) != Some(&b':') {
        return None;
    }
    let (hour, minute) = (two_digits(b, 11)?, two_digits(b, 14)?);
    let mut at = 16;
    let mut second = 0;
    if b.get(at) == Some(&b':') {
        second = two_digits(b, at + 1)?;
        at += 3;
        if b.get(at) == Some(&b'.') {
            let fraction = b
                .iter()
                .skip(at + 1)
                .take_while(|c| c.is_ascii_digit())
                .count();
            if fraction == 0 {
                return None;
            }
            at += 1 + fraction;
        }
    }
    let offset = zone_minutes(b, at)?;
    if hour > 23 || minute > 59 || second > 59 {
        return None;
    }
    let lima = hour * 60 + minute - offset + LIMA_OFFSET_MINUTES;
    add_days(day, lima.div_euclid(1440))
}

/// `limaDayOf(value)`: the Lima calendar day of a stored instant (`updatedAt`, `createdAt`,
/// `reviewedAt`). Only a full timestamp with `Z` or an offset is shifted; a civil date, a
/// timestamp without a zone (Lima wall time) or a malformed one is read by [`day_of`].
#[must_use]
pub fn lima_day_of(value: &str) -> Option<String> {
    zoned_lima_day(value).or_else(|| day_of(value))
}

/// `isValidCalendarDate` (`packages/kernel/src/calendar.ts`): exactly `YYYY-MM-DD`, year ≥ 1.
fn is_valid_calendar_date(value: &Value) -> bool {
    let Value::String(s) = value else {
        return false;
    };
    parts(s).is_some_and(|(y, m, d)| y >= 1 && real_day(y, m, d))
}

/// `recordDueDate(payload)`: the first of `Fecha_Vencimiento`, `Fecha_Limite`, `Plazo` present
/// decides; a cleared or malformed one blocks the fallback.
#[must_use]
pub fn record_due_date(payload: &Map<String, Value>) -> Option<String> {
    for key in ["Fecha_Vencimiento", "Fecha_Limite", "Plazo"] {
        if let Some(value) = payload.get(key) {
            return is_valid_calendar_date(value)
                .then(|| value.as_str().map(str::to_owned))
                .flatten();
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn days_round_trip_like_javascript() {
        assert_eq!(add_days("2026-02-30", 0).as_deref(), Some("2026-03-02"));
        assert_eq!(add_days("2026-11-02", -30).as_deref(), Some("2026-10-03"));
        assert_eq!(add_days("0000-01-01", -1).as_deref(), Some("-000001-12"));
        assert_eq!(add_days("9999-12-31", 1).as_deref(), Some("+010000-01"));
        assert_eq!(add_days("2024-02-28", 1).as_deref(), Some("2024-02-29"));
        assert_eq!(parse_day("2026-02-32"), None);
        assert_eq!(parse_day("2026-00-10"), None);
        assert_eq!(days_between("2026-10-31", "2026-11-02"), Some(2));
    }

    #[test]
    fn day_of_accepts_iso_and_local_days() {
        assert_eq!(
            day_of("2026-10-31T23:59:59-05:00").as_deref(),
            Some("2026-10-31")
        );
        assert_eq!(day_of("1/11/2026").as_deref(), Some("2026-11-01"));
        assert_eq!(day_of("05/1/20261").as_deref(), Some("2026-01-05"));
        assert_eq!(day_of("31/04/2026"), None);
        assert_eq!(day_of("2026-02-30"), None);
        assert_eq!(day_of("123/10/2026"), None);
        assert_eq!(day_of("0000-02-29").as_deref(), Some("0000-02-29"));
        assert_eq!(day_of(" 2026-10-30"), None);
    }

    #[test]
    fn lima_day_of_shifts_only_zoned_instants() {
        let cases = [
            ("2026-11-02T02:00:00Z", Some("2026-11-01")),
            ("2026-11-02 02:00:00+00", Some("2026-11-01")),
            ("2026-11-02T02:00Z", Some("2026-11-01")),
            ("2026-11-01T22:00:00-0500", Some("2026-11-01")),
            ("2026-11-01T22:00:00-0400", Some("2026-11-01")),
            ("2026-11-01T23:30:00-06:00", Some("2026-11-02")),
            ("2026-11-02T00:00:00+23:59", Some("2026-10-31")),
            ("0000-01-01T04:00:00Z", Some("-000001-12")),
            ("2026-11-02T02:00:00", Some("2026-11-02")),
            ("2026-11-02T02:00:00.Z", Some("2026-11-02")),
            ("2026-11-02T02:00:00+05:", Some("2026-11-02")),
            ("2026-11-02T02:00:00+053", Some("2026-11-02")),
            ("2026-11-02T02:00:60Z", Some("2026-11-02")),
            ("2026-11-02t02:00:00z", Some("2026-11-02")),
            ("2026-11-02T02:00:00Z ", Some("2026-11-02")),
            ("2026-02-29T10:00:00Z", None),
            ("", None),
        ];
        for (value, day) in cases {
            assert_eq!(lima_day_of(value).as_deref(), day, "{value:?}");
        }
    }
}
