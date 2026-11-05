//! `new Date(value)`, which `parseLegacyTimestamp` relies on, ported from V8's `DateParser`
//! (`src/date/dateparser-inl.h`, `dateparser.cc`, `dateparser.h`; BSD-3-Clause, V8 project).
//!
//! The legacy columns hold more than ISO strings, and V8 falls back to its legacy grammar for
//! everything else (`2026-10-01Z`, `10/01/2026`, `Oct 1 2026`, and days past the end of a month,
//! which roll over). `engines/fixtures/legacy-dates.json` pins the port to what Node returns.
//!
//! One difference: a text with no time zone at all is local time in JavaScript and UTC here. The
//! tool appends `Z` unless the text already ends like an offset, so this needs a shape such as
//! `01-02-2026`, whose `-2026` looks like one.

/// `kMaxInt`: a value not set yet.
const NONE: i32 = i32::MAX;
/// `kMaxSignificantDigits`.
const MAX_SIGNIFICANT_DIGITS: i32 = 9;
/// Largest absolute time value of a `Date`.
const MAX_TIME_MS: i64 = 8_640_000_000_000_000;

#[derive(Clone, Copy, PartialEq, Eq)]
enum Keyword {
    Invalid,
    Month,
    AmPm,
    Zone,
    TimeSeparator,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Tag {
    Invalid,
    Unknown,
    Number,
    Symbol,
    WhiteSpace,
    End,
    Word(Keyword),
}

#[derive(Clone, Copy)]
struct Token {
    tag: Tag,
    length: i32,
    value: i32,
}

impl Token {
    const fn new(tag: Tag, length: i32, value: i32) -> Self {
        Self { tag, length, value }
    }
    const fn end() -> Self {
        Self::new(Tag::End, 0, -1)
    }
    const fn invalid() -> Self {
        Self::new(Tag::Invalid, 0, -1)
    }
    fn is_number(self) -> bool {
        self.tag == Tag::Number
    }
    fn is_end(self) -> bool {
        self.tag == Tag::End
    }
    fn is_invalid(self) -> bool {
        self.tag == Tag::Invalid
    }
    fn is_symbol(self, symbol: char) -> bool {
        self.tag == Tag::Symbol && self.value == symbol as i32
    }
    fn is_fixed_number(self, length: i32) -> bool {
        self.is_number() && self.length == length
    }
    fn is_sign(self) -> bool {
        self.is_symbol('+') || self.is_symbol('-')
    }
    fn is_word(self, keyword: Keyword) -> bool {
        self.tag == Tag::Word(keyword)
    }
    fn is_z(self) -> bool {
        self.is_word(Keyword::Zone) && self.length == 1
    }
    /// `44 - value`: `+` is 1, `-` is -1.
    const fn sign(self) -> i32 {
        44 - self.value
    }
}

/// `{'j','a','n', MONTH_NAME, 1}`…; the lookup returns the first match.
const KEYWORDS: &[([u32; 3], Keyword, i32)] = &[
    (word(*b"jan"), Keyword::Month, 1),
    (word(*b"feb"), Keyword::Month, 2),
    (word(*b"mar"), Keyword::Month, 3),
    (word(*b"apr"), Keyword::Month, 4),
    (word(*b"may"), Keyword::Month, 5),
    (word(*b"jun"), Keyword::Month, 6),
    (word(*b"jul"), Keyword::Month, 7),
    (word(*b"aug"), Keyword::Month, 8),
    (word(*b"sep"), Keyword::Month, 9),
    (word(*b"oct"), Keyword::Month, 10),
    (word(*b"nov"), Keyword::Month, 11),
    (word(*b"dec"), Keyword::Month, 12),
    (word(*b"am\0"), Keyword::AmPm, 0),
    (word(*b"pm\0"), Keyword::AmPm, 12),
    (word(*b"ut\0"), Keyword::Zone, 0),
    (word(*b"utc"), Keyword::Zone, 0),
    (word(*b"z\0\0"), Keyword::Zone, 0),
    (word(*b"gmt"), Keyword::Zone, 0),
    (word(*b"cdt"), Keyword::Zone, -5),
    (word(*b"cst"), Keyword::Zone, -6),
    (word(*b"edt"), Keyword::Zone, -4),
    (word(*b"est"), Keyword::Zone, -5),
    (word(*b"mdt"), Keyword::Zone, -6),
    (word(*b"mst"), Keyword::Zone, -7),
    (word(*b"pdt"), Keyword::Zone, -7),
    (word(*b"pst"), Keyword::Zone, -8),
    (word(*b"t\0\0"), Keyword::TimeSeparator, 0),
];

/// The table's three-letter prefix, padded with zeroes.
const fn word(letters: [u8; 3]) -> [u32; 3] {
    [letters[0] as u32, letters[1] as u32, letters[2] as u32]
}

fn is_digit(c: u32) -> bool {
    (0x30..=0x39).contains(&c)
}

/// `IsWhiteSpace`: Unicode `Zs`, tab, vertical tab, form feed and the BOM.
fn is_white_space(c: u32) -> bool {
    matches!(
        c,
        0x09 | 0x0B | 0x0C | 0x20 | 0xA0 | 0x1680 | 0x2000
            ..=0x200A | 0x202F | 0x205F | 0x3000 | 0xFEFF
    )
}

/// `IsWhiteSpaceOrLineTerminator`.
fn is_white_space_or_terminator(c: u32) -> bool {
    is_white_space(c) || matches!(c, 0x0A | 0x0D | 0x2028 | 0x2029)
}

/// `InputReader`: UTF-16 units, with 0 as end of input (an embedded NUL ends it too).
struct Reader<'a> {
    units: &'a [u16],
    index: i32,
    ch: u32,
}

