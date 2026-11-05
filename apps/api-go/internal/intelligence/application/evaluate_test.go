package application_test

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"

	"github.com/Dreamcoder08/sipges/apps/api-go/internal/intelligence/application"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/intelligence/domain"
	tenancy "github.com/Dreamcoder08/sipges/apps/api-go/internal/tenancy/domain"
)

// The cases of apps/api/test/intelligence/narrative-evaluation.test.ts.

// leveled answers a report of one orientation level.
type leveled struct {
	level string
	kind  application.TextError
	err   error
	calls int
}

func (l *leveled) AnalyzeText(context.Context, tenancy.Scope, string, string) (json.RawMessage, application.TextError, error) {
	l.calls++
	return json.RawMessage(strings.Replace(alertBase, `"level":"Alta"`, `"level":"`+l.level+`"`, 1)), l.kind, l.err
}

// neverEmbedded fails a test that reaches the model: evaluation is rules only.
type neverEmbedded struct {
	application.Embedder
	t *testing.T
}

func (n neverEmbedded) Model() string {
	n.t.Error("the evaluation reached the embedder")
	return ""
}

func evaluating(t *testing.T, store *fakeAlertStore, analyzer *leveled) application.AlertCreation {
	t.Helper()
	c := creation(store)
	c.Semantic = &application.Semantic{Text: analyzer, Embedder: neverEmbedded{t: t}}
	return c
}

func payload(fields map[string]any) func(string) (any, bool) {
	return func(key string) (any, bool) {
		v, ok := fields[key]
		return v, ok
	}
}

func narrative() map[string]any {
	return map[string]any{
		"Descripcion":     "Exigimos agua limpia: habrá paro y bloqueo este lunes.",
		"URL_Publicacion": " https://example.org/synthetic ",
		"Territorio":      " Territorio documentado ",
	}
}

var evaluated = tenancy.Scope{CompanyID: "synthetic", ProjectID: "SYNTHETIC"}

func TestEvaluationKeepsTheRecordsProvenance(t *testing.T) {
	store := &fakeAlertStore{}
	got, err := evaluating(t, store, &leveled{level: "Alta"}).EvaluateNarrative(t.Context(), evaluated, application.NarrativeInput{
		ID: "NAR-1", Payload: payload(narrative()), Marking: "interno", MinimumLevel: "Media",
	})
	if err != nil || got.Outcome != "created" || got.AlertID != "DIG-ABABABABABAB" {
		t.Fatalf("got %+v, %v", got, err)
	}
	a := store.got[0]
	if a.SourceRecord == nil || *a.SourceRecord != (application.SourceRecord{Module: "Narrativas", ID: "NAR-1"}) { //nolint:misspell // the Spanish module name
		t.Fatalf("source record %+v", a.SourceRecord)
	}
	if a.Territory == nil || *a.Territory != "Territorio documentado" || a.SourceURL != "https://example.org/synthetic" ||
		a.SourceType != "Publicación digital" || a.SemanticActive || a.AnalystNote != "" {
		t.Fatalf("alert %+v", a)
	}
}

func TestEvaluationKeepsTheDocumentedSourceType(t *testing.T) {
	for _, sourceType := range []string{"Documento", "Reporte de campo", "Publicación digital"} {
		fields := narrative()
		fields["Tipo_Fuente"] = sourceType
		store := &fakeAlertStore{}
		got, err := evaluating(t, store, &leveled{level: "Media"}).EvaluateNarrative(t.Context(), evaluated,
			application.NarrativeInput{ID: "NAR-1", Payload: payload(fields), Marking: "interno"})
		if err != nil || got.Outcome != "created" || store.got[0].SourceType != sourceType {
			t.Fatalf("%s: %+v, %v", sourceType, got, err)
		}
	}
}

func TestEvaluationTreatsANullSourceTypeAsTheDefault(t *testing.T) {
	fields := narrative()
	fields["Tipo_Fuente"] = nil
	store := &fakeAlertStore{}
	got, err := evaluating(t, store, &leveled{level: "Alta"}).EvaluateNarrative(t.Context(), evaluated,
		application.NarrativeInput{ID: "NAR-1", Payload: payload(fields), Marking: "publico"})
	if err != nil || got.Outcome != "created" || store.got[0].SourceType != "Publicación digital" {
		t.Fatalf("%+v, %v", got, err)
	}
}

