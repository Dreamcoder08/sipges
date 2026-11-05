package domain

import (
	"regexp"
	"slices"
	"strconv"
	"strings"
)

const maxNarrative = 4000

var citation = regexp.MustCompile(`\[([0-9]{1,4})\]`)

// BriefingText is briefingText of briefing.ts: all a narrator ever reads.
func BriefingText(b Briefing) string {
	lines := []string{}
	for _, section := range b.Sections {
		lines = append(lines, "## "+section.Title)
		for _, sentence := range section.Sentences {
			line := "- " + sentence.Text
			if len(sentence.Refs) > 0 {
				line += " " + refMarks(sentence.Refs)
			}
			lines = append(lines, line)
		}
	}
	lines = append(lines, "## Fuentes")
	for _, source := range b.Sources {
		lines = append(lines, "["+strconv.Itoa(source.Ref)+"] "+source.TypeLabel+" "+source.ID+": "+quote(source.Title))
	}
	return strings.Join(lines, "\n")
}

func refMarks(refs []int) string {
	marks := make([]string, len(refs))
	for i, ref := range refs {
		marks[i] = "[" + strconv.Itoa(ref) + "]"
	}
	return strings.Join(marks, " ")
}

// TrimNarrative is trim().slice(0, 4000): UTF-16 units, so the cut can leave half an emoji.
func TrimNarrative(prose string) string {
	return slice16(trimJS(prose), 0, maxNarrative)
}

// CitedRefs is citedRefs: the numbers a text cites in order, each once; ok is false when it cites a
// source the briefing lacks.
func CitedRefs(text string, b Briefing) (refs []int, ok bool) {
	for _, match := range citation.FindAllStringSubmatch(text, -1) {
		ref, err := strconv.Atoi(match[1])
		if err != nil {
			return nil, false
		}
		if !slices.ContainsFunc(b.Sources, func(s Source) bool { return s.Ref == ref }) {
			return nil, false
		}
		if !slices.Contains(refs, ref) {
			refs = append(refs, ref)
		}
	}
	slices.Sort(refs)
	return refs, true
}

// RenumberCitations rewrites the text and its refs from shared's numbers onto full's, record by
// record. A citation of a record full lacks reads [0], as in TypeScript.
func RenumberCitations(text string, refs []int, shared, full Briefing) (string, []int) {
	onto := func(ref int) int {
		at := slices.IndexFunc(shared.Sources, func(s Source) bool { return s.Ref == ref })
		if at < 0 {
			return 0
		}
		source := shared.Sources[at]
		at = slices.IndexFunc(full.Sources, func(s Source) bool { return s.Slug == source.Slug && s.ID == source.ID })
		if at < 0 {
			return 0
		}
		return full.Sources[at].Ref
	}
	out := citation.ReplaceAllStringFunc(text, func(mark string) string {
		ref, err := strconv.Atoi(mark[1 : len(mark)-1])
		if err != nil {
			return "[0]"
		}
		return "[" + strconv.Itoa(onto(ref)) + "]"
	})
	moved := make([]int, len(refs))
	for i, ref := range refs {
		moved[i] = onto(ref)
	}
	return out, moved
}