impl Reader<'_> {
    fn next(&mut self) {
        let at = usize::try_from(self.index).unwrap_or(usize::MAX);
        self.ch = self.units.get(at).map_or(0, |unit| u32::from(*unit));
        self.index += 1;
    }

    fn numeral(&mut self) -> i32 {
        let mut n: i32 = 0;
        let mut digits = 0;
        while self.ch == 0x30 {
            self.next();
        }
        while is_digit(self.ch) {
            if digits < MAX_SIGNIFICANT_DIGITS {
                n = n * 10 + i32::try_from(self.ch).unwrap_or(0) - 0x30;
            }
            digits += 1;
            self.next();
        }
        n
    }

    fn is_word_char(&self) -> bool {
        self.ch >= 0x41 && !is_white_space(self.ch)
    }

    fn word(&mut self) -> (usize, [u32; 3]) {
        let mut prefix = [0_u32; 3];
        let mut len = 0;
        while self.is_word_char() {
            if let Some(slot) = prefix.get_mut(len) {
                *slot = self.ch | 0x20;
            }
            len += 1;
            self.next();
        }
        (len, prefix)
    }

    fn skip(&mut self, c: char) -> bool {
        if self.ch == c as u32 {
            self.next();
            return true;
        }
        false
    }

    fn skip_parentheses(&mut self) -> bool {
        if self.ch != 0x28 {
            return false;
        }
        let mut balance = 0;
        loop {
            if self.ch == 0x29 {
                balance -= 1;
            } else if self.ch == 0x28 {
                balance += 1;
            }
            self.next();
            if balance <= 0 || self.ch == 0 {
                return true;
            }
        }
    }
}

/// `KeywordTable::Lookup`: a word longer than three letters only matches a month.
fn keyword(prefix: [u32; 3], len: usize) -> (Keyword, i32) {
    KEYWORDS
        .iter()
        .find(|(word, kind, _)| *word == prefix && (len <= 3 || *kind == Keyword::Month))
        .map_or((Keyword::Invalid, 0), |(_, kind, value)| (*kind, *value))
}

/// `DateStringTokenizer`.
struct Scanner<'a> {
    input: Reader<'a>,
    peeked: Token,
}

impl<'a> Scanner<'a> {
    fn new(units: &'a [u16]) -> Self {
        let mut input = Reader {
            units,
            index: 0,
            ch: 0,
        };
        input.next();
        let mut scanner = Self {
            input,
            peeked: Token::end(),
        };
        scanner.peeked = scanner.scan();
        scanner
    }

