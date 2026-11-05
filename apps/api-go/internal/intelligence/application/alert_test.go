package application_test

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/Dreamcoder08/sipges/apps/api-go/internal/intelligence/application"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/intelligence/domain"
	tenancy "github.com/Dreamcoder08/sipges/apps/api-go/internal/tenancy/domain"
)

const alertBase = `{"version":"2.4","topics":[{"tema":"Agua"}],"signals":[{"senal":"s"}],` +
	`"orientation":{"score":7,"level":"Alta","meaning":"m"},"suggested_actions":["Verificar"],` +
	`"evidence":{"fragment":"f","sha256":"ab12"},"method":"Reglas"}`

type alertAnalyzer struct{ fakeAnalyzer }

func (a *alertAnalyzer) AnalyzeText(ctx context.Context, s tenancy.Scope, t, u string) (json.RawMessage, application.TextError, error) {
	_, kind, err := a.fakeAnalyzer.AnalyzeText(ctx, s, t, u)
	return json.RawMessage(alertBase), kind, err
}

type fakeAlertStore struct {
	got       []application.NewAlert
	tenant    string
	duplicate *domain.Alert
	err       error
}

func (f *fakeAlertStore) Create(_ context.Context, tenantID string, a application.NewAlert) (domain.Alert, bool, error) {
	f.tenant = tenantID
	f.got = append(f.got, a)
	if f.err != nil {
		return domain.Alert{}, false, f.err
	}
	if f.duplicate != nil {
		return *f.duplicate, true, nil
	}
	return domain.Alert{ID: a.ID, Status: "Pendiente de verificación", Territory: a.Territory}, false, nil
}

var alertTime = time.Date(2026, 11, 3, 11, 0, 0, 987654321, time.UTC)

func creation(store *fakeAlertStore) application.AlertCreation {
	semantic := &application.Semantic{Text: &alertAnalyzer{}, Embedder: &recording{egress: application.EgressLocal}}
	return application.AlertCreation{
		Semantic: semantic, Store: store,
		Now:       func() time.Time { return alertTime },
		RandomHex: func(n int) string { return strings.Repeat("AB", n/2) },
	}
}

func TestAlertRefusesAnUnknownSourceTypeBeforeAnalysing(t *testing.T) {
	t.Parallel()
	store := &fakeAlertStore{}
	text := &alertAnalyzer{}
	c := creation(store)
	c.Semantic.Text = text
	_, kind, err := c.Create(t.Context(), scope, application.AlertInput{Text: "t", Mode: "magic", SourceType: "Rumor"})
	if err != nil || kind != application.ErrSourceType {
		t.Fatalf("%q %v", kind, err)
	}
	if text.calls != 0 || len(store.got) != 0 {
		t.Fatal("analysed or stored")
	}
}

func TestAlertRefusalsOfTheAnalysisStoreNothing(t *testing.T) {
	t.Parallel()
	store := &fakeAlertStore{}
	_, kind, err := creation(store).Create(t.Context(), scope, application.AlertInput{
		Text: "t", Mode: "magic", SourceType: "Documento",
	})
	if err != nil || kind != application.ErrMode || len(store.got) != 0 {
		t.Fatalf("%q %v %d", kind, err, len(store.got))
	}
}

