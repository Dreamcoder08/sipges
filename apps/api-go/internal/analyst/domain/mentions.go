package domain

import (
	"regexp"
	"strings"
	"unicode"
	"unicode/utf8"

	"golang.org/x/text/unicode/norm"
)

// findMention of apps/api/src/contexts/ontology/domain/mentions.ts.

const (
	minTitleChars = 5
	excerptRadius = 60
)

var numericNeedle = regexp.MustCompile(`^(?:\pN|` + jsSpaceClass + `|-)+$`)

// foldText is foldText of ontology/domain/search.ts: lower case, NFD, without U+0300–U+036F.
func foldText(s string) string {
	decomposed := norm.NFD.String(lowerJS(s))
	return strings.Map(func(r rune) rune {
		if r >= 0x300 && r <= 0x36f {
			return -1
		}
		return r
	}, decomposed)
}

// TextFields is the textOf of mentions(): the payload's string values that are not blank, in
// order.
func TextFields(payload Payload) []Field {
	out := []Field{}
	for _, f := range payload {
		if s, ok := f.Value.(string); ok && trimJS(s) != "" {
			out = append(out, f)
		}
	}
	return out
}

// Mention is where a title appears in a record's text.
type Mention struct {
	Field   string
	Excerpt string
}

// FindMention is findMention: where title appears as whole words in one of fields (string
// values), with a short excerpt around it.
func FindMention(fields []Field, title string) (Mention, bool) {
	if hasSurrogate(title) {
		// A cut title ends in a lone surrogate, which well-formed stored text never holds.
		return Mention{}, false
	}
	needle := collapseSpaces(foldText(trimJS(title)))
	if len(codePoints(needle)) < minTitleChars || numericNeedle.MatchString(needle) {
		return Mention{}, false
	}
	words := strings.Split(needle, " ")
	for i, w := range words {
		words[i] = regexp.QuoteMeta(w)
	}
	pattern, err := regexp.Compile(strings.Join(words, jsSpaceClass+"+"))
	if err != nil {
		return Mention{}, false
	}
	for _, f := range fields {
		value, _ := f.Value.(string)
		source := norm.NFC.String(value)
		folded := foldText(source)
		from, to, ok := wholeWords(pattern, folded)
		if !ok {
			continue
		}
		at := 0
		if len16(folded) == len16(source) {
			at = len16(folded[:from])
		}
		sourceLen := len16(source)
		start := max(0, at-excerptRadius)
		end := min(sourceLen, at+len16(folded[from:to])+excerptRadius)
		excerpt := trimJS(slice16(source, start, end))
		if start > 0 {
			excerpt = "…" + excerpt
		}
		if end < sourceLen {
			excerpt += "…"
		}
		return Mention{Field: f.Key, Excerpt: excerpt}, true
	}
	return Mention{}, false
}

// wholeWords is the first match of pattern in s not preceded or followed by a letter or a
// number: the (?<![\p{L}\p{N}]) … (?![\p{L}\p{N}]) of the TypeScript pattern.
func wholeWords(pattern *regexp.Regexp, s string) (from, to int, ok bool) {
	for pos := 0; pos <= len(s); {
		m := pattern.FindStringIndex(s[pos:])
		if m == nil {
			return 0, 0, false
		}
		from, to = pos+m[0], pos+m[1]
		before, _ := utf8.DecodeLastRuneInString(s[:from])
		after, _ := utf8.DecodeRuneInString(s[to:])
		if (from == 0 || !isWordRune(before)) && (to == len(s) || !isWordRune(after)) {
			return from, to, true
		}
		_, size := utf8.DecodeRuneInString(s[from:])
		pos = from + max(size, 1)
	}
	return 0, 0, false
}

func isWordRune(r rune) bool { return unicode.IsLetter(r) || unicode.IsNumber(r) }
