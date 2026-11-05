package application

import (
	"context"
	"encoding/json"
	"time"

	"github.com/Dreamcoder08/sipges/apps/api-go/internal/intelligence/domain"
	tenancy "github.com/Dreamcoder08/sipges/apps/api-go/internal/tenancy/domain"
)

// ErrSourceType is an unknown source type.
const ErrSourceType TextError = "source_type"

const (
	alertIDPrefix    = "DIG-"
	alertIDHexDigits = 12
	maxExcerpt       = 500
)

// SourceRecord is the record a signal was evaluated from.
type SourceRecord struct {
	Module string
	ID     string
}

// NewAlert is NewAlert of ports.ts. SourceRecord is nil for a signal typed into the inbox.
type NewAlert struct {
	ID             string
	ProjectID      string
	CreatedAt      time.Time
	SourceURL      string
	SourceType     string
	Territory      *string
	Excerpt        string
	SHA256         string
	Level          string
	Score          int
	Method         string
	Themes         json.RawMessage
	Signals        json.RawMessage
	Suggestions    json.RawMessage
	SemanticActive bool
	AnalystNote    string
	SourceRecord   *SourceRecord
}

// AlertWriter stores an alert with its CREATE audit row in one tenant transaction, or answers the
// same signal recorded in the last day with duplicate true.
type AlertWriter interface {
	Create(ctx context.Context, tenantID string, alert NewAlert) (stored domain.Alert, duplicate bool, err error)
}

// AlertInput is createAlert's input.
type AlertInput struct {
	Text, SourceURL, Mode, SourceType, AnalystNote string
	Territory                                      *string
	SourceRecord                                   *SourceRecord
}

// AlertCreated is createAlert's value.
type AlertCreated struct {
	Alert    domain.Alert
	Analysis json.RawMessage
	Outcome  string
}

// AlertCreation is createAlert of intelligence-service.ts, for the alert inbox's own route and
// for evaluating narratives: the semantic analysis of the text (behind the egress guard), then
// the stored signal.
type AlertCreation struct {
	Semantic  *Semantic
	Store     AlertWriter
	Now       func() time.Time
	RandomHex func(length int) string
}

// reportFields are the fields of a semantic report an alert keeps.
type reportFields struct {
	Method      string          `json:"method"`
	Themes      json.RawMessage `json:"topics"`
	Signals     json.RawMessage `json:"signals"`
	Suggestions json.RawMessage `json:"suggested_actions"`
	Orientation struct {
		Score int    `json:"score"`
		Level string `json:"level"`
	} `json:"orientation"`
	Evidence struct {
		SHA256 string `json:"sha256"`
	} `json:"evidence"`
	Semantic struct {
		Active bool `json:"active"`
	} `json:"semantic"`
}

// Create is createAlert(scope, input).
func (c AlertCreation) Create(ctx context.Context, scope tenancy.Scope, input AlertInput) (AlertCreated, TextError, error) {
	if !domain.IsSourceType(input.SourceType) {
		return AlertCreated{}, ErrSourceType, nil
	}
	analysis, kind, err := c.Semantic.Analyze(ctx, scope, input.Text, input.SourceURL, input.Mode)
	if err != nil || kind != "" {
		return AlertCreated{}, kind, err
	}
	var report reportFields
	if err := json.Unmarshal(analysis, &report); err != nil {
		return AlertCreated{}, "", err
	}
	now := time.Now
	if c.Now != nil {
		now = c.Now
	}
	alert, duplicate, err := c.Store.Create(ctx, scope.TenantID(), NewAlert{
		ID:        alertIDPrefix + c.RandomHex(alertIDHexDigits),
		ProjectID: scope.ProjectID,
		// JavaScript dates hold milliseconds: store the instant the TypeScript API would.
		CreatedAt:  now().Truncate(time.Millisecond),
		SourceURL:  input.SourceURL,
		SourceType: input.SourceType,
		Territory:  trimmedOrNil(input.Territory),
		Excerpt:    domain.FirstCodePoints(domain.TrimJS(input.Text), maxExcerpt),
		SHA256:     report.Evidence.SHA256,
		Level:      report.Orientation.Level,
		Score:      report.Orientation.Score,
		Method:     report.Method,
		Themes:     report.Themes, Signals: report.Signals, Suggestions: report.Suggestions,
		SemanticActive: report.Semantic.Active,
		AnalystNote:    domain.FirstCodePoints(input.AnalystNote, domain.MaxNoteLength),
		SourceRecord:   input.SourceRecord,
	})
	if err != nil {
		return AlertCreated{}, "", err
	}
	outcome := "created"
	if duplicate {
		outcome = "duplicate"
	}
	return AlertCreated{Alert: alert, Analysis: analysis, Outcome: outcome}, "", nil
}

func trimmedOrNil(territory *string) *string {
	if territory == nil {
		return nil
	}
	trimmed := domain.TrimJS(*territory)
	if trimmed == "" {
		return nil
	}
	return &trimmed
}
