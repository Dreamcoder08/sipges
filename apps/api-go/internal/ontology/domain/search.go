package domain

import (
	"bytes"
	"encoding/json"
	"regexp"
	"slices"
	"strings"

	"golang.org/x/text/unicode/norm"

	js "github.com/Dreamcoder08/sipges/apps/api-go/internal/situations/domain"
)

// Payload is a record's stored JSON object, numbers kept as json.Number.
type Payload map[string]any

// DecodePayload reads a jsonb payload; anything but an object reads as an empty one.
func DecodePayload(raw []byte) (Payload, error) {
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.UseNumber()
	var v any
	if err := dec.Decode(&v); err != nil {
		return nil, err
	}
	if p, ok := v.(map[string]any); ok {
		return p, nil
	}
	return Payload{}, nil
}

// FoldText is foldText of search.ts: toLowerCase, NFD, without U+0300–U+036F (the folding of
// the record_search_text SQL function).
func FoldText(s string) string {
	decomposed := norm.NFD.String(js.LowerJS(s))
	return strings.Map(func(r rune) rune {
		if r >= 0x300 && r <= 0x36f {
			return -1
		}
		return r
	}, decomposed)
}

// MaxSearchTerms is MAX_SEARCH_TERMS.
const MaxSearchTerms = 8

var termPattern = regexp.MustCompile(`[a-z0-9]+`)

// SearchTerms is searchTerms: the distinct ASCII words of the folded query, in order, at least
// two characters (or one digit), at most MaxSearchTerms.
func SearchTerms(raw string) []string {
	terms := []string{}
	for _, term := range termPattern.FindAllString(FoldText(raw), -1) {
		if slices.Contains(terms, term) {
			continue
		}
		terms = append(terms, term)
	}
	kept := []string{}
	for _, term := range terms {
		if len(term) >= 2 || (term[0] >= '0' && term[0] <= '9') {
			kept = append(kept, term)
		}
	}
	return kept[:min(len(kept), MaxSearchTerms)]
}

// ToPrefixQuery is toPrefixQuery: every term as a prefix, all required; nil when empty.
func ToPrefixQuery(terms []string) *string {
	if len(terms) == 0 {
		return nil
	}
	parts := make([]string, len(terms))
	for i, term := range terms {
		parts[i] = term + ":*"
	}
	q := strings.Join(parts, " & ")
	return &q
}

// Match is the field that explains a search hit and an excerpt around the term.
type Match struct {
	Field   string `json:"field"`
	Excerpt Text   `json:"excerpt"`
}

// scalarText is String(value) for the values matchExcerpt reads: strings and numbers.
func scalarText(v any) (string, bool) {
	switch x := v.(type) {
	case string:
		return x, true
	case json.Number:
		return js.JSString(x), true
	}
	return "", false
}

// MatchExcerpt is matchExcerpt: the first field (preferred ones, then the rest in code unit
// order) whose folded text contains a term, with 40 units before and 80 after it. The folded
// index cuts the original text, as in TypeScript, even where folding changed its length.
func MatchExcerpt(payload Payload, terms, preferred []string) *Match {
	keys := make([]string, 0, len(payload))
	for k := range payload {
		keys = append(keys, k)
	}
	slices.SortFunc(keys, func(a, b string) int {
		switch {
		case js.Less16(a, b):
			return -1
		case js.Less16(b, a):
			return 1
		}
		return 0
	})
	fields := make([]string, 0, len(preferred)+len(keys))
	for _, f := range append(slices.Clone(preferred), keys...) {
		if !slices.Contains(fields, f) {
			fields = append(fields, f)
		}
	}
	for _, field := range fields {
		value, present := payload[field]
		if !present {
			continue
		}
		text, ok := scalarText(value)
		if !ok {
			continue
		}
		units := UnitsOf(text)
		folded := UnitsOf(FoldText(text))
		at := -1
		for _, term := range terms {
			if i := folded.Index(UnitsOf(term)); i >= 0 {
				at = i
				break
			}
		}
		if at < 0 {
			continue
		}
		start := max(0, at-40)
		end := min(len(units), at+80)
		excerpt := Units{}
		if start > 0 {
			excerpt = append(excerpt, '…')
		}
		excerpt = append(excerpt, units.Slice(start, end).Trim()...)
		if end < len(units) {
			excerpt = append(excerpt, '…')
		}
		return &Match{Field: field, Excerpt: excerpt.Text()}
	}
	return nil
}

// HoldsTerms says whether the strings and numbers of payload, folded, hold every term. Terms are
// ASCII words, so none can span two values.
func HoldsTerms(payload Payload, terms []string) bool {
	values := make([]string, 0, len(payload))
	for _, value := range payload {
		if text, ok := scalarText(value); ok {
			values = append(values, text)
		}
	}
	folded := FoldText(strings.Join(values, " "))
	for _, term := range terms {
		if !strings.Contains(folded, term) {
			return false
		}
	}
	return true
}

var (
	isoDay   = regexp.MustCompile(`^\d{4}-\d{2}-\d{2}$`)
	isoYear  = regexp.MustCompile(`^\d{4}$`)
	isoMonth = regexp.MustCompile(`^\d{4}-(0[1-9]|1[0-2])$`)
)

// DayBound is dayBound of ontology-service.ts: yyyy, yyyy-mm or yyyy-mm-dd expanded to the
// first (or, with end, last) day it covers; an empty value is unbounded; false when invalid.
func DayBound(value string, end bool) (string, bool) {
	trimmed := js.TrimJS(value)
	pick := func(first, last string) string {
		if end {
			return last
		}
		return first
	}
	switch {
	case trimmed == "":
		return pick("0000-01-01", "9999-12-31"), true
	case isoYear.MatchString(trimmed):
		return trimmed + "-" + pick("01-01", "12-31"), true
	case isoMonth.MatchString(trimmed):
		return trimmed + "-" + pick("01", "31"), true
	case isoDay.MatchString(trimmed):
		return trimmed, true
	}
	return "", false
}
