//! `JSON.parse` and `JSON.stringify` semantics the TypeScript tool relies on: every number is an
//! `f64` (an out-of-range literal becomes ±Infinity, which `JSON.stringify` writes as `null`), a
//! repeated key keeps its first position with the last value, and objects enumerate array-index
//! keys first. Lone surrogate escapes are refused (a Rust string cannot hold them).

use std::fmt::Write as _;

use sipges_indicators::js::number_to_string;

/// A parsed JSON value.
#[derive(Clone, Debug, PartialEq)]
pub enum Json {
    /// `null`.
    Null,
    /// `true` / `false`.
    Bool(bool),
    /// A number (possibly infinite after an overflowing literal).
    Num(f64),
    /// A string.
    Str(String),
    /// An array.
    Arr(Vec<Json>),
    /// An object in insertion order (repeated keys already merged).
    Obj(Vec<(String, Json)>),
}

/// `JSON.parse` failed: Node throws `SyntaxError`.
#[derive(Debug, PartialEq, Eq)]
pub struct SyntaxError;

struct Parser<'a> {
    bytes: &'a [u8],
    at: usize,
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

    fn literal(&mut self, word: &[u8], value: Json) -> Result<Json, SyntaxError> {
        if self.bytes.get(self.at..self.at + word.len()) == Some(word) {
            self.at += word.len();
            Ok(value)
        } else {
            Err(SyntaxError)
        }
    }

    fn value(&mut self, depth: usize) -> Result<Json, SyntaxError> {
        if depth > 100_000 {
            return Err(SyntaxError);
        }
        self.skip_ws();
        match self.peek().ok_or(SyntaxError)? {
            b'n' => self.literal(b"null", Json::Null),
            b't' => self.literal(b"true", Json::Bool(true)),
            b'f' => self.literal(b"false", Json::Bool(false)),
            b'"' => self.string().map(Json::Str),
            b'[' => {
                self.at += 1;
                let mut items = Vec::new();
                self.skip_ws();
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
                        _ => return Err(SyntaxError),
                    }
                }
            }
            b'{' => {
                self.at += 1;
                let mut entries: Vec<(String, Json)> = Vec::new();
                self.skip_ws();
                if self.peek() == Some(b'}') {
                    self.at += 1;
                    return Ok(Json::Obj(entries));
                }
                loop {
                    self.skip_ws();
                    if self.peek() != Some(b'"') {
                        return Err(SyntaxError);
                    }
                    let key = self.string()?;
                    self.skip_ws();
                    if self.peek() != Some(b':') {
                        return Err(SyntaxError);
                    }
                    self.at += 1;
                    let value = self.value(depth + 1)?;
                    match entries.iter_mut().find(|(k, _)| *k == key) {
                        Some(slot) => slot.1 = value,
                        None => entries.push((key, value)),
                    }
                    self.skip_ws();
                    match self.peek() {
                        Some(b',') => self.at += 1,
                        Some(b'}') => {
                            self.at += 1;
                            return Ok(Json::Obj(entries));
                        }
                        _ => return Err(SyntaxError),
                    }
                }
            }
            b'-' | b'0'..=b'9' => self.number(),
            _ => Err(SyntaxError),
        }
    }

    fn digits(&mut self) -> usize {
        let start = self.at;
        while matches!(self.peek(), Some(b'0'..=b'9')) {
            self.at += 1;
        }
        self.at - start
    }

    fn number(&mut self) -> Result<Json, SyntaxError> {
        let start = self.at;
        if self.peek() == Some(b'-') {
            self.at += 1;
        }
        match self.peek() {
            Some(b'0') => self.at += 1,
            Some(b'1'..=b'9') => {
                self.digits();
            }
            _ => return Err(SyntaxError),
        }
        if self.peek() == Some(b'.') {
            self.at += 1;
            if self.digits() == 0 {
                return Err(SyntaxError);
            }
        }
        if matches!(self.peek(), Some(b'e' | b'E')) {
            self.at += 1;
            if matches!(self.peek(), Some(b'+' | b'-')) {
                self.at += 1;
            }
            if self.digits() == 0 {
                return Err(SyntaxError);
            }
        }
        let text = std::str::from_utf8(self.bytes.get(start..self.at).ok_or(SyntaxError)?)
            .map_err(|_| SyntaxError)?;
        // Rust's parse is correctly rounded and overflows to ±inf, like ECMAScript.
        text.parse::<f64>().map(Json::Num).map_err(|_| SyntaxError)
    }

    fn hex4(&mut self) -> Result<u32, SyntaxError> {
        let text = self.bytes.get(self.at..self.at + 4).ok_or(SyntaxError)?;
        if !text.iter().all(u8::is_ascii_hexdigit) {
            return Err(SyntaxError);
        }
        self.at += 4;
        let text = std::str::from_utf8(text).map_err(|_| SyntaxError)?;
        u32::from_str_radix(text, 16).map_err(|_| SyntaxError)
    }

    fn string(&mut self) -> Result<String, SyntaxError> {
        self.at += 1;
        let mut out = Vec::new();
        loop {
            let byte = self.peek().ok_or(SyntaxError)?;
            self.at += 1;
            match byte {
                b'"' => return String::from_utf8(out).map_err(|_| SyntaxError),
                0x00..=0x1F => return Err(SyntaxError),
                b'\\' => {
                    let escape = self.peek().ok_or(SyntaxError)?;
                    self.at += 1;
                    let c = match escape {
                        b'"' => '"',
                        b'\\' => '\\',
                        b'/' => '/',
                        b'b' => '\u{8}',
                        b'f' => '\u{c}',
                        b'n' => '\n',
                        b'r' => '\r',
                        b't' => '\t',
                        b'u' => {
                            let unit = self.hex4()?;
                            let code = if (0xD800..0xDC00).contains(&unit) {
                                if self.bytes.get(self.at..self.at + 2) != Some(b"\\u") {
                                    return Err(SyntaxError);
                                }
                                self.at += 2;
                                let low = self.hex4()?;
                                if !(0xDC00..0xE000).contains(&low) {
                                    return Err(SyntaxError);
                                }
                                0x10000 + ((unit - 0xD800) << 10) + (low - 0xDC00)
                            } else {
                                unit
                            };
                            char::from_u32(code).ok_or(SyntaxError)?
                        }
                        _ => return Err(SyntaxError),
                    };
                    let mut buf = [0; 4];
                    out.extend_from_slice(c.encode_utf8(&mut buf).as_bytes());
                }
                other => out.push(other),
            }
        }
    }
}

