package domain

import (
	"cmp"
	"slices"
	"strings"
	"unicode"
	"unicode/utf16"

	"golang.org/x/text/collate"
	"golang.org/x/text/language"
	"golang.org/x/text/unicode/norm"

	situations "github.com/Dreamcoder08/sipges/apps/api-go/internal/situations/domain"
)

// Stable per-project pseudonyms (docs/adr/0030). A pseudonym is a keyed hash of the kind and the
// folded name, so the same name always maps to the same short token inside one project and to a
// different one in another, and nothing has to be stored to keep it consistent. Mac carries the
// project key; this package never sees the key itself. Port of pseudonyms.ts.

// PseudonymKind is the kind of a pseudonym.
type PseudonymKind string

// The kinds of pseudonym.
const (
	Actor   PseudonymKind = "Actor"
	Persona PseudonymKind = "Persona"
	Org     PseudonymKind = "Org"
)

// KnownName is a name the project already knows, from its actors, contacts and responsible people.
type KnownName struct {
	Kind PseudonymKind
	Name string
}

// Mac is the keyed hash of a message as lowercase hex (HMAC-SHA256 under the project key).
type Mac func(message string) string

const (
	tokenHex = 6
	// minNameLength: shorter names would match inside ordinary words once folded.
	minNameLength = 3
	// maxFragment is the longest fragment of a name looked for next to a truncation mark.
	maxFragment     = 80
	minTailFragment = 3
	minHeadFragment = 4
	ellipsis        = 0x2026
)

// priority: an actor outranks a person, a person an organisation, when one name has several kinds.
var priority = map[PseudonymKind]int{Actor: 0, Persona: 1, Org: 2}

// foldRune is foldChar of pseudonyms.ts on one code point: its canonical decomposition without
// marks, in lower case. A decomposition never leaves a character whose lower case depends on what
// follows it, and U+0130, the only one that lowers to two, decomposes first.
func foldRune(r rune) string {
	if r < 0x80 {
		return string(unicode.ToLower(r))
	}
	var out strings.Builder
	for _, c := range decompose(r) {
		if !unicode.Is(unicode.M, c) {
			out.WriteRune(unicode.ToLower(c))
		}
	}
	return out.String()
}

// laterDecompositions are the canonical decompositions added by Unicode 16 and 17, which the tables
// of golang.org/x/text (Unicode 15) lack and ICU has. The fixture hashes every code point, so a
// library update that adds them keeps this harmless and any new gap fails the test.
var laterDecompositions = map[rune]string{
	0x105c9: "\U000105d2\u0307",
	0x105e4: "\U000105da\u0307",
	0x11383: "\U00011382\U000113c9",
	0x11385: "\U00011384\U000113bb",
	0x1138e: "\U0001138b\U000113c2",
	0x11391: "\U00011390\U000113c9",
	0x113c5: "\U000113c2\U000113c2",
	0x113c7: "\U000113c2\U000113b8",
	0x113c8: "\U000113c2\U000113c9",
	0x16121: "\U0001611e\U0001611e",
	0x16122: "\U0001611e\U00016129",
	0x16123: "\U0001611e\U0001611f",
	0x16124: "\U00016129\U0001611f",
	0x16125: "\U0001611e\U00016120",
	0x16126: "\U0001611e\U0001611e\U0001611f",
	0x16127: "\U0001611e\U00016129\U0001611f",
	0x16128: "\U0001611e\U0001611e\U00016120",
	0x16d68: "\U00016d67\U00016d67",
	0x16d69: "\U00016d63\U00016d67",
	0x16d6a: "\U00016d63\U00016d67\U00016d67",
}

func decompose(r rune) string {
	if d, ok := laterDecompositions[r]; ok {
		return d
	}
	return norm.NFD.String(string(r))
}

// FoldName gives a name's identity: lower case, no accents, single spaces.
func FoldName(name string) string {
	return fromUnits(trimRightUnits(trimLeftUnits(foldWithMap(toUnits(name)).text)))
}

// folded is a text folded like FoldName, with where each folded unit came from.
type folded struct {
	text         []uint16
	starts, ends []int
}

