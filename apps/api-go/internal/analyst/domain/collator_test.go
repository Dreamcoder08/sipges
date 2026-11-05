package domain_test

import (
	"sync"
	"testing"

	"github.com/Dreamcoder08/sipges/apps/api-go/internal/analyst/domain"
)

// A collator holds buffers, so requests served at once must not share one.
func TestConcurrentBriefingsDoNotShareACollator(t *testing.T) {
	t.Parallel()
	summary := func(id, label, title string) domain.Summary {
		return domain.Summary{Slug: "eventos", ID: id, TypeLabel: label, Title: title, Marking: "interno"}
	}
	connections := []domain.Connection{
		{LinkType: "participa", Label: "participa en", Other: summary("E1", "Evento", "Reunión sintética")},
		{LinkType: "participa", Label: "participa en", Other: summary("E2", "Alerta", "Ñandú sintético")},
		{LinkType: "participa", Label: "participa en", Other: summary("E3", "Actor", "Árbol sintético")},
		{LinkType: "participa", Label: "participa en", Other: summary("E4", "Fuente", "Zona sintética")},
	}
	var wg sync.WaitGroup
	for range 16 {
		wg.Go(func() {
			for range 200 {
				domain.BuildBriefing(summary("S", "Actor", "Sujeto"), connections, "2026-11-05")
			}
		})
	}
	wg.Wait()
}
