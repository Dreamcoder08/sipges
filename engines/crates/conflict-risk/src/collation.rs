//! `a.localeCompare(b, 'es')`: ICU's Spanish collation at its default tertiary strength, for the
//! repertoire the engine meets in locality and actor names.
//!
//! Each string is put in NFD and mapped to collation elements `(primary, secondary, tertiary)`;
//! strings compare by their primary weights, then secondary, then tertiary (the UCA sort key
//! order; ICU leaves the identical level off, so strings equal at tertiary compare equal).
//!
//! Exact repertoire (measured on Node's ICU, see `tables.rs`; `collation` pairs of the fixtures
//! re-check it): printable ASCII, the punctuation and symbols listed in `BASE`, `ñ`/`Ñ` (the
//! Spanish tailoring `&N<ñ<<<Ñ`, also as `n` + U+0303), the combining marks U+0300–U+036F (so
//! every Latin letter NFD decomposes onto ASCII), `ø đ ħ` (a letter plus a mark) and `æ œ ß`
//! (two letters with a ligature secondary). Outside it the order is approximate: a compatibility
//! variant (fullwidth `Ａ`, `ﬁ`, `ª`) weighs as its NFKD decomposition with a variant tertiary
//! weight (exact at the primary and secondary levels); other symbols (emoji) sort just before the
//! currency signs and letters of other scripts after the Latin ones, by code point (as ICU's
//! implicit weights do for Han); an unknown mark weighs as a secondary after the known ones.

use std::cmp::Ordering;

use unicode_normalization::UnicodeNormalization;
use unicode_normalization::char::canonical_combining_class;

use crate::tables::{BASE, IGNORABLE, MARKS};

/// Table primary ranks are spread by this step, leaving room below each for unknown characters.
const STEP: u32 = 0x0020_0000;
/// Primary weight of unknown letters and digits: above every table rank.
const UNKNOWN_ALNUM: u32 = 0xF000_0000;
/// Secondary weight of marks outside the repertoire: above every table rank.
const UNKNOWN_SECONDARY: u32 = 0x0100_0000;

#[derive(Debug, Clone, Copy)]
struct Element {
    primary: u32,
    secondary: u32,
    tertiary: u32,
}

fn base(c: char) -> Option<(u32, u32)> {
    BASE.binary_search_by(|&(k, _, _)| k.cmp(&c))
        .ok()
        .and_then(|i| BASE.get(i))
        .map(|&(_, p, t)| (p, t))
}

fn mark(c: char) -> Option<u32> {
    let cp = u32::from(c);
    MARKS
        .binary_search_by(|&(k, _)| k.cmp(&cp))
        .ok()
        .and_then(|i| MARKS.get(i))
        .map(|&(_, s)| s)
}

/// Removes the U+0303 that contracts with the `n` before `from`, when one is reachable: ICU also
/// matches it past intervening marks of a lower combining class (discontiguous contraction).
fn take_tilde(chars: &mut Vec<char>, from: usize) -> bool {
    let mut highest = 0;
    let mut j = from;
    while let Some(&m) = chars.get(j) {
        let ccc = canonical_combining_class(m);
        if ccc == 0 {
            return false;
        }
        if m == '\u{303}' && ccc > highest {
            chars.remove(j);
            return true;
        }
        highest = highest.max(ccc);
        j += 1;
    }
    false
}

/// Private-use stand-in for the secondary weight ICU gives the ligatures æ, œ and ß between their
/// two letters: above every combining mark.
const LIGATURE: char = '\u{E000}';

/// Latin letters ICU weighs as a base letter plus a secondary (ø = o + U+0338, đ = d + U+0335)
/// or as two letters with a ligature secondary between them (æ, œ, ß).
fn expansion(c: char) -> impl Iterator<Item = char> {
    let (a, b, z) = match c {
        'ø' => ('o', Some('\u{338}'), None),
        'Ø' => ('O', Some('\u{338}'), None),
        'đ' => ('d', Some('\u{335}'), None),
        'Đ' => ('D', Some('\u{335}'), None),
        'ħ' => ('h', Some('\u{335}'), None),
        'Ħ' => ('H', Some('\u{335}'), None),
        'æ' => ('a', Some(LIGATURE), Some('e')),
        'Æ' => ('A', Some(LIGATURE), Some('E')),
        'œ' => ('o', Some(LIGATURE), Some('e')),
        'Œ' => ('O', Some(LIGATURE), Some('E')),
        'ß' => ('s', Some(LIGATURE), Some('s')),
        c => (c, None, None),
    };
    std::iter::once(a).chain(b).chain(z)
}