// foldWithMap folds text while remembering the source of every UTF-16 unit. Text cut at a unit can
// start or end in half a surrogate pair, which passes through unchanged as in JavaScript.
func foldWithMap(text []uint16) folded {
	var f folded
	for index := 0; index < len(text); {
		end := index + 1
		r := rune(text[index])
		lone := utf16.IsSurrogate(r)
		if lone && index+1 < len(text) {
			if pair := utf16.DecodeRune(r, rune(text[index+1])); pair != unicode.ReplacementChar {
				r, lone, end = pair, false, index+2
			}
		}
		switch {
		case lone:
			f.push(text[index], index, end)
		case situations.IsJSSpace(r):
			if n := len(f.text); n > 0 && f.text[n-1] == ' ' {
				f.ends[n-1] = end
			} else {
				f.push(' ', index, end)
			}
		default:
			for _, unit := range toUnits(foldRune(r)) {
				f.push(unit, index, end)
			}
		}
		index = end
	}
	return f
}

func (f *folded) push(unit uint16, start, end int) {
	f.text = append(f.text, unit)
	f.starts = append(f.starts, start)
	f.ends = append(f.ends, end)
}

// searchKey is a known name in the two forms the search needs.
type searchKey struct {
	text  string
	units []uint16
}

// Pseudonymiser replaces the names of one project. It is immutable once built.
type Pseudonymiser struct {
	mac        Mac
	kinds      map[string]PseudonymKind
	searchable []searchKey
}

// NewPseudonymiser builds the pseudonymiser of a project's known names.
func NewPseudonymiser(mac Mac, names []KnownName) *Pseudonymiser {
	kinds := make(map[string]PseudonymKind, len(names))
	keys := make([]string, 0, len(names))
	for _, known := range names {
		key := FoldName(known.Name)
		if key == "" {
			continue
		}
		current, ok := kinds[key]
		if !ok {
			keys = append(keys, key)
		}
		if !ok || priority[known.Kind] < priority[current] {
			kinds[key] = known.Kind
		}
	}
	searchable := make([]searchKey, 0, len(keys))
	for _, key := range keys {
		if units := toUnits(key); len(units) >= minNameLength {
			searchable = append(searchable, searchKey{key, units})
		}
	}
	// Longest first, so "Municipalidad de Sechura" wins over "Sechura". Same as Array.prototype.sort,
	// the sort is stable. A collator holds buffers, so each sort has its own.
	collator := collate.New(language.Und)
	slices.SortStableFunc(searchable, func(a, b searchKey) int {
		return cmp.Or(cmp.Compare(len(b.units), len(a.units)), collator.CompareString(a.text, b.text))
	})
	return &Pseudonymiser{mac: mac, kinds: kinds, searchable: searchable}
}

// Pseudonym is the token of name under kind.
func (p *Pseudonymiser) Pseudonym(kind PseudonymKind, name string) string {
	return string(kind) + "-" + strings.ToUpper(p.mac(string(kind) + "\x00" + WellFormed(FoldName(name)))[:tokenHex])
}

// KindOf is the kind the project registered for name, if it knows it.
func (p *Pseudonymiser) KindOf(name string) (PseudonymKind, bool) {
	kind, ok := p.kinds[FoldName(name)]
	return kind, ok
}

func (p *Pseudonymiser) pseudonymOfKey(key string) []uint16 {
	kind, ok := p.kinds[key]
	if !ok {
		kind = Persona
	}
	return toUnits(p.Pseudonym(kind, key))
}

type span struct {
	from, to int
	key      string
}

