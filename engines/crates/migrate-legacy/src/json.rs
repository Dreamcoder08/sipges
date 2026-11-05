//! `JSON.parse`, `JSON.stringify` and the tool's `canonicalJson`, over JavaScript strings.
//!
//! Strings are UTF-16 code units, because `JSON.parse` keeps a lone surrogate escape (`"\ud800"`)
//! and the report's checksums depend on it. Every number is an `f64`: an overflowing literal is
//! ±Infinity, which `JSON.stringify` writes as `null`. A repeated key keeps its first position
//! with the last value, and array-index keys enumerate first.

use std::collections::HashMap;
use std::fmt::Write as _;

use sipges_indicators::js::number_to_string;

/// A JavaScript string.
pub type JsStr = Vec<u16>;

/// Nesting `JSON.parse` is followed to; beyond it the value counts as too deep.
const MAX_PARSE_DEPTH: usize = 100_000;

/// A parsed JSON value.
#[derive(Clone, Debug, PartialEq)]
pub enum Json {
    /// `null`.
    Null,
    /// `true` / `false`.
    Bool(bool),
    /// A number, possibly infinite.
    Num(f64),
    /// A string.
    Str(JsStr),
    /// An array.
    Arr(Vec<Json>),
    /// An object in insertion order, repeated keys already merged.
    Obj(Vec<(JsStr, Json)>),
}

impl Json {
    /// A string value.
    #[must_use]
    pub fn text(value: &str) -> Self {
        Self::Str(units(value))
    }

    /// A string or `null`.
    #[must_use]
    pub fn optional(value: Option<&str>) -> Self {
        value.map_or(Self::Null, Self::text)
    }

    /// An object from literal keys.
    #[must_use]
    pub fn object(entries: Vec<(&str, Self)>) -> Self {
        Self::Obj(entries.into_iter().map(|(k, v)| (units(k), v)).collect())
    }
}

/// A string's UTF-16 units.
#[must_use]
pub fn units(value: &str) -> JsStr {
    value.encode_utf16().collect()
}

/// Why `parse` returned no value.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ParseError {
    /// `JSON.parse` throws `SyntaxError`.
    Syntax,
    /// Deeper than this parser follows.
    TooDeep,
}

/// A parsed value and how deeply its containers nest.
#[derive(Clone, Debug, PartialEq)]
pub struct Parsed {
    /// The value.
    pub value: Json,
    /// Levels of nested arrays and objects.
    pub depth: usize,
}

struct Parser<'a> {
    bytes: &'a [u8],
    at: usize,
    deepest: usize,
}

