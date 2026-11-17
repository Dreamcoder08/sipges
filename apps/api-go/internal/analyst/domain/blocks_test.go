//nolint:misspell // Spanish record modules and messages in synthetic fixtures.
package domain_test

import (
	"strings"
	"testing"

	"github.com/Dreamcoder08/sipges/apps/api-go/internal/analyst/domain"
)

func numbered() *domain.Sources {
	var s domain.Sources
	s.Add(domain.RecordRef{Slug: "conflictos", ID: "C-1", Title: "Bloqueo de vía"})
	s.Add(domain.RecordRef{Slug: "actores", ID: "A-7", Title: "Comunidad Norte"})
	return &s
}

const fence = "```bloques\n"

func TestSplitBlocksTakesTheFenceOutOfTheAnswer(t *testing.T) {
	t.Parallel()
	text, raw := domain.SplitBlocks("El bloqueo sigue [1].\n\n" + fence + `[{"tipo":"registro","fuente":1}]` + "\n```")
	if text != "El bloqueo sigue [1]." {
		t.Fatalf("text = %q", text)
	}
	if raw != `[{"tipo":"registro","fuente":1}]` {
		t.Fatalf("raw = %q", raw)
	}
	// An unclosed fence is still taken out: its JSON never reaches the person as text.
	text, raw = domain.SplitBlocks("El bloqueo sigue [1].\n" + fence + `[{"tipo":"mapa","fuente":1}`)
	if text != "El bloqueo sigue [1]." || raw != `[{"tipo":"mapa","fuente":1}` {
		t.Fatalf("unclosed: text = %q, raw = %q", text, raw)
	}
	if text, raw = domain.SplitBlocks("Sin bloques [1]."); text != "Sin bloques [1]." || raw != "" {
		t.Fatalf("plain: text = %q, raw = %q", text, raw)
	}
}

func TestResolveBlocksNamesEachKindByItsReturnedRecord(t *testing.T) {
	t.Parallel()
	blocks := domain.ResolveBlocks(`[
		{"tipo":"registro","fuente":1},
		{"tipo":"alerta","fuente":2,"texto":"La comunidad anunció un paro"},
		{"tipo":"mapa","fuente":1},
		{"tipo":"cronologia","fuente":1,"eventos":[{"fecha":"2026-03-02","texto":"Inicio del bloqueo"}]}
	]`, numbered())
	if len(blocks) != 4 {
		t.Fatalf("blocks = %+v, want 4", blocks)
	}
	want := []domain.BlockKind{domain.BlockRecord, domain.BlockAlert, domain.BlockMap, domain.BlockTimeline}
	for i, b := range blocks {
		if b.Kind != want[i] {
			t.Fatalf("block %d kind = %q, want %q", i, b.Kind, want[i])
		}
	}
	if blocks[1].Source.N != 2 || blocks[1].Source.ID != "A-7" || blocks[1].Text != "La comunidad anunció un paro" {
		t.Fatalf("alert = %+v", blocks[1])
	}
	if e := blocks[3].Entries; len(e) != 1 || e[0].Date != "2026-03-02" || e[0].Text != "Inicio del bloqueo" {
		t.Fatalf("timeline = %+v", blocks[3])
	}
}

func TestResolveBlocksDropsRecordsNoToolReturned(t *testing.T) {
	t.Parallel()
	blocks := domain.ResolveBlocks(`[{"tipo":"registro","fuente":3},{"tipo":"registro","fuente":0},{"tipo":"registro","fuente":2}]`, numbered())
	if len(blocks) != 1 || blocks[0].Source.N != 2 {
		t.Fatalf("blocks = %+v, want only source 2", blocks)
	}
}

func TestResolveBlocksDropsUnknownKinds(t *testing.T) {
	t.Parallel()
	blocks := domain.ResolveBlocks(`[{"tipo":"html","fuente":1,"texto":"<script>x</script>"},{"tipo":"grafico","fuente":1},{"tipo":"registro","fuente":1}]`, numbered())
	if len(blocks) != 1 || blocks[0].Kind != domain.BlockRecord {
		t.Fatalf("blocks = %+v, want only the record", blocks)
	}
}

func TestResolveBlocksDropsMalformedBlocks(t *testing.T) {
	t.Parallel()
	if blocks := domain.ResolveBlocks(`{"tipo":"registro"`, numbered()); len(blocks) != 0 {
		t.Fatalf("invalid JSON gave %+v", blocks)
	}
	if blocks := domain.ResolveBlocks(`{"tipo":"registro","fuente":1}`, numbered()); len(blocks) != 0 {
		t.Fatalf("an object, not a list, gave %+v", blocks)
	}
	long := strings.Repeat("a", 281)
	blocks := domain.ResolveBlocks(`[
		"registro",
		{"tipo":"registro","fuente":"1"},
		{"tipo":"alerta","fuente":1},
		{"tipo":"alerta","fuente":1,"texto":"`+long+`"},
		{"tipo":"cronologia","fuente":1,"eventos":[{"fecha":"ayer","texto":"x"}]},
		{"tipo":"cronologia","fuente":1},
		{"tipo":"mapa","fuente":2},
		{"tipo":"mapa","fuente":2}
	]`, numbered())
	if len(blocks) != 1 || blocks[0].Kind != domain.BlockMap || blocks[0].Source.N != 2 {
		t.Fatalf("blocks = %+v, want the one well-formed map block", blocks)
	}
}

func TestResolveBlocksKeepsAtMostFourBlocksAndFiveEvents(t *testing.T) {
	t.Parallel()
	events := strings.Repeat(`{"fecha":"2026-01-01","texto":"x"},`, 6)
	blocks := domain.ResolveBlocks(`[
		{"tipo":"cronologia","fuente":1,"eventos":[`+strings.TrimSuffix(events, ",")+`]},
		{"tipo":"registro","fuente":1},{"tipo":"registro","fuente":2},
		{"tipo":"mapa","fuente":1},{"tipo":"mapa","fuente":2}
	]`, numbered())
	if len(blocks) != domain.MaxBlocks {
		t.Fatalf("blocks = %d, want %d", len(blocks), domain.MaxBlocks)
	}
	if got := len(blocks[0].Entries); got != domain.MaxExcerptEntries {
		t.Fatalf("entries = %d, want %d", got, domain.MaxExcerptEntries)
	}
}