// replaceNames replaces every known name in text, whatever its case or accents.
func (p *Pseudonymiser) replaceNames(text string) string {
	if len(p.searchable) == 0 || text == "" {
		return text
	}
	units := toUnits(text)
	f := foldWithMap(units)
	haystack := fromUnits(f.text)
	var spans []span
	taken := func(from, to int) bool {
		return slices.ContainsFunc(spans, func(s span) bool { return from < s.to && to > s.from })
	}
	for _, key := range p.searchable {
		// Well-formed text holds a key's units only if it holds its bytes; this is the fast path.
		if !strings.Contains(haystack, key.text) {
			continue
		}
		for at := indexUnits(f.text, key.units, 0); at != -1; at = indexUnits(f.text, key.units, at+1) {
			to := at + len(key.units)
			if isWordAt(f.text, at-1) || isWordAt(f.text, to) || taken(at, to) {
				continue
			}
			spans = append(spans, span{at, to, key.text})
		}
	}
	if len(spans) == 0 {
		return text
	}
	slices.SortFunc(spans, func(a, b span) int { return cmp.Compare(a.from, b.from) })
	out := make([]uint16, 0, len(units))
	cursor := 0
	for _, s := range spans {
		out = append(out, units[cursor:f.starts[s.from]]...)
		out = append(out, p.pseudonymOfKey(s.key)...)
		cursor = f.ends[s.to-1]
	}
	return fromUnits(append(out, units[cursor:]...))
}

// closingMark is /\s*…\s*$/.exec(text)?.index, -1 without a match.
func closingMark(text []uint16) int {
	trimmed := trimRightUnits(text)
	if len(trimmed) == 0 || trimmed[len(trimmed)-1] != ellipsis {
		return -1
	}
	return len(trimRightUnits(trimmed[:len(trimmed)-1]))
}

// openingMark is the length of /^\s*…\s*/.exec(text)?.[0], -1 without a match.
func openingMark(text []uint16) int {
	trimmed := trimLeftUnits(text)
	if len(trimmed) == 0 || trimmed[0] != ellipsis {
		return -1
	}
	return len(text) - len(trimLeftUnits(trimmed[1:]))
}

func concatUnits(parts ...[]uint16) []uint16 { return slices.Concat(parts...) }

// replaceFragments handles a title or excerpt cut by the ontology (…), which can hold half a name:
// «Marcos Villan…» or «…eva Prado». A fragment that starts a known name, right before a closing
// mark, or ends one, right after an opening mark, is replaced by that name's pseudonym.
func (p *Pseudonymiser) replaceFragments(text string) string {
	out := toUnits(text)
	if at := closingMark(out); at != -1 {
		out = p.replaceClosing(out, at)
	}
	if length := openingMark(out); length != -1 {
		out = p.replaceOpening(out, length)
	}
	return fromUnits(out)
}

func (p *Pseudonymiser) replaceClosing(text []uint16, mark int) []uint16 {
	before := text[:mark]
	offset := max(0, len(before)-maxFragment)
	f := foldWithMap(before[offset:])
	for at := range f.text {
		if isWordAt(f.text, at-1) {
			continue
		}
		fragment := trimRightUnits(f.text[at:])
		if len(fragment) < minTailFragment {
			break
		}
		index := slices.IndexFunc(p.searchable, func(k searchKey) bool {
			return len(k.units) > len(fragment) && hasPrefixUnits(k.units, fragment)
		})
		if index == -1 {
			continue
		}
		return concatUnits(before[:offset+f.starts[at]], p.pseudonymOfKey(p.searchable[index].text), text[mark:])
	}
	return text
}

func (p *Pseudonymiser) replaceOpening(text []uint16, length int) []uint16 {
	after := text[length:]
	f := foldWithMap(after[:min(len(after), maxFragment)])
	for to := len(f.text); to >= minHeadFragment; to-- {
		if isWordAt(f.text, to) {
			continue
		}
		fragment := trimLeftUnits(f.text[:to])
		if len(fragment) < minHeadFragment {
			break
		}
		index := slices.IndexFunc(p.searchable, func(k searchKey) bool {
			return len(k.units) > len(fragment) && hasSuffixUnits(k.units, fragment)
		})
		if index == -1 {
			continue
		}
		return concatUnits(text[:length], p.pseudonymOfKey(p.searchable[index].text), after[f.ends[to-1]:])
	}
	return text
}

// Scrub is free text without contact data or any name the project knows, even half of one.
func (p *Pseudonymiser) Scrub(text string) string {
	return p.replaceFragments(p.replaceNames(ScrubTruncated(ScrubPatterns(text))))
}
