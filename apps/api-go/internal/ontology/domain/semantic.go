package domain

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"math"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"unicode/utf8"

	js "github.com/Dreamcoder08/sipges/apps/api-go/internal/situations/domain"
)

// The bounds of ontology/domain/semantic.ts.
const (
	// MinSimilarity is the cosine below which a record is not related to the query.
	MinSimilarity      = 0.45
	rrfK               = 60
	maxTextCodePoints  = 4000
	maxArrayIndex      = 4294967294
	notAnObjectMessage = "ontology: unreadable payload"
)

// Cosine is cosine of semantic.ts.
func Cosine(a, b []float64) float64 {
	if len(a) != len(b) || len(a) == 0 {
		return 0
	}
	var dot, na, nb float64
	for i := range a {
		dot += a[i] * b[i]
		na += a[i] * a[i]
		nb += b[i] * b[i]
	}
	if na == 0 || nb == 0 {
		return 0
	}
	return dot / math.Sqrt(na*nb)
}

// FuseRankings fuses ranked key lists by reciprocal rank: an item high in either list ranks high,
// and one found by both ranks highest. Ties keep the first list's order.
func FuseRankings(lists [][]string, limit int) []string {
	score := map[string]float64{}
	keys := []string{}
	for _, list := range lists {
		for rank, key := range list {
			if _, seen := score[key]; !seen {
				keys = append(keys, key)
			}
			score[key] += 1 / float64(rrfK+rank+1)
		}
	}
	slices.SortStableFunc(keys, func(a, b string) int {
		switch {
		case score[a] > score[b]:
			return -1
		case score[a] < score[b]:
			return 1
		}
		return 0
	})
	return keys[:min(len(keys), limit)]
}

// Entry is one key of a payload.
type Entry struct {
	Name  string
	Value any
}

var arrayIndex = regexp.MustCompile(`^(0|[1-9][0-9]*)$`)

func indexOf(key string) (uint64, bool) {
	if !arrayIndex.MatchString(key) {
		return 0, false
	}
	index, err := strconv.ParseUint(key, 10, 64)
	return index, err == nil && index <= maxArrayIndex
}

// OrderedEntries reads a jsonb payload in the order JavaScript's Object.entries gives after
// JSON.parse: array indices ascending, then the other keys as stored. Numbers stay json.Number.
// Anything but an object reads as no entries.
func OrderedEntries(raw []byte) ([]Entry, error) {
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.UseNumber()
	open, err := dec.Token()
	if err != nil {
		return nil, err
	}
	if open != json.Delim('{') {
		return nil, nil
	}
	entries := []Entry{}
	for dec.More() {
		token, err := dec.Token()
		if err != nil {
			return nil, err
		}
		name, ok := token.(string)
		if !ok {
			return nil, errors.New(notAnObjectMessage)
		}
		var value any
		if err := dec.Decode(&value); err != nil {
			return nil, err
		}
		entries = append(entries, Entry{name, value})
	}
	if _, err := dec.Token(); err != nil {
		return nil, err
	}
	if _, err := dec.Token(); !errors.Is(err, io.EOF) {
		return nil, errors.New(notAnObjectMessage)
	}
	slices.SortStableFunc(entries, func(a, b Entry) int {
		ai, aIndex := indexOf(a.Name)
		bi, bIndex := indexOf(b.Name)
		switch {
		case aIndex && bIndex && ai < bi, aIndex && !bIndex:
			return -1
		case aIndex && bIndex && ai > bi, !aIndex && bIndex:
			return 1
		}
		return 0
	})
	return entries, nil
}

// EmbeddingText is embeddingText of semantic.ts: the record's type, title and every text field.
func EmbeddingText(typeLabel, title string, fields []Entry) string {
	lines := []string{typeLabel + ": " + title}
	for _, field := range fields {
		if text, ok := embeddable(field.Value); ok {
			lines = append(lines, field.Name+": "+text)
		}
	}
	return firstCodePoints(strings.Join(lines, "\n"), maxTextCodePoints)
}

// embeddable is a non-blank string, trimmed, or any number, as JavaScript writes it.
func embeddable(value any) (string, bool) {
	if text, ok := value.(string); ok {
		trimmed := js.TrimJS(text)
		return trimmed, trimmed != ""
	}
	if number, ok := js.Number(value); ok {
		return js.JSNumber(number), true
	}
	return "", false
}

// VectorText is the real[] literal of a vector: `{${vector.join(',')}}`, with JavaScript's numbers.
func VectorText(vector []float64) string {
	parts := make([]string, len(vector))
	for i, value := range vector {
		parts[i] = js.JSNumber(value)
	}
	return "{" + strings.Join(parts, ",") + "}"
}

// firstCodePoints is Array.from(text).slice(0, limit).join(""). A title cut in the middle of an emoji
// holds half of it as three bytes of WTF-8, which are one code point to JavaScript.
func firstCodePoints(text string, limit int) string {
	count := 0
	for i := 0; i < len(text); count++ {
		if count == limit {
			return text[:i]
		}
		if isSurrogate(text[i:]) {
			i += 3
			continue
		}
		_, size := utf8.DecodeRuneInString(text[i:])
		i += size
	}
	return text
}

func isSurrogate(s string) bool {
	return len(s) >= 3 && s[0] == 0xED && s[1] >= 0xA0
}
