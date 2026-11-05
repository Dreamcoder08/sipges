//! JavaScript string semantics the TypeScript tools rely on.

/// `String.prototype.trim` whitespace: ECMAScript `WhiteSpace` and `LineTerminator`.
///
/// Rust's `char::is_whitespace` differs: it includes U+0085 and excludes U+FEFF.
#[must_use]
pub const fn is_js_whitespace(c: char) -> bool {
    matches!(
        c,
        '\u{0009}'
            | '\u{000A}'
            | '\u{000B}'
            | '\u{000C}'
            | '\u{000D}'
            | '\u{0020}'
            | '\u{00A0}'
            | '\u{1680}'
            | '\u{2000}'
            ..='\u{200A}'
                | '\u{2028}'
                | '\u{2029}'
                | '\u{202F}'
                | '\u{205F}'
                | '\u{3000}'
                | '\u{FEFF}'
    )
}

/// `value.trim()`.
#[must_use]
pub fn trim(value: &str) -> &str {
    value.trim_matches(is_js_whitespace)
}

/// `value.length`: UTF-16 code units.
#[must_use]
pub fn utf16_len(value: &str) -> usize {
    value.encode_utf16().count()
}

/// `value.slice(0, units)` for a string whose cut never splits a surrogate pair, or the whole
/// prefix up to the last full character before `units` (JavaScript would keep half a pair;
/// a Rust string cannot hold it).
#[must_use]
pub fn slice_utf16(value: &str, units: usize) -> &str {
    let mut used = 0;
    for (index, c) in value.char_indices() {
        let next = used + c.len_utf16();
        if next > units {
            return value.get(..index).unwrap_or(value);
        }
        used = next;
    }
    value
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn trims_like_javascript() {
        assert_eq!(trim("\u{FEFF}\u{00A0} a \u{3000}\n"), "a");
        // NEL is not JavaScript whitespace.
        assert_eq!(trim("\u{0085}a\u{0085}"), "\u{0085}a\u{0085}");
        assert_eq!(trim(" \t "), "");
    }

    #[test]
    fn measures_utf16() {
        assert_eq!(utf16_len("año😀"), 5);
        assert_eq!(slice_utf16("ab😀c", 3), "ab");
        assert_eq!(slice_utf16("ab😀c", 4), "ab😀");
        assert_eq!(slice_utf16("abc", 120), "abc");
    }
}
