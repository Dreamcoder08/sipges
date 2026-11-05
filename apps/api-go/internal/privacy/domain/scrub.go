package domain

import (
	"regexp"
	"strings"
	"unicode/utf8"
)

// Contact and identity numbers in free text, replaced by typed placeholders (docs/adr/0030). Pure
// and deliberately conservative: a Peruvian DNI is only recognised next to the word that names it,
// because eight digits alone are as likely to be an amount.
//
// Port of scrub.ts. RE2 has no lookaround, so an expression that needs one runs from candidate
// positions chosen by hand (see scanner), and its trailing (?!\d) consumes the next character
// without keeping it. RE2 and a backtracking engine prefer the same alternative at every choice
// point, so the same text gives the same match.

// The placeholders of scrub.ts.
const (
	PlaceholderEmail = "[correo]"
	PlaceholderPhone = "[teléfono]"
	PlaceholderDNI   = "[DNI]"
	PlaceholderRUC   = "[RUC]"
)

// jsSpace is JavaScript's \s, for use inside a character class.
const jsSpace = `\t\n\x0b\f\r \x{a0}\x{1680}\x{2000}-\x{200a}\x{2028}\x{2029}\x{202f}\x{205f}\x{3000}\x{feff}`

// compile builds an expression where ~ inside a character class stands for \s.
func compile(expression string) *regexp.Regexp {
	return regexp.MustCompile(strings.ReplaceAll(expression, "~", jsSpace))
}

// compileAnchored builds a scanner expression: group 1 is what the match keeps, group 2 the rest
// of it, and the end checks (?!\d).
func compileAnchored(kept, replaced string) *regexp.Regexp {
	return compile(`\A(` + kept + `)(` + replaced + `)(?:[^0-9]|\z)`)
}

// scanner replaces every match of re, tried only where first holds for the rune and before for
// the rune preceding it: the lookbehind or \b that RE2 cannot express from a mid-string position.
type scanner struct {
	re          *regexp.Regexp
	first       string
	before      func(previous rune, atStart bool) bool
	placeholder string
}

func (s scanner) replace(text string) string {
	var out strings.Builder
	cursor, i := 0, 0
	previous, atStart := rune(0), true
	for i < len(text) {
		r, size := utf8.DecodeRuneInString(text[i:])
		if strings.ContainsRune(s.first, r) && s.before(previous, atStart) {
			if m := s.re.FindStringSubmatchIndex(text[i:]); m != nil {
				out.WriteString(text[cursor : i+m[3]])
				out.WriteString(s.placeholder)
				i += m[5]
				cursor = i
				previous, _ = utf8.DecodeLastRuneInString(text[:i])
				atStart = false
				continue
			}
		}
		previous, atStart = r, false
		i += size
	}
	out.WriteString(text[cursor:])
	return out.String()
}

// notAfterWord is (?<![\p{L}\p{N}]).
func notAfterWord(previous rune, atStart bool) bool { return atStart || !isWord(previous) }

// wordBoundary is \b before an ASCII letter under the i and u flags: besides ASCII word characters,
// the two that fold into ASCII (U+017F, U+212A) are word characters. Accented letters are not.
func wordBoundary(previous rune, atStart bool) bool {
	if atStart {
		return true
	}
	ascii := previous >= '0' && previous <= '9' || previous >= 'A' && previous <= 'Z' ||
		previous >= 'a' && previous <= 'z' || previous == '_'
	return !ascii && previous != 0x17f && previous != 0x212a
}

var (
	email = compile(`[\p{L}\p{N}._%+-]+@[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)+`)

	dni = scanner{
		re: compileAnchored(
			`(?i:(?:d\.?[~]?n\.?[~]?i\.?|documento(?:[~]+(?:nacional[~]+)?de[~]+identidad)?|doc\.?(?:[~]+de[~]+identidad)?)`+
				`[~]*(?:n\.?[~]?[°ºo]?\.?[~]*|nro\.?[~]*|n[uú]mero[~]*)?[:#-]?[~]*)`,
			`[0-9]{8}`),
		first: "dD", before: wordBoundary, placeholder: PlaceholderDNI,
	}
	ruc = scanner{
		re:    compileAnchored(`(?i:ruc)[~]*[:#-]?[~]*`, `[0-9]{11}`),
		first: "rR", before: wordBoundary, placeholder: PlaceholderRUC,
	}
	// Mobile (9 digits starting with 9, optional +51 / 0051) and landlines with an area code.
	mobile = scanner{
		re:    compileAnchored(``, `(?:(?:\+|00)[~]?51[~.-]?)?9(?:[~.-]?[0-9]){8}`),
		first: "+09", before: notAfterWord, placeholder: PlaceholderPhone,
	}
	landlineParens = scanner{
		re:    compileAnchored(``, `\(0?[0-9]{1,2}\)[~.-]?[0-9]{3}[~.-]?[0-9]{3,4}`),
		first: "(", before: notAfterWord, placeholder: PlaceholderPhone,
	}
	landlineDashed = scanner{
		re:    compileAnchored(``, `0[0-9]{1,2}[~.-][0-9]{6,7}`),
		first: "0", before: notAfterWord, placeholder: PlaceholderPhone,
	}

	// The ontology cuts titles and search excerpts with a «…», which can leave half an email or a
	// phone number at the edge. Group 1 is the run; the tail is the (?=\s*…\s*$) of scrub.ts.
	partialEmail     = compile(`([\p{L}\p{N}._%+-]+@[\p{L}\p{N}.-]*)[~]*…[~]*\z`)
	digitsBeforeMark = compile(`([0-9][0-9~.-]*[0-9])[~]*…[~]*\z`)
	digitsAfterMark  = compile(`\A[~]*…[~]*([0-9][0-9~.-]*[0-9])`)
)

const minEdgeDigits = 5

// ScrubPatterns replaces whole emails, identity numbers and phone numbers.
func ScrubPatterns(text string) string {
	text = email.ReplaceAllLiteralString(text, PlaceholderEmail)
	for _, s := range []scanner{dni, ruc, mobile, landlineParens, landlineDashed} {
		text = s.replace(text)
	}
	return text
}

// replaceGroup replaces group 1 of the first match of re with what replacement returns for it.
func replaceGroup(text string, re *regexp.Regexp, replacement func(run string) string) string {
	m := re.FindStringSubmatchIndex(text)
	if m == nil {
		return text
	}
	return text[:m[2]] + replacement(text[m[2]:m[3]]) + text[m[3]:]
}

// edgeDigits clears a run of digits touching a truncation mark, when it is long enough.
func edgeDigits(run string) string {
	digits := 0
	for i := range len(run) {
		if run[i] >= '0' && run[i] <= '9' {
			digits++
		}
	}
	if digits >= minEdgeDigits {
		return PlaceholderPhone
	}
	return run
}

// ScrubTruncated clears what a cut leaves of an email or a phone number: an unfinished address
// before the mark, and a run of five or more digits touching it.
func ScrubTruncated(text string) string {
	text = replaceGroup(text, partialEmail, func(string) string { return PlaceholderEmail })
	text = replaceGroup(text, digitsBeforeMark, edgeDigits)
	return replaceGroup(text, digitsAfterMark, edgeDigits)
}
