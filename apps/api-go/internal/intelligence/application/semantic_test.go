package application_test

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/Dreamcoder08/sipges/apps/api-go/internal/intelligence/application"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/intelligence/domain"
	privacy "github.com/Dreamcoder08/sipges/apps/api-go/internal/privacy/application"
	privacydomain "github.com/Dreamcoder08/sipges/apps/api-go/internal/privacy/domain"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/privacy/infrastructure"
	tenancy "github.com/Dreamcoder08/sipges/apps/api-go/internal/tenancy/domain"
)

const baseReport = `{"version":"2.4","source_url":"","method":"Reglas","evidence":{"sha256":"ab"}}`

// The JSON every report without a model ends in.
const rulesTail = `"method":"Reglas","evidence":{"sha256":"ab"},"semantic":{"active":false,"method":"Reglas verificables; sin modelo semántico","matches":[],"note":"%NOTE%"},"verification_status":"Pendiente de corroboración","source_retrieved":false}`

const (
	rulesNote    = "Análisis de temas por reglas. No se ha interpretado semánticamente el texto."
	fallbackNote = "Ollama local no disponible; se aplicaron únicamente reglas. El análisis semántico NO se ejecutó."
)

func rulesReport(note string) string {
	return `{"version":"2.5","source_url":"",` + strings.ReplaceAll(rulesTail, "%NOTE%", note)
}

type fakeAnalyzer struct {
	calls int
	kind  application.TextError
	err   error
}

func (f *fakeAnalyzer) AnalyzeText(context.Context, tenancy.Scope, string, string) (json.RawMessage, application.TextError, error) {
	f.calls++
	return json.RawMessage(baseReport), f.kind, f.err
}

// recording embeds every text as a vector chosen by vectorOf and keeps what it received.
type recording struct {
	egress   string
	mu       sync.Mutex
	sent     []string
	vectorOf func(text string) ([]float64, error)
}

func (r *recording) Model() string  { return "fake-embed" }
func (r *recording) Egress() string { return r.egress }
func (r *recording) Embed(_ context.Context, text privacy.Sanitised[string]) ([]float64, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.sent = append(r.sent, text.Value())
	if r.vectorOf != nil {
		return r.vectorOf(text.Value())
	}
	return []float64{0, 1}, nil
}

type guardFakes struct {
	enabled bool
	mu      sync.Mutex
	log     []privacy.EgressLogEntry
}

func (g *guardFakes) Enabled(context.Context, string) (bool, error) { return g.enabled, nil }
func (g *guardFakes) Load(context.Context, string) ([]privacydomain.KnownName, error) {
	return []privacydomain.KnownName{{Kind: privacydomain.Persona, Name: "Marcos Villanueva Prado"}}, nil
}

func (g *guardFakes) Append(_ context.Context, _ string, entry privacy.EgressLogEntry) error {
	g.mu.Lock()
	defer g.mu.Unlock()
	g.log = append(g.log, entry)
	return nil
}

func guardOf(g *guardFakes) *privacy.Guard {
	return privacy.NewGuard(privacy.Deps{
		Switch: g, Names: g, Log: g, Keys: infrastructure.NewKeys(bytes.Repeat([]byte{7}, 32)),
		Now: func() time.Time { return time.Unix(0, 0) },
	})
}

func analyze(t *testing.T, s *application.Semantic, text, url, mode string) (string, application.TextError) {
	t.Helper()
	report, kind, err := s.Analyze(t.Context(), scope, text, url, mode)
	if err != nil {
		t.Fatal(err)
	}
	return string(report), kind
}

func TestRulesModeNeverTouchesTheEmbedder(t *testing.T) {
	t.Parallel()
	embedder := &recording{egress: application.EgressLocal}
	got, kind := analyze(t, &application.Semantic{Text: &fakeAnalyzer{}, Embedder: embedder}, "texto", "", "rules")
	if kind != "" || got != rulesReport(rulesNote) {
		t.Fatalf("%q %s", kind, got)
	}
	if len(embedder.sent) != 0 {
		t.Fatalf("sent %q", embedder.sent)
	}
}

func TestModeAndURLAreCheckedBeforeTheText(t *testing.T) {
	t.Parallel()
	cases := []struct {
		name, url, mode string
		want            application.TextError
	}{
		{"unknown mode", "", "magic", "mode"},
		{"empty mode", "", "", "mode"},
		{"mode before url", "ftp://x", "magic", "mode"},
		{"not public", "ftp://example.org", "rules", "url"},
	}
	for _, c := range cases {
		text := &fakeAnalyzer{}
		s := &application.Semantic{Text: text, Embedder: &recording{egress: application.EgressLocal}}
		if got, kind := analyze(t, s, "texto", c.url, c.mode); kind != c.want || got != "" {
			t.Errorf("%s: %q %s", c.name, kind, got)
		}
		if text.calls != 0 {
			t.Errorf("%s: the text was analysed", c.name)
		}
	}
}