    fn scan(&mut self) -> Token {
        let start = self.input.index;
        if self.input.ch == 0 {
            return Token::end();
        }
        if is_digit(self.input.ch) {
            let n = self.input.numeral();
            return Token::new(Tag::Number, self.input.index - start, n);
        }
        for symbol in [':', '-', '+', '.', ')'] {
            if self.input.skip(symbol) {
                return Token::new(Tag::Symbol, 1, symbol as i32);
            }
        }
        if self.input.is_word_char() {
            let (len, prefix) = self.input.word();
            let (kind, value) = keyword(prefix, len);
            return Token::new(
                Tag::Word(kind),
                i32::try_from(len).unwrap_or(i32::MAX),
                value,
            );
        }
        if is_white_space_or_terminator(self.input.ch) {
            self.input.next();
            return Token::new(Tag::WhiteSpace, self.input.index - start, -1);
        }
        if self.input.skip_parentheses() {
            return Token::new(Tag::Unknown, 1, -1);
        }
        self.input.next();
        Token::new(Tag::Unknown, 1, -1)
    }

    fn next(&mut self) -> Token {
        let token = self.peeked;
        self.peeked = self.scan();
        token
    }

    const fn peek(&self) -> Token {
        self.peeked
    }

    fn skip_symbol(&mut self, symbol: char) -> bool {
        if self.peeked.is_symbol(symbol) {
            self.peeked = self.scan();
            return true;
        }
        false
    }
}

fn is_month(x: i32) -> bool {
    (1..=12).contains(&x)
}
fn is_day(x: i32) -> bool {
    (1..=31).contains(&x)
}
fn is_hour(x: i32) -> bool {
    (0..=23).contains(&x)
}
fn is_minute(x: i32) -> bool {
    (0..=59).contains(&x)
}

/// `TimeZoneComposer`.
struct Zone {
    sign: i32,
    hour: i32,
    minute: i32,
}

impl Zone {
    fn set(&mut self, offset_hours: i32) {
        self.sign = if offset_hours < 0 { -1 } else { 1 };
        self.hour = offset_hours * self.sign;
        self.minute = 0;
    }
    fn expects(&self, n: i32) -> bool {
        self.hour != NONE && self.minute == NONE && is_minute(n)
    }
    const fn is_utc(&self) -> bool {
        self.hour == 0 && self.minute == 0
    }
    const fn is_empty(&self) -> bool {
        self.hour == NONE
    }
    /// The offset in seconds, `None` without a zone; `Err` where `Write` fails.
    fn write(&self) -> Result<Option<i64>, ()> {
        if self.sign == NONE {
            return Ok(None);
        }
        let hour = if self.hour == NONE { 0 } else { self.hour };
        let minute = if self.minute == NONE { 0 } else { self.minute };
        // Unsigned arithmetic, wrapping as in C++.
        let total = hour
            .cast_unsigned()
            .wrapping_mul(3600)
            .wrapping_add(minute.cast_unsigned().wrapping_mul(60));
        if total > 0x7FFF_FFFF {
            return Err(());
        }
        let total = i64::from(total);
        Ok(Some(if self.sign < 0 { -total } else { total }))
    }
}

/// `TimeComposer`.
struct Time {
    comp: [i32; 4],
    index: usize,
    hour_offset: i32,
}

impl Time {
    const fn is_empty(&self) -> bool {
        self.index == 0
    }
    fn expects(&self, n: i32) -> bool {
        (self.index == 1 && is_minute(n))
            || (self.index == 2 && is_minute(n))
            || (self.index == 3 && (0..=999).contains(&n))
    }
    fn add(&mut self, n: i32) -> bool {
        match self.comp.get_mut(self.index) {
            Some(slot) => {
                *slot = n;
                self.index += 1;
                true
            }
            None => false,
        }
    }
    fn add_final(&mut self, n: i32) {
        if self.add(n) {
            self.index = 4;
        }
    }
    /// Hour, minute, second and millisecond.
    fn write(&self) -> Option<[i32; 4]> {
        let [mut hour, minute, second, millisecond] = self.comp;
        if self.hour_offset != NONE {
            if !(0..=12).contains(&hour) {
                return None;
            }
            hour %= 12;
            hour += self.hour_offset;
        }
        let fits = is_hour(hour)
            && is_minute(minute)
            && is_minute(second)
            && (0..=999).contains(&millisecond);
        // A 24th hour is allowed if minutes, seconds and milliseconds are 0.
        if !fits && (hour != 24 || minute != 0 || second != 0 || millisecond != 0) {
            return None;
        }
        Some([hour, minute, second, millisecond])
    }
}

