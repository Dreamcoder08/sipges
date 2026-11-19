package domain

import (
	"testing"

	"github.com/Dreamcoder08/sipges/apps/api-go/internal/platform/synthetic"
)

// syntheticRecords are the indicator modules of synthetic.Records(10): 2,450 records.
func syntheticRecords(tb testing.TB) Records {
	tb.Helper()
	out := Records{}
	all := synthetic.Records(10)
	for _, module := range Modules {
		for _, rec := range all[module] {
			out[module] = append(out[module], Record{ID: rec.ID, Payload: []byte(rec.Payload)})
		}
	}
	return out
}

func BenchmarkRecordsJSON(b *testing.B) {
	records := syntheticRecords(b)
	b.ReportAllocs()
	for b.Loop() {
		if _, err := records.JSON(); err != nil {
			b.Fatal(err)
		}
	}
}
