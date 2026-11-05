//nolint:misspell // Spanish record fields, verbatim from the TypeScript API.
package application_test

import (
	"bytes"
	"context"
	"errors"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/Dreamcoder08/sipges/apps/api-go/internal/ontology/application"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/ontology/domain"
	privacy "github.com/Dreamcoder08/sipges/apps/api-go/internal/privacy/application"
	privacydomain "github.com/Dreamcoder08/sipges/apps/api-go/internal/privacy/domain"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/privacy/infrastructure"
)

const tenant = "SIPGES/PRJ-SECHURA"

var at = time.Date(2026, 11, 3, 11, 0, 0, 987654321, time.UTC)

type recording struct {
	egress   string
	sent     []string
	vectorOf func(text string) ([]float64, error)
}

func (r *recording) Model() string  { return "fake-embed" }
func (r *recording) Egress() string { return r.egress }
func (r *recording) Embed(_ context.Context, text privacy.Sanitised[string]) ([]float64, error) {
	r.sent = append(r.sent, text.Value())
	if r.vectorOf != nil {
		return r.vectorOf(text.Value())
	}
	return []float64{1, 0}, nil
}

type fakeIndex struct {
	stale      []application.EmbeddingSource
	vectors    []application.StoredVector
	saved      []application.EmbeddingRow
	savedModel string
	savedAt    time.Time
	saveErr    error
	asked      []int
	modules    []string
	transacts  int
}

func (f *fakeIndex) Stale(_ context.Context, model string, limit int) ([]application.EmbeddingSource, error) {
	if model != "fake-embed" {
		return nil, errors.New("unexpected model")
	}
	f.asked = append(f.asked, limit)
	return f.stale, nil
}

func (f *fakeIndex) Save(_ context.Context, rows []application.EmbeddingRow, model string, savedAt time.Time) error {
	f.saved, f.savedModel, f.savedAt = rows, model, savedAt
	return f.saveErr
}

func (f *fakeIndex) Vectors(_ context.Context, modules []string, _ string, _ int) ([]application.StoredVector, error) {
	f.modules = modules
	return f.vectors, nil
}

func (f *fakeIndex) tx(work func(context.Context, application.EmbeddingIndex) error) error {
	f.transacts++
	return work(context.Background(), f)
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
		Now: func() time.Time { return at },
	})
}

func source(t *testing.T, module, id, payload, marking string) application.EmbeddingSource {
	t.Helper()
	decoded, err := domain.DecodePayload([]byte(payload))
	if err != nil {
		t.Fatal(err)
	}
	entries, err := domain.OrderedEntries([]byte(payload))
	if err != nil {
		t.Fatal(err)
	}
	return application.EmbeddingSource{
		NodeRef: application.NodeRef{Module: module, ID: id}, Payload: decoded, Entries: entries,
		Marking: marking, Hash: "hash-" + id,
	}
}

func semanticOf(e application.Embedder, g application.EgressOpener) *application.Semantic {
	return &application.Semantic{Embedder: e, Egress: g, Now: func() time.Time { return at }}
}