/// `DayComposer`.
struct Day {
    comp: [i32; 3],
    index: usize,
    named_month: i32,
    iso: bool,
}

impl Day {
    const fn is_empty(&self) -> bool {
        self.index == 0
    }
    fn add(&mut self, n: i32) -> bool {
        match self.comp.get_mut(self.index) {
            Some(slot) => {
                *slot = n;
                self.index += 1;
                true
            }
            None => false,
        }
    }
    /// Year, 0-based month and day.
    fn write(&self) -> Option<(i32, i32, i32)> {
        if self.index < 1 {
            return None;
        }
        // Day and month default to 1.
        let mut comp = [1; 3];
        for (slot, value) in comp.iter_mut().zip(self.comp.iter()).take(self.index) {
            *slot = *value;
        }
        let [first, second, third] = comp;
        let (mut year, month, day);
        if self.named_month == NONE {
            if self.iso || !is_day(first) {
                (year, month, day) = (first, second, third);
            } else {
                (month, day, year) = (first, second, third);
            }
        } else {
            month = self.named_month;
            if is_day(first) {
                (day, year) = (first, second);
            } else {
                (year, day) = (first, second);
            }
        }
        if !self.iso {
            if (0..=49).contains(&year) {
                year += 2000;
            } else if (50..=99).contains(&year) {
                year += 1900;
            }
        }
        if !is_month(month) || !is_day(day) {
            return None;
        }
        Some((year, month - 1, day))
    }
}

/// `ReadMilliseconds`: the first three significant digits of the numeral.
fn read_milliseconds(token: Token) -> i32 {
    let mut number = token.value;
    let mut length = token.length;
    if length < 3 {
        number *= match length {
            1 => 100,
            2 => 10,
            _ => 1,
        };
    } else if length > 3 {
        length = length.min(MAX_SIGNIFICANT_DIGITS);
        let mut factor = 1;
        while length > 3 {
            factor *= 10;
            length -= 1;
        }
        number /= factor;
    }
    number
}

/// `ParseES5DateTime`: the next token for the legacy parser, `End` when done, `Invalid` to fail.
fn parse_es5(scanner: &mut Scanner<'_>, day: &mut Day, time: &mut Time, zone: &mut Zone) -> Token {
    if scanner.peek().is_sign() {
        let sign_token = scanner.next();
        if !scanner.peek().is_fixed_number(6) {
            return sign_token;
        }
        let sign = sign_token.sign();
        let year = scanner.next().value;
        if sign < 0 && year == 0 {
            return sign_token;
        }
        day.add(sign * year);
    } else if scanner.peek().is_fixed_number(4) {
        day.add(scanner.next().value);
    } else {
        return scanner.next();
    }
    if scanner.skip_symbol('-') {
        if !scanner.peek().is_fixed_number(2) || !is_month(scanner.peek().value) {
            return scanner.next();
        }
        day.add(scanner.next().value);
        if scanner.skip_symbol('-') {
            if !scanner.peek().is_fixed_number(2) || !is_day(scanner.peek().value) {
                return scanner.next();
            }
            day.add(scanner.next().value);
        }
    }
    if scanner.peek().is_word(Keyword::TimeSeparator) {
        scanner.next();
        if parse_es5_time(scanner, time, zone).is_none() {
            return Token::invalid();
        }
    } else if !scanner.peek().is_end() {
        return scanner.next();
    }
    if zone.is_empty() && time.is_empty() {
        zone.set(0);
    }
    day.iso = true;
    Token::end()
}