func TestTextErrorsComeThrough(t *testing.T) {
	t.Parallel()
	embedder := &recording{egress: application.EgressLocal}
	s := &application.Semantic{Text: &fakeAnalyzer{kind: "too_long"}, Embedder: embedder}
	if got, kind := analyze(t, s, "texto", "", "semantic"); kind != "too_long" || got != "" {
		t.Fatalf("%q %s", kind, got)
	}
	if len(embedder.sent) != 0 {
		t.Fatal("a refused text reached the embedder")
	}
}

func TestAFailingEngineFailsTheRequest(t *testing.T) {
	t.Parallel()
	s := &application.Semantic{Text: &fakeAnalyzer{err: errors.New("engine")}, Embedder: &recording{egress: application.EgressLocal}}
	if _, _, err := s.Analyze(t.Context(), scope, "t", "", "automatic"); err == nil {
		t.Fatal("expected the error")
	}
}

func TestLocalModelGetsTheTrimmedTextAndEveryConcept(t *testing.T) {
	t.Parallel()
	water := domain.SemanticConcepts[0].Reference
	embedder := &recording{egress: application.EgressLocal, vectorOf: func(text string) ([]float64, error) {
		if text == water || text == "agua Marcos Villanueva Prado" {
			return []float64{1, 0}, nil
		}
		return []float64{0, 1}, nil
	}}
	got, _ := analyze(t, &application.Semantic{Text: &fakeAnalyzer{}, Embedder: embedder}, "  agua Marcos Villanueva Prado\n", "", "automatic")
	want := `{"version":"2.5","source_url":"","method":"Análisis híbrido: reglas y similitud semántica local. Requiere corroboración.","evidence":{"sha256":"ab"},` +
		`"semantic":{"active":true,"method":"Similitud coseno de embeddings del modelo local Ollama","model":"fake-embed",` +
		`"matches":[{"theme":"Ambiente y agua","similarity":1,"reference":"` + water + `"}],` +
		`"note":"Los valores son similitudes relativas, no probabilidades de conflicto ni pruebas de veracidad."},` +
		`"verification_status":"Pendiente de corroboración","source_retrieved":false}`
	if got != want {
		t.Fatalf("got  %s\nwant %s", got, want)
	}
	if len(embedder.sent) != 8 || !slices.Contains(embedder.sent, "agua Marcos Villanueva Prado") {
		t.Fatalf("sent %q", embedder.sent)
	}
}

func TestConceptVectorsAreKept(t *testing.T) {
	t.Parallel()
	embedder := &recording{egress: application.EgressLocal}
	s := &application.Semantic{Text: &fakeAnalyzer{}, Embedder: embedder}
	analyze(t, s, "uno", "", "automatic")
	analyze(t, s, "dos", "", "automatic")
	if len(embedder.sent) != 9 {
		t.Fatalf("sent %d texts", len(embedder.sent))
	}
}

func TestAFailedEmbeddingFallsBackOrRefuses(t *testing.T) {
	t.Parallel()
	down := func(string) ([]float64, error) { return nil, errors.New("offline") }
	s := func() *application.Semantic {
		return &application.Semantic{Text: &fakeAnalyzer{}, Embedder: &recording{egress: application.EgressLocal, vectorOf: down}}
	}
	if got, kind := analyze(t, s(), "t", "", "automatic"); kind != "" || got != rulesReport(fallbackNote) {
		t.Fatalf("%q %s", kind, got)
	}
	if got, kind := analyze(t, s(), "t", "", "semantic"); kind != "unavailable" || got != "" {
		t.Fatalf("%q %s", kind, got)
	}
}

func TestAFailedConceptFallsBackAndIsNotKept(t *testing.T) {
	t.Parallel()
	failing := true
	embedder := &recording{egress: application.EgressLocal, vectorOf: func(text string) ([]float64, error) {
		if failing && text == domain.SemanticConcepts[3].Reference {
			return nil, errors.New("offline")
		}
		return []float64{0, 1}, nil
	}}
	s := &application.Semantic{Text: &fakeAnalyzer{}, Embedder: embedder}
	if got, _ := analyze(t, s, "t", "", "automatic"); got != rulesReport(fallbackNote) {
		t.Fatal(got)
	}
	failing = false
	if got, _ := analyze(t, s, "t", "", "automatic"); !strings.Contains(got, `"active":true`) {
		t.Fatal(got)
	}
}

