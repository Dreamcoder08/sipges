// Package domain holds the read rules of the territorial alert inbox,
// apps/api/src/contexts/intelligence/domain/alerts.ts: the alert, the list limit and the summary.
// The classifier and the text analysis run in the Rust analytics module (application.Writes).
package domain

import (
	"bytes"
	"encoding/json"
	"errors"
	"math"
	"slices"
	"strconv"
	"strings"
	"time"
	"unicode/utf16"
)

// AlertStates is ALERT_STATES, in the order the summary writes them.
var AlertStates = []string{"Pendiente de verificación", "Corroborado", "Descartado", "En seguimiento"}

// PriorityLevels is PRIORITY_LEVELS, in the order the summary writes them.
var PriorityLevels = []string{"Alta", "Media", "Baja"}

// MaxAlertList is MAX_ALERT_LIST: the most alerts a list or the summary reads.
const MaxAlertList = 200

// maxLookupID is the longest id (UTF-16 code units) getAlert looks up.
const maxLookupID = 80

// Alert is TerritorialAlert as stored. Themes, Signals, Suggestions and SourceRecord are the
// stored JSON, written back as they are (nil SourceRecord is null).
type Alert struct {
	ID             string
	ProjectID      string
	CreatedAt      time.Time
	SourceURL      string
	SourceType     string
	Territory      *string
	SourceRecord   json.RawMessage
	Excerpt        string
	SHA256         string
	Level          string
	Score          int
	Method         string
	Themes         json.RawMessage
	Signals        json.RawMessage
	Suggestions    json.RawMessage
	SemanticActive bool
	Status         string
	AnalystNote    string
	ReviewerNote   *string
	ReviewedAt     *time.Time
	FirstValidator *string
}

// ListLimit is listAlerts' Math.max(1, Math.min(limit, MAX_ALERT_LIST)).
func ListLimit(limit int64) int {
	return int(max(1, min(limit, MaxAlertList)))
}

// LookupID is getAlert's guard: an empty id, or one longer than 80 UTF-16 code units, is never
// looked up (the route answers 404).
func LookupID(id string) bool {
	return id != "" && len(utf16.Encode([]rune(id))) <= maxLookupID
}

// Counts is a JavaScript object of counts in a fixed key order.
type Counts struct {
	keys   []string
	counts map[string]int
}

func newCounts(keys []string) Counts {
	return Counts{keys: keys, counts: make(map[string]int, len(keys))}
}

// MarshalJSON writes the counts in key order.
func (c Counts) MarshalJSON() ([]byte, error) {
	var b bytes.Buffer
	b.WriteByte('{')
	for i, k := range c.keys {
		if i > 0 {
			b.WriteByte(',')
		}
		key, err := json.Marshal(k)
		if err != nil {
			return nil, err
		}
		b.Write(key)
		b.WriteByte(':')
		b.WriteString(strconv.Itoa(c.counts[k]))
	}
	b.WriteByte('}')
	return b.Bytes(), nil
}

// ThemeCount is one entry of the summary's themes. A nil Name is JavaScript's undefined: the
// key is left out of the JSON.
type ThemeCount struct {
	Name  json.RawMessage `json:"name,omitempty"`
	Count int             `json:"count"`
}

// Summary is alertSummary's result.
type Summary struct {
	Version         string       `json:"version"`
	ProjectID       string       `json:"project_id"`
	Total           int          `json:"total"`
	ByStatus        Counts       `json:"by_status"`
	ByPriority      Counts       `json:"by_priority"`
	Themes          []ThemeCount `json:"themes"`
	IRSAIntegration string       `json:"irsa_integration"`
	Caution         string       `json:"caution"`
}

// errThemes is JavaScript's TypeError where `r.themes.map((t) => t.tema)` throws.
var errThemes = errors.New("intelligence: stored themes are not a list of themes")