/// How a character relates to the repertoire character it weighs as.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Variant {
    /// The character itself.
    None,
    /// A fullwidth form or one letter of a multi-letter compatibility decomposition (`ﬁ`).
    Wide,
    /// Any other single-letter compatibility form (`ª`, `ᵃ`, `²`).
    Super,
}

/// The element of a repertoire character. Tertiary weights follow ICU's interleaving
/// `a < ａ < A < Ａ < ª`: lowercase 0, its wide variant 1, uppercase 2, its wide variant 3,
/// superscript-like variants 4 and 5.
fn known(c: char, variant: Variant) -> Option<Element> {
    let v = u32::from(variant != Variant::None);
    if let Some((primary, tertiary)) = base(c) {
        Some(Element {
            primary: primary * STEP,
            secondary: 0,
            tertiary: match variant {
                Variant::None => tertiary * 2,
                Variant::Wide => tertiary * 2 + 1,
                Variant::Super => 4 + tertiary,
            },
        })
    } else if c == LIGATURE {
        Some(Element {
            primary: 0,
            secondary: MARKS.iter().map(|&(_, s)| s).max().unwrap_or(0) + 1,
            tertiary: v,
        })
    } else {
        mark(c).map(|secondary| Element {
            primary: 0,
            secondary,
            tertiary: v,
        })
    }
}

fn elements(s: &str) -> Vec<Element> {
    let mut chars: Vec<char> = s.nfd().flat_map(expansion).collect();
    let mut out = Vec::with_capacity(chars.len());
    let mut i = 0;
    while let Some(&c) = chars.get(i) {
        i += 1;
        let c = match c {
            'n' if take_tilde(&mut chars, i) => 'ñ',
            'N' if take_tilde(&mut chars, i) => 'Ñ',
            c => c,
        };
        if IGNORABLE.contains(&u32::from(c)) {
            continue;
        }
        if let Some(element) = known(c, Variant::None) {
            out.push(element);
            continue;
        }
        // A compatibility variant (fullwidth, ligature, superscript…) weighs as its NFKD
        // decomposition at the primary and secondary levels, with a variant tertiary weight.
        let decomposed: Vec<char> = std::iter::once(c).nfkd().collect();
        let kind = if decomposed.len() > 1 || ('\u{ff00}'..='\u{ffef}').contains(&c) {
            Variant::Wide
        } else {
            Variant::Super
        };
        let variant: Option<Vec<Element>> = (decomposed != [c])
            .then(|| {
                decomposed
                    .iter()
                    .filter(|d| !IGNORABLE.contains(&u32::from(**d)))
                    .map(|&d| known(d, kind))
                    .collect()
            })
            .flatten();
        if let Some(elements) = variant {
            out.extend(elements);
        } else if canonical_combining_class(c) != 0 || crate::text::is_mn(c) {
            out.push(Element {
                primary: 0,
                secondary: UNKNOWN_SECONDARY + u32::from(c),
                tertiary: 0,
            });
        } else {
            // Unknown symbols (emoji, dingbats, other punctuation) sort among the symbols, just
            // before the currency signs (the first is ¢); unknown letters and digits of other scripts after Latin.
            let primary = if c.is_alphanumeric() {
                UNKNOWN_ALNUM + u32::from(c)
            } else {
                base('¢')
                    .map_or(0, |(currency, _)| currency * STEP)
                    .saturating_sub(0x0011_0000)
                    + u32::from(c)
            };
            out.push(Element {
                primary,
                secondary: 0,
                tertiary: 0,
            });
        }
    }
    out
}

fn level(elements: &[Element], weight: fn(&Element) -> u32, skip_zero: bool) -> Vec<u32> {
    elements
        .iter()
        .map(weight)
        .filter(|&w| !skip_zero || w != 0)
        .collect()
}

/// `a.localeCompare(b, 'es')` as an ordering.
#[must_use]
pub fn compare(a: &str, b: &str) -> Ordering {
    if a == b {
        return Ordering::Equal;
    }
    let (ea, eb) = (elements(a), elements(b));
    level(&ea, |e| e.primary, true)
        .cmp(&level(&eb, |e| e.primary, true))
        .then_with(|| level(&ea, |e| e.secondary, false).cmp(&level(&eb, |e| e.secondary, false)))
        .then_with(|| level(&ea, |e| e.tertiary, false).cmp(&level(&eb, |e| e.tertiary, false)))
}
