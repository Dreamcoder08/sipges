package app

import (
	"context"
	"strings"
	"testing"

	"github.com/Dreamcoder08/sipges/apps/api-go/internal/platform/engines"
)

func TestMetricsCountTheIndicatorsMemo(t *testing.T) {
	t.Parallel()
	set, err := engines.Shared(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	m := newMetrics(set)
	before := set.IndicatorsMemo().Stats()
	for range 2 {
		if _, err := set.IndicatorsMemo().Call(context.Background(), []byte(`{"op":"defaults"}`)); err != nil {
			t.Fatal(err)
		}
	}
	after := set.IndicatorsMemo().Stats()
	text := m.Render()
	for _, want := range []string{
		"# TYPE sipges_engine_memo_hits_total counter\nsipges_engine_memo_hits_total ",
		"# TYPE sipges_engine_memo_misses_total counter\nsipges_engine_memo_misses_total ",
		"# TYPE sipges_engine_memo_evictions_total counter\nsipges_engine_memo_evictions_total ",
	} {
		if !strings.Contains(text, want) {
			t.Errorf("missing %q in\n%s", want, text)
		}
	}
	if after.Hits <= before.Hits {
		t.Fatalf("hits %d → %d: the repeated request was not a hit", before.Hits, after.Hits)
	}
}
