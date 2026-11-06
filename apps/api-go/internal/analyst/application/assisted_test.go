//nolint:misspell // Spanish notices, verbatim from the TypeScript API.
package application_test

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/Dreamcoder08/sipges/apps/api-go/internal/analyst/application"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/analyst/domain"
	privacy "github.com/Dreamcoder08/sipges/apps/api-go/internal/privacy/application"
	privacydomain "github.com/Dreamcoder08/sipges/apps/api-go/internal/privacy/domain"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/privacy/infrastructure"
)

const (
	tenant        = "SIPGES/PRJ-SECHURA"
	noticeFailed  = "El resumen asistido no estuvo disponible; se muestra el informe extractivo."
	noticeRefused = "El registro está restringido; el resumen asistido no se genera para información restringida."
)

var at = time.Date(2026, 11, 3, 11, 0, 0, 0, time.UTC)

type fakeNarrator struct {
	seen  []string
	reply func(sent string) (string, error)
}

func (f *fakeNarrator) Name() string { return "claude:prueba" }
func (f *fakeNarrator) Narrate(_ context.Context, briefing privacy.Sanitised[string]) (string, error) {
	f.seen = append(f.seen, briefing.Value())
	return f.reply(briefing.Value())
}

func saying(text string) *fakeNarrator {
	return &fakeNarrator{reply: func(string) (string, error) { return text, nil }}
}

type guardFakes struct {
	enabled bool
	logErr  error
	mu      sync.Mutex
	log     []privacy.EgressLogEntry
}

func (g *guardFakes) Enabled(context.Context, string) (bool, error) { return g.enabled, nil }
func (g *guardFakes) Load(context.Context, string) ([]privacydomain.KnownName, error) {
	return []privacydomain.KnownName{{Kind: privacydomain.Actor, Name: "Comunidad Norte Sintética"}}, nil
}

func (g *guardFakes) Append(_ context.Context, _ string, entry privacy.EgressLogEntry) error {
	g.mu.Lock()
	defer g.mu.Unlock()
	if g.logErr != nil {
		return g.logErr
	}
	g.log = append(g.log, entry)
	return nil
}

func guardOf(g *guardFakes) *privacy.Guard {
	return privacy.NewGuard(privacy.Deps{
		Switch: g, Names: g, Log: g, Keys: infrastructure.NewKeys(bytes.Repeat([]byte{7}, 32)),
		Now: func() time.Time { return at },
	})
}

func summary(slug, id, title, marking string, fields ...domain.Field) domain.Summary {
	return domain.Summary{Slug: slug, ID: id, TypeLabel: "Tipo " + slug, Title: title, Marking: marking, Fields: fields}
}

func neighbourhood() application.Neighbourhood {
	return application.Neighbourhood{
		Subject: summary("actores", "A-1", "Comunidad Norte Sintética", "interno",
			domain.Field{Key: "Tipo_Actor", Value: "Comunidad"}, domain.Field{Key: "Posicion_Proyecto", Value: "En contra"}),
		Connections: []domain.Connection{
			{LinkType: "participa", Label: "participa en", Other: summary("eventos", "EV-1", "Asamblea sintética", "interno")},
			{LinkType: "participa", Label: "participa en", Other: summary("eventos", "EV-2", "Reunión reservada", "restringido")},
		},
	}
}

func assistedOf(n application.Narrator, g application.EgressOpener) application.Assisted {
	return application.Assisted{Narrator: n, Egress: g}
}

func TestAClearedBriefingBecomesProseWithItsCitations(t *testing.T) {
	t.Parallel()
	narrator := saying("  La comunidad participa en la asamblea [1] y [2], también [1].  ")
	fakes := &guardFakes{enabled: true}
	found := neighbourhood()
	got := assistedOf(narrator, guardOf(fakes)).Brief(t.Context(), tenant, found, at)
	if got.Engine != "asistido" || got.Notice != nil || got.Narrator == nil || *got.Narrator != "claude:prueba" {
		t.Fatalf("%+v", got)
	}
	if got.Narrative == nil {
		t.Fatal("no narrative")
	}
	full := domain.BuildBriefing(found.Subject, found.Connections, application.Today(at))
	if len(got.Sections) != len(full.Sections) || len(got.Sources) != len(full.Sources) {
		t.Fatalf("the team keeps the full briefing: %+v", got.Briefing)
	}
	if len(narrator.seen) != 1 || len(fakes.log) != 1 {
		t.Fatalf("seen %d, log %d", len(narrator.seen), len(fakes.log))
	}
	if detail := fakes.log[0].Detail; !strings.Contains(detail, "analyst") || !strings.Contains(detail, "briefing") ||
		!strings.Contains(detail, "actores/A-1") || strings.Contains(detail, "Comunidad Norte") {
		t.Fatalf("detail = %q", detail)
	}
}

