package domain

import (
	"encoding/json"
	"regexp"
	"slices"
	"strings"
	"time"
	"unicode/utf8"
)

// Typed answer blocks (odd/tasks/agentic-analyst.md S3): next to its text, the analyst may ask the
// screen to show a record card, an alert card, a map focus or a timeline excerpt. The model names a
// kind and a source number, never markup; the screen draws each kind with its own components.
// A block is kept only when its kind is known, its source is a record a tool returned during this
// question and its fields are well formed; anything else is dropped, never an error.

// BlockKind is a kind of block the screen knows how to draw.
type BlockKind string

// The kinds: a record card, an alert card, the record on the map, a timeline excerpt.
const (
	BlockRecord   BlockKind = "record"
	BlockAlert    BlockKind = "alert"
	BlockMap      BlockKind = "map"
	BlockTimeline BlockKind = "timeline"
)

// MaxBlocks bounds the blocks of one answer; MaxExcerptEntries the events of one excerpt.
const (
	MaxBlocks         = 4
	MaxExcerptEntries = 5
	maxAlertText      = 280
	maxEntryText      = 160
)

// TimelineEntry is one dated event of a timeline excerpt.
type TimelineEntry struct {
	Date string
	Text string
}

// Block is a resolved block: its kind, the returned record it shows and, by kind, a short plain
// text (alert) or dated events (timeline).
type Block struct {
	Kind    BlockKind
	Source  Cited
	Text    string
	Entries []TimelineEntry
}

// The model writes blocks in a fenced section tagged «bloques», in Spanish like the rest of its
// instructions; an unclosed fence runs to the end of the answer.
var blockFence = regexp.MustCompile("(?s)```bloques[ \\t]*\\n?(.*?)(?:```|$)")

// SplitBlocks takes the blocks section out of the model's answer: the text the person reads and
// the raw blocks, empty when there are none.
func SplitBlocks(answer string) (text, raw string) {
	var sections []string
	text = blockFence.ReplaceAllStringFunc(answer, func(section string) string {
		sections = append(sections, strings.TrimSpace(blockFence.FindStringSubmatch(section)[1]))
		return ""
	})
	return strings.TrimSpace(text), strings.Join(sections, "\n")
}

var modelKinds = map[string]BlockKind{
	"registro":   BlockRecord,
	"alerta":     BlockAlert,
	"mapa":       BlockMap,
	"cronologia": BlockTimeline,
}

type modelBlock struct {
	Kind    string `json:"tipo"`
	Source  int    `json:"fuente"`
	Text    string `json:"texto"`
	Entries []struct {
		Date string `json:"fecha"`
		Text string `json:"texto"`
	} `json:"eventos"`
}

// ResolveBlocks reads raw (a JSON list) against the numbered records and keeps the well-formed
// blocks, at most MaxBlocks, each kind and record once.
func ResolveBlocks(raw string, s *Sources) []Block {
	var items []json.RawMessage
	if json.Unmarshal([]byte(raw), &items) != nil {
		return nil
	}
	var blocks []Block
	for _, item := range items {
		if len(blocks) == MaxBlocks {
			break
		}
		block, ok := resolveBlock(item, s)
		if !ok || slices.ContainsFunc(blocks, func(b Block) bool { return b.Kind == block.Kind && b.Source.N == block.Source.N }) {
			continue
		}
		blocks = append(blocks, block)
	}
	return blocks
}

func resolveBlock(item json.RawMessage, s *Sources) (Block, bool) {
	var m modelBlock
	if json.Unmarshal(item, &m) != nil {
		return Block{}, false
	}
	kind, known := modelKinds[m.Kind]
	if !known || m.Source < 1 || m.Source > len(s.refs) {
		return Block{}, false
	}
	block := Block{Kind: kind, Source: Cited{N: m.Source, RecordRef: s.refs[m.Source-1]}}
	switch kind {
	case BlockAlert:
		text, ok := plain(m.Text, maxAlertText)
		if !ok {
			return Block{}, false
		}
		block.Text = text
	case BlockTimeline:
		for _, e := range m.Entries {
			if len(block.Entries) == MaxExcerptEntries {
				break
			}
			text, ok := plain(e.Text, maxEntryText)
			if _, err := time.Parse(time.DateOnly, e.Date); err != nil || !ok {
				continue
			}
			block.Entries = append(block.Entries, TimelineEntry{Date: e.Date, Text: text})
		}
		if len(block.Entries) == 0 {
			return Block{}, false
		}
	case BlockRecord, BlockMap:
	}
	return block, true
}

// plain is text on one line, 1 to limit characters; the screen shows it as text, never as markup.
func plain(text string, limit int) (string, bool) {
	text = strings.Join(strings.Fields(text), " ")
	n := utf8.RuneCountInString(text)
	return text, n >= 1 && n <= limit
}