func TestLocalModelEmbedsStaleRecordsAndRanksTheVisibleOnes(t *testing.T) {
	t.Parallel()
	embedder := &recording{egress: application.EgressLocal}
	index := &fakeIndex{
		stale: []application.EmbeddingSource{source(t, "Eventos", "EV-1", `{"Descripcion_Hecho":"Agua","Nota":"Marcos Villanueva Prado"}`, "interno")},
		vectors: []application.StoredVector{
			{NodeRef: application.NodeRef{Module: "Eventos", ID: "lejos"}, Vector: []float64{0.44, 0.898}},
			{NodeRef: application.NodeRef{Module: "Eventos", ID: "medio"}, Vector: []float64{0.5, 0.866}},
			{NodeRef: application.NodeRef{Module: "Eventos", ID: "cerca"}, Vector: []float64{1, 0}},
			{NodeRef: application.NodeRef{Module: "Eventos", ID: "otro-largo"}, Vector: []float64{1, 0, 0}},
		},
	}
	refs, err := semanticOf(embedder, nil).Refs(t.Context(), tenant, "  agua  ", []string{"Eventos"}, 10, index.tx)
	if err != nil {
		t.Fatal(err)
	}
	if !slices.Equal(refs, []application.NodeRef{{Module: "Eventos", ID: "cerca"}, {Module: "Eventos", ID: "medio"}}) {
		t.Fatalf("refs = %+v", refs)
	}
	if len(embedder.sent) != 2 || embedder.sent[1] != "agua" {
		t.Fatalf("sent = %q", embedder.sent)
	}
	if !strings.Contains(embedder.sent[0], "Nota: Marcos Villanueva Prado") {
		t.Fatalf("a local model reads the record as it is: %q", embedder.sent[0])
	}
	if index.asked[0] != 16 || !slices.Equal(index.modules, []string{"Eventos"}) {
		t.Fatalf("asked %v for %v", index.asked, index.modules)
	}
	if len(index.saved) != 1 || index.saved[0].Hash != "hash-EV-1" || index.savedModel != "fake-embed" ||
		!index.savedAt.Equal(at.Truncate(time.Millisecond)) {
		t.Fatalf("saved = %+v at %v", index.saved, index.savedAt)
	}
	if index.transacts != 3 {
		t.Fatalf("expected a transaction per step, none held across the model: %d", index.transacts)
	}
}

func TestRefsAreCutAtTheLimitBestFirst(t *testing.T) {
	t.Parallel()
	index := &fakeIndex{vectors: []application.StoredVector{
		{NodeRef: application.NodeRef{Module: "Eventos", ID: "a"}, Vector: []float64{0.6, 0.8}},
		{NodeRef: application.NodeRef{Module: "Eventos", ID: "b"}, Vector: []float64{1, 0}},
		{NodeRef: application.NodeRef{Module: "Eventos", ID: "c"}, Vector: []float64{0.8, 0.6}},
	}}
	refs, err := semanticOf(&recording{egress: application.EgressLocal}, nil).Refs(t.Context(), tenant, "q", nil, 2, index.tx)
	if err != nil {
		t.Fatal(err)
	}
	if !slices.Equal(refs, []application.NodeRef{{Module: "Eventos", ID: "b"}, {Module: "Eventos", ID: "c"}}) {
		t.Fatalf("refs = %+v", refs)
	}
}

func TestAModuleOutsideTheCatalogIsNotEmbedded(t *testing.T) {
	t.Parallel()
	embedder := &recording{egress: application.EgressLocal}
	index := &fakeIndex{stale: []application.EmbeddingSource{source(t, "SinCatalogo", "X", `{"a":"b"}`, "interno")}}
	if _, err := semanticOf(embedder, nil).Refs(t.Context(), tenant, "q", nil, 5, index.tx); err != nil {
		t.Fatal(err)
	}
	if len(embedder.sent) != 1 || len(index.saved) != 0 {
		t.Fatalf("sent %q, saved %v", embedder.sent, index.saved)
	}
}

func TestAFailedEmbeddingSavesNothingAndReturnsTheError(t *testing.T) {
	t.Parallel()
	calls := 0
	embedder := &recording{egress: application.EgressLocal, vectorOf: func(string) ([]float64, error) {
		calls++
		if calls == 2 {
			return nil, errors.New("offline")
		}
		return []float64{1, 0}, nil
	}}
	index := &fakeIndex{stale: []application.EmbeddingSource{
		source(t, "Eventos", "EV-1", `{"a":"uno"}`, "interno"), source(t, "Eventos", "EV-2", `{"a":"dos"}`, "interno"),
	}}
	if _, err := semanticOf(embedder, nil).Refs(t.Context(), tenant, "q", nil, 5, index.tx); err == nil {
		t.Fatal("expected the error")
	}
	if len(index.saved) != 0 {
		t.Fatalf("saved %v", index.saved)
	}
}