impl Parser<'_> {
    fn peek(&self) -> Option<u8> {
        self.bytes.get(self.at).copied()
    }

    fn skip_ws(&mut self) {
        while matches!(self.peek(), Some(b' ' | b'\t' | b'\n' | b'\r')) {
            self.at += 1;
        }
    }

    fn literal(&mut self, word: &[u8], value: Json) -> Result<Json, ParseError> {
        if self.bytes.get(self.at..self.at + word.len()) == Some(word) {
            self.at += word.len();
            Ok(value)
        } else {
            Err(ParseError::Syntax)
        }
    }

    fn enter(&mut self, depth: usize) -> Result<(), ParseError> {
        self.deepest = self.deepest.max(depth + 1);
        if depth >= MAX_PARSE_DEPTH {
            return Err(ParseError::TooDeep);
        }
        self.at += 1;
        self.skip_ws();
        Ok(())
    }

    fn array(&mut self, depth: usize) -> Result<Json, ParseError> {
        self.enter(depth)?;
        let mut items = Vec::new();
        if self.peek() == Some(b']') {
            self.at += 1;
            return Ok(Json::Arr(items));
        }
        loop {
            items.push(self.value(depth + 1)?);
            self.skip_ws();
            match self.peek() {
                Some(b',') => self.at += 1,
                Some(b']') => {
                    self.at += 1;
                    return Ok(Json::Arr(items));
                }
                _ => return Err(ParseError::Syntax),
            }
        }
    }

    fn object(&mut self, depth: usize) -> Result<Json, ParseError> {
        self.enter(depth)?;
        let mut entries: Vec<(JsStr, Json)> = Vec::new();
        let mut positions: HashMap<JsStr, usize> = HashMap::new();
        if self.peek() == Some(b'}') {
            self.at += 1;
            return Ok(Json::Obj(entries));
        }
        loop {
            self.skip_ws();
            if self.peek() != Some(b'"') {
                return Err(ParseError::Syntax);
            }
            let key = self.string()?;
            self.skip_ws();
            if self.peek() != Some(b':') {
                return Err(ParseError::Syntax);
            }
            self.at += 1;
            let value = self.value(depth + 1)?;
            if let Some(slot) = positions.get(&key).and_then(|&at| entries.get_mut(at)) {
                slot.1 = value;
            } else {
                positions.insert(key.clone(), entries.len());
                entries.push((key, value));
            }
            self.skip_ws();
            match self.peek() {
                Some(b',') => self.at += 1,
                Some(b'}') => {
                    self.at += 1;
                    return Ok(Json::Obj(entries));
                }
                _ => return Err(ParseError::Syntax),
            }
        }
    }

    fn value(&mut self, depth: usize) -> Result<Json, ParseError> {
        self.skip_ws();
        match self.peek().ok_or(ParseError::Syntax)? {
            b'n' => self.literal(b"null", Json::Null),
            b't' => self.literal(b"true", Json::Bool(true)),
            b'f' => self.literal(b"false", Json::Bool(false)),
            b'"' => self.string().map(Json::Str),
            b'[' => self.array(depth),
            b'{' => self.object(depth),
            b'-' | b'0'..=b'9' => self.number(),
            _ => Err(ParseError::Syntax),
        }
    }

    fn digits(&mut self) -> usize {
        let start = self.at;
        while matches!(self.peek(), Some(b'0'..=b'9')) {
            self.at += 1;
        }
        self.at - start
    }

    fn number(&mut self) -> Result<Json, ParseError> {
        let start = self.at;
        if self.peek() == Some(b'-') {
            self.at += 1;
        }
        match self.peek() {
            Some(b'0') => self.at += 1,
            Some(b'1'..=b'9') => {
                self.digits();
            }
            _ => return Err(ParseError::Syntax),
        }
        if self.peek() == Some(b'.') {
            self.at += 1;
            if self.digits() == 0 {
                return Err(ParseError::Syntax);
            }
        }
        if matches!(self.peek(), Some(b'e' | b'E')) {
            self.at += 1;
            if matches!(self.peek(), Some(b'+' | b'-')) {
                self.at += 1;
            }
            if self.digits() == 0 {
                return Err(ParseError::Syntax);
            }
        }
        let text = self
            .bytes
            .get(start..self.at)
            .and_then(|bytes| std::str::from_utf8(bytes).ok())
            .ok_or(ParseError::Syntax)?;
        // Rust's parse is correctly rounded and overflows to ±inf, like ECMAScript.
        text.parse::<f64>()
            .map(Json::Num)
            .map_err(|_| ParseError::Syntax)
    }

    fn hex4(&mut self) -> Result<u16, ParseError> {
        let text = self
            .bytes
            .get(self.at..self.at + 4)
            .filter(|text| text.iter().all(u8::is_ascii_hexdigit))
            .and_then(|text| std::str::from_utf8(text).ok())
            .ok_or(ParseError::Syntax)?;
        self.at += 4;
        u16::from_str_radix(text, 16).map_err(|_| ParseError::Syntax)
    }

    /// The input is valid UTF-8, so raw runs between escapes convert directly.
    fn raw(&self, start: usize, out: &mut JsStr) -> Result<(), ParseError> {
        let run = self
            .bytes
            .get(start..self.at)
            .and_then(|bytes| std::str::from_utf8(bytes).ok())
            .ok_or(ParseError::Syntax)?;
        out.extend(run.encode_utf16());
        Ok(())
    }

    fn string(&mut self) -> Result<JsStr, ParseError> {
        self.at += 1;
        let mut out = Vec::new();
        let mut start = self.at;
        loop {
            let byte = self.peek().ok_or(ParseError::Syntax)?;
            match byte {
                b'"' => {
                    self.raw(start, &mut out)?;
                    self.at += 1;
                    return Ok(out);
                }
                0x00..=0x1F => return Err(ParseError::Syntax),
                b'\\' => {
                    self.raw(start, &mut out)?;
                    self.at += 1;
                    let escape = self.peek().ok_or(ParseError::Syntax)?;
                    self.at += 1;
                    let unit = match escape {
                        b'"' => 0x22,
                        b'\\' => 0x5C,
                        b'/' => 0x2F,
                        b'b' => 0x08,
                        b'f' => 0x0C,
                        b'n' => 0x0A,
                        b'r' => 0x0D,
                        b't' => 0x09,
                        b'u' => self.hex4()?,
                        _ => return Err(ParseError::Syntax),
                    };
                    out.push(unit);
                    start = self.at;
                }
                _ => self.at += 1,
            }
        }
    }
}