func TestTheModelSeesNoNamesHiddenFieldsOrRestrictedNeighbours(t *testing.T) {
	t.Parallel()
	narrator := saying("Hecho [1].")
	assistedOf(narrator, guardOf(&guardFakes{enabled: true})).Brief(t.Context(), tenant, neighbourhood(), at)
	if len(narrator.seen) != 1 {
		t.Fatal("not narrated")
	}
	for _, leak := range []string{"Comunidad Norte", "Posicion", "En contra", "Reunión reservada", "EV-2"} {
		if strings.Contains(narrator.seen[0], leak) {
			t.Errorf("%q left in %q", leak, narrator.seen[0])
		}
	}
	if !strings.Contains(narrator.seen[0], "EV-1") {
		t.Fatalf("the shared neighbour is missing: %q", narrator.seen[0])
	}
}

func TestCitationsAreRenumberedOntoTheFullBriefing(t *testing.T) {
	t.Parallel()
	// The restricted record is the newest, so it sorts first and only the full briefing numbers it.
	newest := "2026-10-01"
	restricted := summary("eventos", "EV-R", "Reservado", "restringido")
	restricted.Date = &newest
	found := application.Neighbourhood{
		Subject: summary("actores", "A-1", "Actor", "interno"),
		Connections: []domain.Connection{
			{LinkType: "participa", Label: "participa en", Other: restricted},
			{LinkType: "participa", Label: "participa en", Other: summary("eventos", "EV-1", "Abierto", "interno")},
		},
	}
	full := domain.BuildBriefing(found.Subject, found.Connections, application.Today(at))
	want := 0
	for _, source := range full.Sources {
		if source.ID == "EV-1" {
			want = source.Ref
		}
	}
	var shared int
	narrator := &fakeNarrator{reply: func(sent string) (string, error) {
		for _, line := range strings.Split(sent, "\n") {
			if strings.Contains(line, "EV-1:") {
				shared = int(line[1] - '0')
			}
		}
		return "Abierto [" + string(rune('0'+shared)) + "].", nil
	}}
	got := assistedOf(narrator, guardOf(&guardFakes{enabled: true})).Brief(t.Context(), tenant, found, at)
	if got.Narrative == nil || len(got.Narrative.Refs) != 1 || got.Narrative.Refs[0] != want || want == shared {
		t.Fatalf("shared %d, want %d, got %+v", shared, want, got.Narrative)
	}
}

func TestTheExtractiveBriefingStaysWhenNarrationCannotRun(t *testing.T) {
	t.Parallel()
	down := &fakeNarrator{reply: func(string) (string, error) { return "", errors.New("offline") }}
	cases := []struct {
		name     string
		narrator *fakeNarrator
		guard    application.EgressOpener
		found    application.Neighbourhood
		notice   string
		calls    int
	}{
		{"switch off", saying("x [1]"), guardOf(&guardFakes{}), neighbourhood(), noticeFailed, 0},
		{"no guard", saying("x [1]"), nil, neighbourhood(), noticeFailed, 0},
		{"log fails", saying("x [1]"), guardOf(&guardFakes{enabled: true, logErr: errors.New("down")}), neighbourhood(), noticeFailed, 0},
		{"model down", down, guardOf(&guardFakes{enabled: true}), neighbourhood(), noticeFailed, 1},
		{"no citation", saying("Sin fuentes."), guardOf(&guardFakes{enabled: true}), neighbourhood(), noticeFailed, 1},
		{"unknown citation", saying("Inventado [99]."), guardOf(&guardFakes{enabled: true}), neighbourhood(), noticeFailed, 1},
		{"blank answer", saying("   "), guardOf(&guardFakes{enabled: true}), neighbourhood(), noticeFailed, 1},
		{
			"restricted subject", saying("x [1]"), guardOf(&guardFakes{enabled: true}),
			application.Neighbourhood{Subject: summary("eventos", "EV-2", "Reservado", "restringido")}, noticeRefused, 0,
		},
	}
	for _, c := range cases {
		before := len(c.narrator.seen)
		got := assistedOf(c.narrator, c.guard).Brief(t.Context(), tenant, c.found, at)
		if got.Engine != "extractivo" || got.Narrative != nil || got.Narrator != nil || got.Notice == nil || *got.Notice != c.notice {
			t.Errorf("%s: %+v", c.name, got)
		}
		if calls := len(c.narrator.seen) - before; calls != c.calls {
			t.Errorf("%s: %d calls", c.name, calls)
		}
	}
}

func logged(t *testing.T, n application.Narrator, g application.EgressOpener) string {
	t.Helper()
	var out bytes.Buffer
	assisted := application.Assisted{
		Narrator: n, Egress: g,
		Logger: slog.New(slog.NewTextHandler(&out, &slog.HandlerOptions{Level: slog.LevelInfo})),
	}
	assisted.Brief(t.Context(), tenant, neighbourhood(), at)
	return out.String()
}