/// The time part after `T`; `None` where `ParseES5DateTime` returns `Invalid`.
fn parse_es5_time(scanner: &mut Scanner<'_>, time: &mut Time, zone: &mut Zone) -> Option<()> {
    let two = |scanner: &Scanner<'_>| scanner.peek().is_fixed_number(2);
    if !two(scanner) || !(0..=24).contains(&scanner.peek().value) {
        return None;
    }
    // Allow 24:00[:00[.000]], but no other time starting with 24.
    let hour_is_24 = scanner.peek().value == 24;
    time.add(scanner.next().value);
    if !scanner.skip_symbol(':') {
        return None;
    }
    if !two(scanner) || !is_minute(scanner.peek().value) || (hour_is_24 && scanner.peek().value > 0)
    {
        return None;
    }
    time.add(scanner.next().value);
    if scanner.skip_symbol(':') {
        if !two(scanner)
            || !is_minute(scanner.peek().value)
            || (hour_is_24 && scanner.peek().value > 0)
        {
            return None;
        }
        time.add(scanner.next().value);
        if scanner.skip_symbol('.') {
            if !scanner.peek().is_number() || (hour_is_24 && scanner.peek().value > 0) {
                return None;
            }
            // Allow more or less than the mandated three digits.
            time.add(read_milliseconds(scanner.next()));
        }
    }
    if scanner.peek().is_z() {
        scanner.next();
        zone.set(0);
    } else if scanner.peek().is_symbol('+') || scanner.peek().is_symbol('-') {
        zone.sign = if scanner.next().is_symbol('+') { 1 } else { -1 };
        if scanner.peek().is_fixed_number(4) {
            // hhmm extension syntax.
            let hourmin = scanner.next().value;
            let (hour, minute) = (hourmin / 100, hourmin % 100);
            if !is_hour(hour) || !is_minute(minute) {
                return None;
            }
            zone.hour = hour;
            zone.minute = minute;
        } else {
            // hh:mm standard syntax.
            if !two(scanner) || !is_hour(scanner.peek().value) {
                return None;
            }
            zone.hour = scanner.next().value;
            if !scanner.skip_symbol(':') {
                return None;
            }
            if !two(scanner) || !is_minute(scanner.peek().value) {
                return None;
            }
            zone.minute = scanner.next().value;
        }
    }
    scanner.peek().is_end().then_some(())
}

/// The legacy loop of `DateParser::Parse`, from `first`; `None` where it returns false.
fn parse_legacy(
    scanner: &mut Scanner<'_>,
    first: Token,
    day: &mut Day,
    time: &mut Time,
    zone: &mut Zone,
) -> Option<()> {
    let mut has_read_number = !day.is_empty();
    let mut token = first;
    while !token.is_end() {
        if token.is_number() {
            has_read_number = true;
            let n = token.value;
            if scanner.skip_symbol(':') {
                if scanner.skip_symbol(':') {
                    // n + "::"
                    if !time.is_empty() {
                        return None;
                    }
                    time.add(n);
                    time.add(0);
                } else {
                    // n + ":"
                    if !time.add(n) {
                        return None;
                    }
                    if scanner.peek().is_symbol('.') {
                        scanner.next();
                    }
                }
            } else if scanner.skip_symbol('.') && time.expects(n) {
                time.add(n);
                if !scanner.peek().is_number() {
                    return None;
                }
                let ms = read_milliseconds(scanner.next());
                if ms < 0 {
                    return None;
                }
                time.add_final(ms);
            } else if zone.expects(n) {
                zone.minute = n;
            } else if time.expects(n) {
                time.add_final(n);
                // Require end, white space, "Z", "+" or "-" immediately after finalizing time.
                let peek = scanner.peek();
                if !peek.is_end() && peek.tag != Tag::WhiteSpace && !peek.is_z() && !peek.is_sign()
                {
                    return None;
                }
            } else {
                if !day.add(n) {
                    return None;
                }
                scanner.skip_symbol('-');
            }
        } else if let Tag::Word(kind) = token.tag {
            let value = token.value;
            if kind == Keyword::AmPm && !time.is_empty() {
                time.hour_offset = value;
            } else if kind == Keyword::Month {
                day.named_month = value;
                scanner.skip_symbol('-');
            } else if kind == Keyword::Zone && has_read_number {
                zone.set(value);
            } else {
                // Garbage words are illegal if a number has been read.
                if has_read_number {
                    return None;
                }
                // The first number has to be separated from garbage words.
                if scanner.peek().is_number() {
                    return None;
                }
            }
        } else if token.is_sign() && (zone.is_utc() || !time.is_empty()) {
            // UTC offset, only after UTC or a time.
            zone.sign = if token.sign() < 0 { -1 } else { 1 };
            let (mut n, mut length) = (0, 0);
            if scanner.peek().is_number() {
                let next = scanner.next();
                length = next.length;
                n = next.value;
            }
            has_read_number = true;
            if scanner.peek().is_symbol(':') {
                zone.hour = n;
                zone.minute = NONE;
            } else if length == 2 || length == 1 {
                // Time zones like GMT-8.
                zone.hour = n;
                zone.minute = 0;
            } else if length == 4 || length == 3 {
                // Looks like hhmm.
                zone.hour = n / 100;
                zone.minute = n % 100;
            } else {
                return None;
            }
        } else if (token.is_sign() || token.is_symbol(')')) && has_read_number {
            // An extra sign or ')' is illegal once a number has been read.
            return None;
        }
        token = scanner.next();
    }
    Some(())
}