/// `JSON.parse(text)`.
///
/// # Errors
/// Invalid JSON, or nesting past 100,000 levels.
pub fn parse(text: &str) -> Result<Parsed, ParseError> {
    let mut parser = Parser {
        bytes: text.as_bytes(),
        at: 0,
        deepest: 0,
    };
    let value = parser.value(0)?;
    parser.skip_ws();
    if parser.at == parser.bytes.len() {
        Ok(Parsed {
            value,
            depth: parser.deepest,
        })
    } else {
        Err(ParseError::Syntax)
    }
}

/// Whether the text's first value is an object.
#[must_use]
pub fn opens_object(text: &str) -> bool {
    text.trim_start_matches([' ', '\t', '\n', '\r'])
        .starts_with('{')
}

/// `hasNul`: a NUL in any string or key.
#[must_use]
pub fn has_nul(value: &Json) -> bool {
    match value {
        Json::Str(text) => text.contains(&0),
        Json::Arr(items) => items.iter().any(has_nul),
        Json::Obj(entries) => entries
            .iter()
            .any(|(key, item)| key.contains(&0) || has_nul(item)),
        Json::Null | Json::Bool(_) | Json::Num(_) => false,
    }
}

/// Whether `key` is an array index, which JavaScript enumerates first.
fn array_index(key: &[u16]) -> Option<u32> {
    if key.is_empty() || key.len() > 10 {
        return None;
    }
    let mut number: u64 = 0;
    for unit in key {
        let digit = u8::try_from(*unit).ok().filter(u8::is_ascii_digit)?;
        number = number * 10 + u64::from(digit - b'0');
    }
    if key.len() > 1 && key.first() == Some(&0x30) {
        return None;
    }
    u32::try_from(number).ok().filter(|n| *n < u32::MAX)
}

/// `Object.entries` order.
fn entries(object: &[(JsStr, Json)]) -> Vec<&(JsStr, Json)> {
    let mut indexed: Vec<(u32, &(JsStr, Json))> = Vec::new();
    let mut named = Vec::with_capacity(object.len());
    for entry in object {
        match array_index(&entry.0) {
            Some(index) => indexed.push((index, entry)),
            None => named.push(entry),
        }
    }
    indexed.sort_by_key(|(index, _)| *index);
    indexed
        .into_iter()
        .map(|(_, entry)| entry)
        .chain(named)
        .collect()
}

/// `QuoteJSONString`: a lone surrogate comes out as an escape, so the result is always valid.
fn write_string(out: &mut String, text: &[u16]) {
    out.push('"');
    for decoded in char::decode_utf16(text.iter().copied()) {
        match decoded {
            Ok('"') => out.push_str("\\\""),
            Ok('\\') => out.push_str("\\\\"),
            Ok('\u{8}') => out.push_str("\\b"),
            Ok('\u{c}') => out.push_str("\\f"),
            Ok('\n') => out.push_str("\\n"),
            Ok('\r') => out.push_str("\\r"),
            Ok('\t') => out.push_str("\\t"),
            Ok(c) if u32::from(c) < 0x20 => {
                let _ = write!(out, "\\u{:04x}", u32::from(c));
            }
            Ok(c) => out.push(c),
            Err(lone) => {
                let _ = write!(out, "\\u{:04x}", lone.unpaired_surrogate());
            }
        }
    }
    out.push('"');
}

fn write_number(out: &mut String, x: f64) {
    if x.is_finite() {
        out.push_str(&number_to_string(x));
    } else {
        out.push_str("null");
    }
}