/// `JSON.parse(text)`.
///
/// # Errors
/// Invalid JSON, or a lone surrogate escape (accepted by JavaScript, refused here).
pub fn parse(text: &str) -> Result<Json, SyntaxError> {
    let mut parser = Parser {
        bytes: text.as_bytes(),
        at: 0,
    };
    let value = parser.value(0)?;
    parser.skip_ws();
    if parser.at == parser.bytes.len() {
        Ok(value)
    } else {
        Err(SyntaxError)
    }
}

/// Whether `key` is an array index, which JavaScript enumerates first.
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

/// `Object.entries` order.
#[must_use]
pub fn entries(object: &[(String, Json)]) -> Vec<&(String, Json)> {
    let mut indexed: Vec<(u32, &(String, Json))> = Vec::new();
    let mut named = Vec::with_capacity(object.len());
    for entry in object {
        match array_index(&entry.0) {
            Some(i) => indexed.push((i, entry)),
            None => named.push(entry),
        }
    }
    indexed.sort_by_key(|(i, _)| *i);
    indexed.into_iter().map(|(_, e)| e).chain(named).collect()
}

/// `QuoteJSONString`.
pub fn write_string(out: &mut String, s: &str) {
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

/// `JSON.stringify` of a number.
#[must_use]
pub fn number(x: f64) -> String {
    if x.is_finite() {
        number_to_string(x)
    } else {
        "null".into()
    }
}

/// `JSON.stringify(value)`.
pub fn write_json(out: &mut String, value: &Json) {
    match value {
        Json::Null => out.push_str("null"),
        Json::Bool(b) => out.push_str(if *b { "true" } else { "false" }),
        Json::Num(x) => out.push_str(&number(*x)),
        Json::Str(s) => write_string(out, s),
        Json::Arr(items) => {
            out.push('[');
            for (i, item) in items.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                write_json(out, item);
            }
            out.push(']');
        }
        Json::Obj(object) => {
            out.push('{');
            for (i, (key, item)) in entries(object).into_iter().enumerate() {
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

/// `JSON.stringify(value)` as a string.
#[must_use]
pub fn stringify(value: &Json) -> String {
    let mut out = String::new();
    write_json(&mut out, value);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_like_json_parse() {
        // JSON.stringify(JSON.parse(text)) observed in Node 22.
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
            (r#"" \u00e9\ud83d\ude00\/""#, r#"" é😀/""#),
            (" \t\n[]\r ", "[]"),
        ];
        for (text, expected) in cases {
            assert_eq!(
                parse(text).map(|v| stringify(&v)).as_deref(),
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
            "\"\\ud800\"",
            "NaN",
        ] {
            assert_eq!(parse(bad), Err(SyntaxError), "{bad:?}");
        }
    }
}