/// Days from 1970-01-01 to the first of a month, proleptic Gregorian (Hinnant).
fn days_from_civil(year: i64, month0: i64) -> i64 {
    let month = month0 + 1;
    let y = if month <= 2 { year - 1 } else { year };
    let era = y.div_euclid(400);
    let yoe = y.rem_euclid(400);
    let mp = (month + 9) % 12;
    let doy = (153 * mp + 2) / 5;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

/// `TimeClip` of a whole number of milliseconds.
fn time_clip(ms: i64) -> Option<i64> {
    (ms.abs() <= MAX_TIME_MS).then_some(ms)
}

/// `new Date(text).getTime()`, `None` for an invalid date.
#[must_use]
pub fn parse(text: &str) -> Option<i64> {
    let units: Vec<u16> = text.encode_utf16().collect();
    let mut scanner = Scanner::new(&units);
    let mut zone = Zone {
        sign: NONE,
        hour: NONE,
        minute: NONE,
    };
    let mut time = Time {
        comp: [0; 4],
        index: 0,
        hour_offset: NONE,
    };
    let mut day = Day {
        comp: [0; 3],
        index: 0,
        named_month: NONE,
        iso: false,
    };
    let first = parse_es5(&mut scanner, &mut day, &mut time, &mut zone);
    if first.is_invalid() {
        return None;
    }
    parse_legacy(&mut scanner, first, &mut day, &mut time, &mut zone)?;
    let (year, month0, date) = day.write()?;
    let [hour, minute, second, millisecond] = time.write()?;
    let offset = zone.write().ok()?;
    // MakeDay: the year range V8 accepts.
    if !(-1_000_000..=1_000_000).contains(&year) {
        return None;
    }
    let days = days_from_civil(i64::from(year), i64::from(month0)) + i64::from(date) - 1;
    let in_day = i64::from(hour) * 3_600_000
        + i64::from(minute) * 60_000
        + i64::from(second) * 1000
        + i64::from(millisecond);
    time_clip(days * 86_400_000 + in_day - offset.unwrap_or(0) * 1000)
}

/// `new Date(value).getTime()` for a number (`TimeClip`), `None` for an invalid date.
#[must_use]
#[allow(clippy::cast_possible_truncation, clippy::cast_precision_loss)]
pub fn from_number(value: f64) -> Option<i64> {
    if !value.is_finite() || value.abs() > MAX_TIME_MS as f64 {
        return None;
    }
    Some(value.trunc() as i64)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn matches_node_on_the_recorded_vectors() {
        // Written by engines/fixtures/legacy-dates.ts: [text, new Date(text).getTime() or null].
        let vectors = include_str!("../../../fixtures/legacy-dates.tsv");
        let mut seen = 0;
        let mut wrong = Vec::new();
        for line in vectors.lines() {
            let Some((expected, text)) = line.split_once('\t') else {
                continue;
            };
            let text = text
                .replace("\\n", "\n")
                .replace("\\t", "\t")
                .replace("\\0", "\0");
            let expected = expected.parse::<i64>().ok();
            if parse(&text) != expected {
                wrong.push(format!("{text:?}: {:?} vs {expected:?}", parse(&text)));
            }
            seen += 1;
        }
        assert!(
            wrong.is_empty(),
            "{} wrong: {:#?}",
            wrong.len(),
            wrong.iter().take(25).collect::<Vec<_>>()
        );
        assert!(seen > 5000, "{seen}");
    }

    #[test]
    fn clips_numbers_like_new_date() {
        assert_eq!(from_number(1.9), Some(1));
        assert_eq!(from_number(-1.9), Some(-1));
        assert_eq!(from_number(8.64e15), Some(8_640_000_000_000_000));
        assert_eq!(from_number(8.64e15 + 2.0), None);
        assert_eq!(from_number(f64::INFINITY), None);
    }
}