fn write_value(out: &mut String, value: &Json, sorted: bool) {
    match value {
        Json::Null => out.push_str("null"),
        Json::Bool(b) => out.push_str(if *b { "true" } else { "false" }),
        Json::Num(x) => write_number(out, *x),
        Json::Str(text) => write_string(out, text),
        Json::Arr(items) => {
            out.push('[');
            for (i, item) in items.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                write_value(out, item, sorted);
            }
            out.push(']');
        }
        Json::Obj(object) => {
            let mut ordered = entries(object);
            if sorted {
                ordered.sort_by(|a, b| a.0.cmp(&b.0));
            }
            out.push('{');
            for (i, (key, item)) in ordered.into_iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                write_string(out, key);
                out.push(':');
                write_value(out, item, sorted);
            }
            out.push('}');
        }
    }
}

/// `JSON.stringify(value)`.
#[must_use]
pub fn stringify(value: &Json) -> String {
    let mut out = String::new();
    write_value(&mut out, value, false);
    out
}

/// `canonicalJson(value)`: keys sorted by UTF-16 units at every level.
#[must_use]
pub fn canonical(value: &Json) -> String {
    let mut out = String::new();
    write_value(&mut out, value, true);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn value(text: &str) -> Result<Json, ParseError> {
        parse(text).map(|parsed| parsed.value)
    }

    #[test]
    fn parses_like_json_parse() {
        // JSON.stringify(JSON.parse(text)) observed in Node.
        let cases = [
            (r#"{"b":1,"a":2,"b":3}"#, r#"{"b":3,"a":2}"#),
            (
                r#"{"x":1,"2":0,"1":0,"01":0}"#,
                r#"{"1":0,"2":0,"x":1,"01":0}"#,
            ),
            (
                "[1e400,-1e400,1e-400,-0,2.50,12345678901234567890,1e21]",
                "[null,null,0,0,2.5,12345678901234567000,1e+21]",
            ),
            (r#"" é😀\/""#, r#"" é😀/""#),
            (r#""\ud800""#, r#""\ud800""#),
            (r#""a\ude00😀\ud83d""#, r#""a\ude00😀\ud83d""#),
            (r#""\ud83dA\u0001\u007f""#, "\"\\ud83dA\\u0001\u{7f}\""),
            (" \t\n[]\r ", "[]"),
        ];
        for (text, expected) in cases {
            assert_eq!(
                value(text).map(|v| stringify(&v)).as_deref(),
                Ok(expected),
                "{text}"
            );
        }
        for bad in [
            "",
            "[1,]",
            "{\"a\" 1}",
            "01",
            "1.",
            "-",
            "\"\u{1}\"",
            "\u{feff}{}",
            "[1] x",
            "NaN",
        ] {
            assert_eq!(value(bad), Err(ParseError::Syntax), "{bad:?}");
        }
    }

    #[test]
    fn canonical_sorts_by_utf16_units_at_every_level() {
        // U+FFEF sorts after an astral key by UTF-16 units, before it by code points.
        let parsed = value("{\"\u{ffef}\":1,\"😀\":2,\"a\":{\"z\":1,\"10\":2,\"9\":3}}");
        assert_eq!(
            parsed.map(|v| canonical(&v)).as_deref(),
            Ok("{\"a\":{\"10\":2,\"9\":3,\"z\":1},\"😀\":2,\"\u{ffef}\":1}")
        );
    }

    #[test]
    fn finds_nul_in_strings_and_keys() {
        assert_eq!(value(r#"{"a":["\u0000"]}"#).map(|v| has_nul(&v)), Ok(true));
        assert_eq!(value(r#"{"\u0000":1}"#).map(|v| has_nul(&v)), Ok(true));
        assert_eq!(value(r#"{"a":"b"}"#).map(|v| has_nul(&v)), Ok(false));
    }

    #[test]
    fn tells_objects_from_other_values() {
        assert!(opens_object(" \n{"));
        assert!(!opens_object("["));
        assert!(!opens_object("\u{a0}{"));
    }

    #[test]
    fn measures_nesting() {
        assert_eq!(parse("1").map(|p| p.depth), Ok(0));
        assert_eq!(parse(r#"[{"a":[]}]"#).map(|p| p.depth), Ok(3));
        let deep = format!("{}{}", "[".repeat(100_001), "]".repeat(100_001));
        let run = std::thread::Builder::new()
            .stack_size(256 * 1024 * 1024)
            .spawn(move || parse(&deep).map(|p| p.depth));
        let outcome = run.ok().and_then(|handle| handle.join().ok());
        assert_eq!(outcome, Some(Err(ParseError::TooDeep)));
    }
}