func TestFailuresLogAClosedReasonAndNoText(t *testing.T) {
	t.Parallel()
	down := &fakeNarrator{reply: func(string) (string, error) {
		return "", errors.New("narrator: the model answered 401")
	}}
	logFails := &guardFakes{enabled: true, logErr: errors.New("connection to synthetic-db refused")}
	cases := []struct {
		name  string
		lines string
		want  []string
	}{
		{"model", logged(t, down, guardOf(&guardFakes{enabled: true})), []string{"level=WARN", "reason=narrator", `"narrator: the model answered 401"`}},
		{"guard", logged(t, saying("x [1]"), guardOf(logFails)), []string{"level=WARN", "reason=guard"}},
		{"no guard", logged(t, saying("x [1]"), nil), []string{"level=WARN", "reason=guard"}},
		{"citation", logged(t, saying("Sin fuentes."), guardOf(&guardFakes{enabled: true})), []string{"level=WARN", "reason=citation"}},
	}
	for _, c := range cases {
		for _, want := range c.want {
			if !strings.Contains(c.lines, want) {
				t.Errorf("%s: %q not in %q", c.name, want, c.lines)
			}
		}
		for _, leak := range []string{"synthetic-db", "Comunidad", "Sin fuentes"} {
			if strings.Contains(c.lines, leak) {
				t.Errorf("%s: %q leaked in %q", c.name, leak, c.lines)
			}
		}
	}
}

func TestASwitchedOffProjectLogsNoFailure(t *testing.T) {
	t.Parallel()
	if lines := logged(t, saying("x [1]"), guardOf(&guardFakes{})); strings.Contains(lines, "briefing_narration_failed") {
		t.Fatalf("logged %q", lines)
	}
}

func TestProseIsCutAtFourThousandUnits(t *testing.T) {
	t.Parallel()
	narrator := saying("Hecho [1]. " + strings.Repeat("😀", 2500))
	got := assistedOf(narrator, guardOf(&guardFakes{enabled: true})).Brief(t.Context(), tenant, neighbourhood(), at)
	if got.Narrative == nil {
		t.Fatal("no narrative")
	}
	body, err := json.Marshal(domain.Text(got.Narrative.Text))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasSuffix(string(body), `\ud83d"`) {
		t.Fatalf("the cut must fall in the middle of the last emoji: …%s", body[len(body)-12:])
	}
}

// OutsideBriefing is what the MCP tool get_briefing answers: built from the sanitised view, also
// when a narrator writes the prose, and its citations point at that same briefing.
func TestOutsideBriefingShowsOnlyTheSanitisedView(t *testing.T) {
	g := &guardFakes{enabled: true}
	guard := guardOf(g)
	session, err := guard.Open(t.Context(), privacy.Request{TenantID: tenant, Channel: privacy.ChannelMCP, Purpose: "get_briefing"})
	if err != nil {
		t.Fatal(err)
	}
	found := neighbourhood()
	narrator := saying("Los hechos constan en [1].")
	assisted := &application.Assisted{Narrator: narrator, Egress: guard}
	got := application.OutsideBriefing(t.Context(), assisted, session, tenant, found, at)
	if got.Engine != application.EngineAssisted || got.Narrative == nil || got.Withheld {
		t.Fatalf("%+v", got)
	}
	if strings.Contains(got.Subject.Title, "Comunidad Norte Sintética") {
		t.Errorf("the subject keeps its name: %q", got.Subject.Title)
	}
	for _, source := range got.Sources {
		if source.ID == "EV-2" {
			t.Errorf("a restricted neighbour is cited: %+v", source)
		}
	}
	session, err = guard.Open(t.Context(), privacy.Request{TenantID: tenant, Channel: privacy.ChannelMCP, Purpose: "get_briefing"})
	if err != nil {
		t.Fatal(err)
	}
	if plain := application.OutsideBriefing(t.Context(), nil, session, tenant, found, at); plain.Engine != application.EngineExtractive || plain.Narrative != nil {
		t.Errorf("without a narrator: %+v", plain)
	}
}

func TestOutsideBriefingWithholdsARestrictedSubject(t *testing.T) {
	guard := guardOf(&guardFakes{enabled: true})
	session, err := guard.Open(t.Context(), privacy.Request{TenantID: tenant, Channel: privacy.ChannelMCP, Purpose: "get_briefing"})
	if err != nil {
		t.Fatal(err)
	}
	found := neighbourhood()
	found.Subject.Marking = "restringido"
	narrator := saying("[1]")
	got := application.OutsideBriefing(t.Context(), &application.Assisted{Narrator: narrator, Egress: guard}, session, tenant, found, at)
	if !got.Withheld || len(narrator.seen) != 0 {
		t.Errorf("%+v, narrator saw %d", got, len(narrator.seen))
	}
}