// NewSummary is alertSummary(projectID, items).
func NewSummary(projectID string, items []Alert) (Summary, error) {
	s := Summary{
		Version: "2.6", ProjectID: projectID, Total: len(items),
		ByStatus: newCounts(AlertStates), ByPriority: newCounts(PriorityLevels),
		IRSAIntegration: "Sin modificación automática del IRSA; requiere validación metodológica",
		Caution:         "Registros manuales, sin monitoreo permanente ni corroboración automática.", //nolint:misspell // Spanish, verbatim from alerts.ts
	}
	var themes counter
	for _, a := range items {
		if slices.Contains(AlertStates, a.Status) {
			s.ByStatus.counts[a.Status]++
		}
		if slices.Contains(PriorityLevels, a.Level) {
			s.ByPriority.counts[a.Level]++
		}
		if err := themes.addThemes(a.Themes); err != nil {
			return Summary{}, err
		}
	}
	s.Themes = themes.mostCommon(12)
	return s, nil
}

// counter is mostCommon's Map: keys compared as JavaScript's SameValueZero compares the values
// of `t.tema` (objects and arrays only equal themselves, so each occurrence is its own key).
type counter struct {
	order  []string
	names  map[string]json.RawMessage
	counts map[string]int
	unique int
}

func (c *counter) addThemes(raw json.RawMessage) error {
	var themes []json.RawMessage
	if err := json.Unmarshal(raw, &themes); err != nil || themes == nil {
		return errThemes
	}
	for _, theme := range themes {
		key, name, err := c.tema(theme)
		if err != nil {
			return err
		}
		if c.counts == nil {
			c.names, c.counts = map[string]json.RawMessage{}, map[string]int{}
		}
		if _, seen := c.counts[key]; !seen {
			c.order = append(c.order, key)
			c.names[key] = name
		}
		c.counts[key]++
	}
	return nil
}

// tema is `t.tema` of one stored theme: its Map key and its JSON (nil for undefined).
func (c *counter) tema(theme json.RawMessage) (string, json.RawMessage, error) {
	theme = bytes.TrimSpace(theme)
	if string(theme) == "null" {
		return "", nil, errThemes
	}
	if len(theme) == 0 || theme[0] != '{' {
		return "undefined", nil, nil // a property of a primitive or an array: undefined
	}
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(theme, &fields); err != nil {
		return "", nil, errThemes
	}
	value, ok := fields["tema"]
	if !ok {
		return "undefined", nil, nil
	}
	value = bytes.TrimSpace(value)
	switch {
	case len(value) > 0 && (value[0] == '{' || value[0] == '['):
		c.unique++
		var compact bytes.Buffer
		if err := json.Compact(&compact, value); err != nil {
			return "", nil, errThemes
		}
		return "o:" + strconv.Itoa(c.unique), compact.Bytes(), nil
	case len(value) > 0 && value[0] == '"':
		var s string
		if err := json.Unmarshal(value, &s); err != nil {
			return "", nil, errThemes
		}
		name, err := json.Marshal(s)
		return "s:" + s, name, err
	case string(value) == "null" || string(value) == "true" || string(value) == "false":
		return string(value), value, nil
	default:
		text, err := jsNumber(json.Number(value))
		if err != nil {
			return "", nil, errThemes
		}
		key := "n:" + text
		if text == "null" { // ±Infinity are two keys that both print null
			key = "n:" + string(value[0]) + "Infinity"
		}
		return key, json.RawMessage(text), nil
	}
}

func (c *counter) mostCommon(limit int) []ThemeCount {
	keys := slices.Clone(c.order)
	slices.SortStableFunc(keys, func(a, b string) int { return c.counts[b] - c.counts[a] })
	out := make([]ThemeCount, 0, min(limit, len(keys)))
	for _, k := range keys[:min(limit, len(keys))] {
		out = append(out, ThemeCount{Name: c.names[k], Count: c.counts[k]})
	}
	return out
}

// jsNumber is JSON.stringify of a JSON number as JavaScript parses it (Number::toString).
func jsNumber(n json.Number) (string, error) {
	f, err := strconv.ParseFloat(string(n), 64)
	if math.IsInf(f, 0) {
		return "null", nil // JSON.stringify(Infinity); JSON.parse reads 1e400 as Infinity
	}
	if err != nil {
		return "", errThemes
	}
	if f == 0 {
		return "0", nil
	}
	if a := math.Abs(f); a >= 1e-6 && a < 1e21 {
		return strconv.FormatFloat(f, 'f', -1, 64), nil
	}
	mantissa, exp, _ := strings.Cut(strconv.FormatFloat(f, 'e', -1, 64), "e")
	sign, digits := exp[:1], strings.TrimLeft(exp[1:], "0")
	return mantissa + "e" + sign + digits, nil
}