func TestAlertStoresWhatTheReportSays(t *testing.T) {
	t.Parallel()
	store := &fakeAlertStore{}
	territory := "  Caserío sintético \n"
	created, kind, err := creation(store).Create(t.Context(), scope, application.AlertInput{
		Text: "  " + strings.Repeat("😀", 501) + "  ", SourceURL: "https://example.org/a", Mode: "rules",
		SourceType: "Documento", AnalystNote: strings.Repeat("é", 2001), Territory: &territory,
	})
	if err != nil || kind != "" {
		t.Fatalf("%q %v", kind, err)
	}
	if store.tenant != "SIPGES/PRJ-SECHURA" || len(store.got) != 1 {
		t.Fatalf("%q %d", store.tenant, len(store.got))
	}
	got := store.got[0]
	if got.ID != "DIG-ABABABABABAB" || got.ProjectID != "PRJ-SECHURA" || got.SourceURL != "https://example.org/a" ||
		got.SourceType != "Documento" || got.Level != "Alta" || got.Score != 7 || got.SHA256 != "ab12" {
		t.Fatalf("%+v", got)
	}
	if got.Excerpt != strings.Repeat("😀", 500) || got.AnalystNote != strings.Repeat("é", 2000) {
		t.Fatal("the excerpt or the note was not cut")
	}
	if got.Territory == nil || *got.Territory != "Caserío sintético" {
		t.Fatalf("territory = %v", got.Territory)
	}
	if !got.CreatedAt.Equal(alertTime.Truncate(time.Millisecond)) {
		t.Fatalf("created at %v", got.CreatedAt)
	}
	if string(got.Themes) != `[{"tema":"Agua"}]` || string(got.Signals) != `[{"senal":"s"}]` ||
		string(got.Suggestions) != `["Verificar"]` {
		t.Fatalf("%s %s %s", got.Themes, got.Signals, got.Suggestions)
	}
	if got.SemanticActive || !strings.Contains(string(created.Analysis), `"version":"2.5"`) {
		t.Fatalf("active %v, %s", got.SemanticActive, created.Analysis)
	}
	if got.Method != "Reglas" || created.Outcome != "created" {
		t.Fatalf("%q %q", got.Method, created.Outcome)
	}
}

func TestAlertRecordsTheHybridMethod(t *testing.T) {
	t.Parallel()
	store := &fakeAlertStore{}
	_, _, err := creation(store).Create(t.Context(), scope, application.AlertInput{Text: "t", Mode: "automatic", SourceType: "Documento"})
	if err != nil {
		t.Fatal(err)
	}
	if got := store.got[0]; !got.SemanticActive || !strings.HasPrefix(got.Method, "Análisis híbrido") {
		t.Fatalf("%+v", got)
	}
}

func TestBlankTerritoryIsNone(t *testing.T) {
	t.Parallel()
	for _, territory := range []*string{nil, new(string), func() *string { s := "   "; return &s }()} {
		store := &fakeAlertStore{}
		_, _, err := creation(store).Create(t.Context(), scope, application.AlertInput{
			Text: "t", Mode: "rules", SourceType: "Documento", Territory: territory,
		})
		if err != nil {
			t.Fatal(err)
		}
		if store.got[0].Territory != nil {
			t.Fatalf("territory = %q", *store.got[0].Territory)
		}
	}
}

func TestDuplicateAnswersTheStoredAlert(t *testing.T) {
	t.Parallel()
	store := &fakeAlertStore{duplicate: &domain.Alert{ID: "DIG-OLD", Status: "Corroborado"}}
	created, _, err := creation(store).Create(t.Context(), scope, application.AlertInput{Text: "t", Mode: "rules", SourceType: "Documento"})
	if err != nil {
		t.Fatal(err)
	}
	if created.Outcome != "duplicate" || created.Alert.ID != "DIG-OLD" || created.Alert.Status != "Corroborado" {
		t.Fatalf("%+v", created)
	}
}

func TestAStoreFailureFailsTheRequest(t *testing.T) {
	t.Parallel()
	store := &fakeAlertStore{err: errors.New("db down")}
	if _, _, err := creation(store).Create(t.Context(), scope, application.AlertInput{Text: "t", Mode: "rules", SourceType: "Documento"}); err == nil {
		t.Fatal("expected the error")
	}
}

func TestAlertWithAnExternalModelStoresTheOriginalExcerptButSendsTheScrubbedText(t *testing.T) {
	t.Parallel()
	embedder := &recording{egress: application.EgressExternal}
	store := &fakeAlertStore{}
	c := creation(store)
	c.Semantic = &application.Semantic{Text: &alertAnalyzer{}, Embedder: embedder, Egress: guardOf(&guardFakes{enabled: true})}
	const text = "Escribió Marcos Villanueva Prado pidiendo agua"
	if _, _, err := c.Create(t.Context(), scope, application.AlertInput{Text: text, Mode: "semantic", SourceType: "Documento"}); err != nil {
		t.Fatal(err)
	}
	if store.got[0].Excerpt != text {
		t.Fatalf("excerpt = %q", store.got[0].Excerpt)
	}
	for _, sent := range embedder.sent {
		if strings.Contains(sent, "Marcos") {
			t.Fatalf("sent %q", sent)
		}
	}
}
