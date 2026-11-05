//nolint:misspell // Spanish notices, verbatim from the TypeScript API.
package application

import (
	"context"
	"errors"
	"log/slog"
	"time"

	"github.com/Dreamcoder08/sipges/apps/api-go/internal/analyst/domain"
	privacy "github.com/Dreamcoder08/sipges/apps/api-go/internal/privacy/application"
	privacydomain "github.com/Dreamcoder08/sipges/apps/api-go/internal/privacy/domain"
)

// The engines of a briefing.
const (
	EngineExtractive = "extractivo"
	EngineAssisted   = "asistido"
)

const (
	narrationTimeout  = 20 * time.Second
	markingRestricted = "restringido"
	narrationPurpose  = "briefing"

	narrationFailed   = "El resumen asistido no estuvo disponible; se muestra el informe extractivo."
	narrationWithheld = "El registro está restringido; el resumen asistido no se genera para información restringida."
)

// Narrator rewrites an extractive briefing as prose (docs/adr/0013). It accepts only a cleared
// payload, and must cite with the briefing's [n] markers.
type Narrator interface {
	Name() string
	Narrate(ctx context.Context, briefing privacy.Sanitised[string]) (string, error)
}

// EgressOpener is the egress guard: the only way a briefing reaches a narrator.
type EgressOpener interface {
	Open(ctx context.Context, request privacy.Request) (*privacy.Session, error)
}

// Assisted is the assisted half of briefing in analyst-service.ts. Egress is nil when
// SIPGES_DATA_KEY is missing: the narrator then gets nothing.
type Assisted struct {
	Narrator Narrator
	Egress   EgressOpener
	Logger   *slog.Logger
}

// Assistance is a briefing with its engine and, when the narrator ran, its prose.
type Assistance struct {
	domain.Briefing
	Engine    string
	Narrator  *string
	Narrative *domain.Sentence
	Notice    *string
}

// Brief is briefing(tenant, slug, id) with a narrator. Every failure on the way leaves the
// extractive briefing with a notice. The team keeps the real records; only the shared view leaves.
func (a Assisted) Brief(ctx context.Context, tenantID string, found Neighbourhood, now time.Time) Assistance {
	today := Today(now)
	full := domain.BuildBriefing(found.Subject, found.Connections, today)
	out := Assistance{Briefing: full, Engine: EngineExtractive}
	if found.Subject.Marking == markingRestricted {
		notice := narrationWithheld
		out.Notice = &notice
		return out
	}
	text, refs, err := a.narrate(ctx, tenantID, found, full, today)
	if err != nil {
		if a.Logger != nil {
			// Only the event: a provider error may quote the request.
			a.Logger.LogAttrs(ctx, slog.LevelWarn, "briefing_narration_failed", slog.String("narrator", a.Narrator.Name()))
		}
		notice := narrationFailed
		out.Notice = &notice
		return out
	}
	name := a.Narrator.Name()
	out.Engine, out.Narrator = EngineAssisted, &name
	out.Narrative = &domain.Sentence{Text: text, Refs: refs}
	return out
}

func (a Assisted) narrate(ctx context.Context, tenantID string, found Neighbourhood, full domain.Briefing, today string) (string, []int, error) {
	if a.Egress == nil {
		return "", nil, privacy.ErrDisabled
	}
	session, err := a.Egress.Open(ctx, privacy.Request{
		TenantID: tenantID, Channel: privacy.ChannelAnalyst, Purpose: narrationPurpose,
	})
	if err != nil {
		return "", nil, err
	}
	// Restricted neighbours never leave the platform, and the rest only as the guard allows.
	view, connections := sanitisedView(session, found)
	shared := domain.BuildBriefing(view, connections, today)
	cleared, err := privacy.Release(ctx, session, domain.BriefingText(shared))
	if err != nil {
		return "", nil, err
	}
	ctx, cancel := context.WithTimeout(ctx, narrationTimeout)
	defer cancel()
	prose, err := a.Narrator.Narrate(ctx, cleared)
	if err != nil {
		return "", nil, err
	}
	prose = domain.TrimNarrative(prose)
	refs, ok := domain.CitedRefs(prose, shared)
	if !ok || len(refs) == 0 {
		return "", nil, errors.New("analyst: the narrative cites no valid source")
	}
	text, moved := domain.RenumberCitations(prose, refs, shared, full)
	return text, moved, nil
}

// sanitisedView is sanitisedView of analyst-service.ts: the briefing as an outside reader may see
// it. Record ids stay, since citations need them; the session scrubs every string again when it
// releases the text.
func sanitisedView(session *privacy.Session, found Neighbourhood) (domain.Summary, []domain.Connection) {
	unique := []domain.Summary{found.Subject}
	seen := map[domain.Ref]int{{Slug: found.Subject.Slug, ID: found.Subject.ID}: 0}
	for _, c := range found.Connections {
		ref := domain.Ref{Slug: c.Other.Slug, ID: c.Other.ID}
		if _, known := seen[ref]; !known {
			seen[ref] = len(unique)
			unique = append(unique, c.Other)
		}
	}
	raw := make([]privacydomain.RawRecord, len(unique))
	for i, s := range unique {
		raw[i] = rawRecord(s)
	}
	cleaned := session.Records(raw)
	connections := make([]domain.Connection, 0, len(found.Connections))
	for _, c := range found.Connections {
		at := seen[domain.Ref{Slug: c.Other.Slug, ID: c.Other.ID}]
		if at >= len(cleaned) || cleaned[at].Withheld {
			continue
		}
		c.Other = cleanSummary(c.Other, cleaned[at])
		connections = append(connections, c)
	}
	return cleanSummary(found.Subject, cleaned[0]), connections
}

func rawRecord(s domain.Summary) privacydomain.RawRecord {
	title, marking := s.Title, s.Marking
	fields := make([]privacydomain.RawField, len(s.Fields))
	for i, f := range s.Fields {
		fields[i] = privacydomain.RawField{Name: f.Key, Value: f.Value}
	}
	return privacydomain.RawRecord{Module: s.Slug, ID: s.ID, Title: &title, Date: s.Date, Marking: &marking, Fields: fields}
}

// cleanSummary keeps what the guard let through: a withheld record keeps only its id as title.
func cleanSummary(s domain.Summary, clean privacydomain.SanitisedRecord) domain.Summary {
	s.Title = s.ID
	if clean.Title != nil {
		s.Title = string(*clean.Title)
	}
	s.Date = nil
	if clean.Date != nil {
		date := string(*clean.Date)
		s.Date = &date
	}
	s.Fields = make([]domain.Field, len(clean.Fields))
	for i, f := range clean.Fields {
		value := f.Value.Text
		if f.Value.IsNumber {
			value = domain.NumberText(f.Value.Number)
		}
		s.Fields[i] = domain.Field{Key: f.Name, Value: value}
	}
	return s
}