func TestEvaluationExcludesWhatItMayNotUse(t *testing.T) {
	with := func(key string, value any) map[string]any {
		fields := narrative()
		fields[key] = value
		return fields
	}
	for name, c := range map[string]struct {
		id, marking, level string
		fields             map[string]any
		kind               application.TextError
	}{
		"restricted":       {id: "N", marking: "restringido", level: "Alta", fields: narrative()},
		"unknown marking":  {id: "N", marking: "unknown", level: "Alta", fields: narrative()},
		"no id":            {id: "", marking: "interno", level: "Alta", fields: narrative()},
		"long id":          {id: strings.Repeat("x", 201), marking: "interno", level: "Alta", fields: narrative()},
		"long id in units": {id: strings.Repeat("😀", 101), marking: "interno", level: "Alta", fields: narrative()},
		"invented source":  {id: "N", marking: "interno", level: "Alta", fields: with("Tipo_Fuente", "Fuente inventada")},
		"numeric source":   {id: "N", marking: "interno", level: "Alta", fields: with("Tipo_Fuente", 42.0)},
		"long territory":   {id: "N", marking: "interno", level: "Alta", fields: with("Territorio", strings.Repeat("x", 501))},
		"empty text":       {id: "N", marking: "interno", level: "Alta", fields: narrative(), kind: "empty"},
		"unsafe url":       {id: "N", marking: "interno", level: "Alta", fields: with("URL_Publicacion", "javascript:alert(1)")},
		"low level":        {id: "N", marking: "interno", level: "Baja", fields: narrative()},
	} {
		t.Run(name, func(t *testing.T) {
			store := &fakeAlertStore{}
			got, err := evaluating(t, store, &leveled{level: c.level, kind: c.kind}).EvaluateNarrative(t.Context(), evaluated,
				application.NarrativeInput{ID: c.id, Payload: payload(c.fields), Marking: c.marking, MinimumLevel: "Media"})
			if err != nil || got.Outcome != "ineligible" || got.AlertID != "" || len(store.got) != 0 {
				t.Fatalf("%+v, %v, %d alerts", got, err, len(store.got))
			}
		})
	}
}

func TestEvaluationKeepsLimitsAtTheirBoundary(t *testing.T) {
	fields := narrative()
	fields["Territorio"] = strings.Repeat("x", 500)
	store := &fakeAlertStore{}
	got, err := evaluating(t, store, &leveled{level: "Alta"}).EvaluateNarrative(t.Context(), evaluated,
		application.NarrativeInput{ID: strings.Repeat("x", 200), Payload: payload(fields), Marking: "interno"})
	if err != nil || got.Outcome != "created" {
		t.Fatalf("%+v, %v", got, err)
	}
}

func TestEvaluationEnforcesTheThreshold(t *testing.T) {
	input := application.NarrativeInput{ID: "N", Payload: payload(narrative()), Marking: "interno"}
	for _, c := range []struct{ level, minimum, want string }{
		{"Media", "Alta", "ineligible"}, {"Media", "Media", "created"}, {"Media", "", "created"},
		{"Alta", "Alta", "created"}, {"Alta", "Media", "created"}, {"Baja", "", "ineligible"},
	} {
		input.MinimumLevel = c.minimum
		got, err := evaluating(t, &fakeAlertStore{}, &leveled{level: c.level}).EvaluateNarrative(t.Context(), evaluated, input)
		if err != nil || got.Outcome != c.want {
			t.Fatalf("%+v: %+v, %v", c, got, err)
		}
	}
}

func TestEvaluationReportsWhatTheStoreAlreadyHas(t *testing.T) {
	store := &fakeAlertStore{duplicate: &domain.Alert{ID: "DIG-EXISTING"}}
	got, err := evaluating(t, store, &leveled{level: "Alta"}).EvaluateNarrative(t.Context(), evaluated,
		application.NarrativeInput{ID: "N", Payload: payload(narrative()), Marking: "interno"})
	if err != nil || got.Outcome != "duplicate" || got.AlertID != "DIG-EXISTING" {
		t.Fatalf("%+v, %v", got, err)
	}
}

func TestEvaluationDoesNotInferATerritory(t *testing.T) {
	for _, value := range []any{nil, 5.0} {
		fields := narrative()
		fields["Territorio"] = value
		store := &fakeAlertStore{}
		if _, err := evaluating(t, store, &leveled{level: "Alta"}).EvaluateNarrative(t.Context(), evaluated,
			application.NarrativeInput{ID: "N", Payload: payload(fields), Marking: "publico"}); err != nil {
			t.Fatal(err)
		}
		if store.got[0].Territory != nil {
			t.Fatalf("territory %q", *store.got[0].Territory)
		}
	}
}

func TestEvaluationPassesInfrastructureFailuresOnSoTheRunRetries(t *testing.T) {
	failure := errors.New("connection reset")
	input := application.NarrativeInput{ID: "N", Payload: payload(narrative()), Marking: "interno"}
	if _, err := evaluating(t, &fakeAlertStore{}, &leveled{level: "Alta", err: failure}).EvaluateNarrative(t.Context(), evaluated, input); !errors.Is(err, failure) {
		t.Fatalf("analysis: %v", err)
	}
	if _, err := evaluating(t, &fakeAlertStore{err: failure}, &leveled{level: "Alta"}).EvaluateNarrative(t.Context(), evaluated, input); !errors.Is(err, failure) {
		t.Fatalf("store: %v", err)
	}
}