func TestExternalModelGetsNothingWhileTheSwitchIsOff(t *testing.T) {
	t.Parallel()
	for mode, wantKind := range map[string]application.TextError{"automatic": "", "semantic": "unavailable"} {
		embedder := &recording{egress: application.EgressExternal}
		fakes := &guardFakes{}
		s := &application.Semantic{Text: &fakeAnalyzer{}, Embedder: embedder, Egress: guardOf(fakes)}
		got, kind := analyze(t, s, "Marcos Villanueva Prado", "", mode)
		if kind != wantKind {
			t.Fatalf("%s: %q %s", mode, kind, got)
		}
		if len(embedder.sent) != 0 || len(fakes.log) != 0 {
			t.Fatalf("%s: sent %q, logged %v", mode, embedder.sent, fakes.log)
		}
	}
}

func TestExternalModelGetsNothingWithoutAGuard(t *testing.T) {
	t.Parallel()
	embedder := &recording{egress: application.EgressExternal}
	s := &application.Semantic{Text: &fakeAnalyzer{}, Embedder: embedder}
	if got, kind := analyze(t, s, "texto", "", "semantic"); kind != "unavailable" || got != "" {
		t.Fatalf("%q %s", kind, got)
	}
	if len(embedder.sent) != 0 {
		t.Fatalf("sent %q", embedder.sent)
	}
}

func TestAnyEgressButLocalGoesThroughTheGuard(t *testing.T) {
	t.Parallel()
	embedder := &recording{egress: ""}
	s := &application.Semantic{Text: &fakeAnalyzer{}, Embedder: embedder, Egress: guardOf(&guardFakes{})}
	if _, kind := analyze(t, s, "texto", "", "semantic"); kind != "unavailable" {
		t.Fatalf("kind = %q", kind)
	}
	if len(embedder.sent) != 0 {
		t.Fatalf("sent %q", embedder.sent)
	}
}

func TestExternalModelGetsTheScrubbedTextOnceTheSwitchIsOn(t *testing.T) {
	t.Parallel()
	embedder := &recording{egress: application.EgressExternal}
	fakes := &guardFakes{enabled: true}
	s := &application.Semantic{Text: &fakeAnalyzer{}, Embedder: embedder, Egress: guardOf(fakes)}
	text := "  Escribió Marcos Villanueva Prado (marcos.villanueva@example.org, +51 987 654 321) pidiendo agua.  "
	if got, _ := analyze(t, s, text, "", "semantic"); !strings.Contains(got, `"active":true`) {
		t.Fatal(got)
	}
	var message string
	for _, sent := range embedder.sent {
		for _, leak := range []string{"Marcos", "Villanueva", "marcos.villanueva", "example.org", "987 654 321"} {
			if strings.Contains(sent, leak) {
				t.Errorf("%q left in %q", leak, sent)
			}
		}
		if strings.Contains(sent, "Escribió") {
			message = sent
		}
	}
	if message == "" || message != strings.TrimSpace(message) {
		t.Fatalf("message = %q", message)
	}
	if len(fakes.log) != 1 {
		t.Fatalf("log = %v", fakes.log)
	}
	detail := fakes.log[0].Detail
	if !strings.Contains(detail, "embeddings") || !strings.Contains(detail, "semantic-analyze") || strings.Contains(detail, "Marcos") {
		t.Fatalf("detail = %q", detail)
	}
}

func TestAFailedLogKeepsTheTextHome(t *testing.T) {
	t.Parallel()
	embedder := &recording{egress: application.EgressExternal}
	fakes := &failingLog{guardFakes: guardFakes{enabled: true}}
	guard := privacy.NewGuard(privacy.Deps{
		Switch: fakes, Names: fakes, Log: fakes, Keys: infrastructure.NewKeys(bytes.Repeat([]byte{7}, 32)),
	})
	s := &application.Semantic{Text: &fakeAnalyzer{}, Embedder: embedder, Egress: guard}
	if _, kind := analyze(t, s, "texto", "", "semantic"); kind != "unavailable" {
		t.Fatalf("kind = %q", kind)
	}
	if len(embedder.sent) != 0 {
		t.Fatalf("sent %q", embedder.sent)
	}
}

type failingLog struct{ guardFakes }

func (*failingLog) Append(context.Context, string, privacy.EgressLogEntry) error {
	return errors.New("audit down")
}

func TestAMalformedReportFailsTheRequest(t *testing.T) {
	t.Parallel()
	s := &application.Semantic{Text: brokenAnalyzer{}, Embedder: &recording{egress: application.EgressLocal}}
	if _, _, err := s.Analyze(t.Context(), scope, "t", "", "rules"); err == nil {
		t.Fatal("expected the error")
	}
}

type brokenAnalyzer struct{}

func (brokenAnalyzer) AnalyzeText(context.Context, tenancy.Scope, string, string) (json.RawMessage, application.TextError, error) {
	return json.RawMessage(`[]`), "", nil
}