func TestExternalModelGetsNothingWhileTheSwitchIsOff(t *testing.T) {
	t.Parallel()
	embedder := &recording{egress: application.EgressExternal}
	fakes := &guardFakes{}
	index := &fakeIndex{stale: []application.EmbeddingSource{source(t, "Eventos", "EV-1", `{"a":"b"}`, "interno")}}
	if _, err := semanticOf(embedder, guardOf(fakes)).Refs(t.Context(), tenant, "secreto", nil, 5, index.tx); !errors.Is(err, privacy.ErrDisabled) {
		t.Fatalf("error = %v", err)
	}
	if len(embedder.sent) != 0 || len(fakes.log) != 0 {
		t.Fatalf("sent %q, logged %v", embedder.sent, fakes.log)
	}
}

func TestExternalModelGetsNothingWithoutAGuard(t *testing.T) {
	t.Parallel()
	embedder := &recording{egress: application.EgressExternal}
	if _, err := semanticOf(embedder, nil).Refs(t.Context(), tenant, "secreto", nil, 5, (&fakeIndex{}).tx); err == nil {
		t.Fatal("expected the error")
	}
	if len(embedder.sent) != 0 {
		t.Fatalf("sent %q", embedder.sent)
	}
}

func TestAnyEgressButLocalGoesThroughTheGuard(t *testing.T) {
	t.Parallel()
	embedder := &recording{egress: ""}
	if _, err := semanticOf(embedder, guardOf(&guardFakes{})).Refs(t.Context(), tenant, "q", nil, 5, (&fakeIndex{}).tx); err == nil {
		t.Fatal("expected the refusal")
	}
	if len(embedder.sent) != 0 {
		t.Fatalf("sent %q", embedder.sent)
	}
}

func TestExternalModelGetsOnlyAllowedPseudonymisedText(t *testing.T) {
	t.Parallel()
	embedder := &recording{egress: application.EgressExternal}
	fakes := &guardFakes{enabled: true}
	index := &fakeIndex{stale: []application.EmbeddingSource{
		source(t, "Actores", "ACT-1",
			`{"Nombre_Actor/Organizacion":"Marcos Villanueva Prado","Observaciones":"Notas internas marcos.villanueva@example.org","Posicion_Proyecto":"En contra","Tipo_Actor":"Comunidad"}`, "interno"),
		source(t, "Actores", "ACT-2", `{"Nombre_Actor/Organizacion":"Reservado sintético"}`, "restringido"),
	}}
	if _, err := semanticOf(embedder, guardOf(fakes)).Refs(t.Context(), tenant, "agua Marcos Villanueva Prado", nil, 5, index.tx); err != nil {
		t.Fatal(err)
	}
	if len(embedder.sent) != 2 {
		t.Fatalf("sent = %q", embedder.sent)
	}
	for _, text := range embedder.sent {
		for _, leak := range []string{"Marcos", "Villanueva", "marcos.villanueva", "Observaciones", "Posicion_Proyecto", "Notas internas", "Reservado"} {
			if strings.Contains(text, leak) {
				t.Errorf("%q left in %q", leak, text)
			}
		}
	}
	if len(index.saved) != 1 || index.saved[0].ID != "ACT-1" {
		t.Fatalf("a withheld record stays stale: %+v", index.saved)
	}
	if len(fakes.log) != 2 {
		t.Fatalf("log = %v", fakes.log)
	}
	if !strings.Contains(fakes.log[0].Detail, "index") || !strings.Contains(fakes.log[1].Detail, "search") {
		t.Fatalf("log = %v", fakes.log)
	}
	for _, entry := range fakes.log {
		if !strings.Contains(entry.Detail, "embeddings") || strings.Contains(entry.Detail, "Marcos") {
			t.Fatalf("detail = %q", entry.Detail)
		}
	}
}

func TestLocalModelOpensNoSession(t *testing.T) {
	t.Parallel()
	fakes := &guardFakes{}
	embedder := &recording{egress: application.EgressLocal}
	index := &fakeIndex{stale: []application.EmbeddingSource{source(t, "Eventos", "EV-1", `{"a":"b"}`, "interno")}}
	if _, err := semanticOf(embedder, guardOf(fakes)).Refs(t.Context(), tenant, "q", nil, 5, index.tx); err != nil {
		t.Fatal(err)
	}
	if len(fakes.log) != 0 {
		t.Fatalf("log = %v", fakes.log)
	}
}
