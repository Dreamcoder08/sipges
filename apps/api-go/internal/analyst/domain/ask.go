package domain

import (
	"errors"
	"regexp"
	"slices"
	"strconv"
)

// The analyst's free-text answers (odd/archive/agentic-analyst.md S2): every record a tool returns
// gets a number, and an answer may cite only those numbers.

// RecordRef is a record a tool returned: enough to number it and link to its screen.
type RecordRef struct {
	Slug  string
	ID    string
	Title string
}

// Cited is a source an answer cites: its number and the record.
type Cited struct {
	N int
	RecordRef
}

// Sources numbers the records the tools returned during one question, from 1, each record once.
// The zero value is ready to use.
type Sources struct {
	refs []RecordRef
}

// Add numbers ref, or answers the number it already has.
func (s *Sources) Add(ref RecordRef) int {
	at := slices.IndexFunc(s.refs, func(r RecordRef) bool { return r.Slug == ref.Slug && r.ID == ref.ID })
	if at >= 0 {
		return at + 1
	}
	s.refs = append(s.refs, ref)
	return len(s.refs)
}

// All lists the numbered records; record n is at index n-1.
func (s *Sources) All() []RecordRef { return slices.Clone(s.refs) }

// CitedAnswer is an answer whose markers all resolve, with the records it cites by number and the
// blocks (blocks.go) the screen draws next to it.
type CitedAnswer struct {
	Text    string
	Sources []Cited
	Blocks  []Block
}

var (
	// ErrUnresolvedCitation is an answer citing a number no tool returned.
	ErrUnresolvedCitation = errors.New("analyst: the answer cites a record no tool returned")
	// ErrUncited is an answer that cites nothing although the tools returned records.
	ErrUncited = errors.New("analyst: the answer cites none of the records it read")
)

// askCitation is any bracketed number. The narrative's citation stops at four digits, as in
// TypeScript; here a longer number would stay in the text unchecked, so it is read and refused.
var askCitation = regexp.MustCompile(`\[([0-9]+)\]`)

// Cite checks text against the numbered records. Every marker must name a returned record; an
// answer that cites nothing is accepted only when the tools returned no record (it can then only
// say that nothing was found).
func Cite(text string, s *Sources) (CitedAnswer, error) {
	var numbers []int
	for _, match := range askCitation.FindAllStringSubmatch(text, -1) {
		n, err := strconv.Atoi(match[1])
		if err != nil || n < 1 || n > len(s.refs) {
			return CitedAnswer{}, ErrUnresolvedCitation
		}
		if !slices.Contains(numbers, n) {
			numbers = append(numbers, n)
		}
	}
	if len(numbers) == 0 && len(s.refs) > 0 {
		return CitedAnswer{}, ErrUncited
	}
	slices.Sort(numbers)
	cited := make([]Cited, 0, len(numbers))
	for _, n := range numbers {
		cited = append(cited, Cited{N: n, RecordRef: s.refs[n-1]})
	}
	return CitedAnswer{Text: text, Sources: cited}, nil
}
