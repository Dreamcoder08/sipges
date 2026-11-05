// Package domain holds the pure rules of the document lab's verification inbox
// (apps/api/src/contexts/documents/domain/review.ts and review-records.ts) that its read route
// needs: page bounds, the records module an approved finding goes to and its record id.
//
//nolint:misspell // Spanish module slugs and labels, verbatim from the TypeScript API.
package domain

import (
	"bytes"
	"cmp"
	"encoding/json"
	"math"
	"slices"
	"strconv"
	"strings"
	"time"
	"unicode/utf16"
)

// Page bounds of GET /system/document-lab/review (DEFAULT_REVIEW_PAGE, MAX_REVIEW_PAGE).
const (
	DefaultReviewPage = 50
	MaxReviewPage     = 200
	// MaxSafeInteger is Number.MAX_SAFE_INTEGER, the largest offset the route accepts.
	MaxSafeInteger int64 = 1<<53 - 1
	// MaxRecordID is MAX_RECORD_ID of records/domain/modules.ts, in UTF-16 code units.
	MaxRecordID = 200
)

// ReviewItem is one stored finding of document_review.
type ReviewItem struct {
	ID           string
	ProjectID    string
	SourceFile   string
	SourceSHA256 string
	Location     string
	Theme        string
	Excerpt      string
	Action       string
	Status       string
	Reviewer     string
	Note         string
	CreatedAt    time.Time
	UpdatedAt    time.Time
}

// ReviewTarget is a records module by its URL slug and its screen label.
type ReviewTarget struct {
	Module string `json:"module"`
	Label  string `json:"label"`
}

var hechos = ReviewTarget{"hechos", "Hechos compartidos"}

// targets is TARGETS of review-records.ts: the lexical theme decides the module.
var targets = map[string]ReviewTarget{
	"Actor (extracción automática)":       {"actores", "Actores"},
	"Representatividad y gobernanza":      {"actores", "Actores"},
	"Demandas e intereses":                {"demandas", "Demandas"},
	"Compromisos y trazabilidad":          {"compromisos", "Compromisos"},
	"Controversias y hechos compartidos":  hechos,
	"Diálogo y construcción de consensos": {"dialogos", "Diálogos"},
	"Oportunidades de valor compartido":   {"oportunidades", "Valor compartido"},
	"Territorio y ambiente":               {"narrativas", "Narrativas"},
}

// ReviewTargetFor is reviewTarget: free themes go to «Hechos compartidos».
func ReviewTargetFor(theme string) ReviewTarget {
	if t, ok := targets[theme]; ok {
		return t
	}
	return hechos
}

// recordModules is the part of records MODULES (slug → stored module) a target can name.
var recordModules = map[string]string{
	"actores":       "Actores",
	"demandas":      "Demandas",
	"compromisos":   "Compromisos",
	"hechos":        "Hechos_Compartidos",
	"dialogos":      "Dialogos",
	"oportunidades": "Oportunidades",
	"narrativas":    "Narrativas",
}

// RecordModule is moduleForSlug for the target slugs: the module_records.module value.
func RecordModule(slug string) (string, bool) {
	m, ok := recordModules[slug]
	return m, ok
}

// IsApproval reports the decisions that create a record (APPROVAL_STATUSES).
func IsApproval(status string) bool {
	return status == "aceptado_para_revision" || status == "corroborado_documentalmente"
}

// ReviewRecordID is reviewRecordId: the deterministic id of an approved item's record.
func ReviewRecordID(itemID string) string { return "REV-" + itemID }

// IsLookupableID is isLookupableId: an id over MAX_RECORD_ID UTF-16 units or with NUL is never
// stored, so it is not looked up.
func IsLookupableID(id string) bool {
	return utf16Len(id) <= MaxRecordID && !HasNul(id)
}

// HasNul reports U+0000, which PostgreSQL text cannot hold.
func HasNul(s string) bool { return strings.ContainsRune(s, 0) }

func utf16Len(s string) int {
	n := 0
	for _, r := range s {
		n += utf16.RuneLen(r)
	}
	return n
}

// BoundedInt is boundedInt of document-lab-routes.ts for a supplied value: /^\d+$/ (ASCII
// digits), Number.parseInt, then min ≤ value ≤ max. Digit strings beyond int64 are over any max
// the route uses, as parseInt's rounded result is.
func BoundedInt(raw string, minimum, maximum int64) (int64, bool) {
	if raw == "" {
		return 0, false
	}
	for i := 0; i < len(raw); i++ {
		if raw[i] < '0' || raw[i] > '9' {
			return 0, false
		}
	}
	value, err := strconv.ParseInt(raw, 10, 64)
	if err != nil || value < minimum || value > maximum {
		return 0, false
	}
	return value, true
}

// ThemeCounts is Object.fromEntries over (theme, count) rows: JSON keys in JavaScript property
// order, canonical array indexes first in ascending order, then the rest as added.
type ThemeCounts struct {
	keys   []string
	counts map[string]int64
}

// Add sets theme's count; a repeated theme keeps its first position, as fromEntries does.
func (c *ThemeCounts) Add(theme string, count int64) {
	if c.counts == nil {
		c.counts = map[string]int64{}
	}
	if _, seen := c.counts[theme]; !seen {
		c.keys = append(c.keys, theme)
	}
	c.counts[theme] = count
}

// Len is the number of themes.
func (c ThemeCounts) Len() int { return len(c.keys) }

// Keys returns the themes in insertion order.
func (c ThemeCounts) Keys() []string { return c.keys }

// Get returns theme's count.
func (c ThemeCounts) Get(theme string) (int64, bool) {
	n, ok := c.counts[theme]
	return n, ok
}

// MarshalJSON writes the counts in JavaScript property order.
func (c ThemeCounts) MarshalJSON() ([]byte, error) {
	var indexes, others []string
	for _, k := range c.keys {
		if _, ok := arrayIndex(k); ok {
			indexes = append(indexes, k)
		} else {
			others = append(others, k)
		}
	}
	slices.SortFunc(indexes, func(a, b string) int {
		an, _ := arrayIndex(a)
		bn, _ := arrayIndex(b)
		return cmp.Compare(an, bn)
	})
	var b bytes.Buffer
	b.WriteByte('{')
	for i, k := range append(indexes, others...) {
		if i > 0 {
			b.WriteByte(',')
		}
		key, err := json.Marshal(k)
		if err != nil {
			return nil, err
		}
		b.Write(key)
		b.WriteByte(':')
		b.WriteString(strconv.FormatInt(c.counts[k], 10))
	}
	b.WriteByte('}')
	return b.Bytes(), nil
}

// arrayIndex reports a canonical array index (0 … 2^32-2), which JavaScript objects list first.
func arrayIndex(key string) (uint64, bool) {
	if key == "" || (len(key) > 1 && key[0] == '0') {
		return 0, false
	}
	for i := 0; i < len(key); i++ {
		if key[i] < '0' || key[i] > '9' {
			return 0, false
		}
	}
	n, err := strconv.ParseUint(key, 10, 64)
	return n, err == nil && n < math.MaxUint32
}
