package infrastructure

import (
	"fmt"
	"strings"
	"testing"

	"github.com/Dreamcoder08/sipges/apps/api-go/internal/platform/synthetic"
)

// summaryPage is a json_agg page of 500 synthetic rows, as the summary statement returns it.
func summaryPage() string {
	var b strings.Builder
	b.WriteByte('[')
	n := 0
	all := synthetic.Records(10)
	for _, module := range []string{"Eventos", "Actores", "Demandas", "Alertas", "Directorio_Territorial"} { //nolint:misspell // module names
		for _, rec := range all[module] {
			if n == 500 {
				break
			}
			if n > 0 {
				b.WriteString(", \n ")
			}
			fmt.Fprintf(&b, `{"module":%q,"id":%q,"payload":%s,"updated_at":"2026-01-01T00:%02d:00+00:00","position":1}`,
				module, rec.ID, rec.Payload, n%60)
			n++
		}
	}
	b.WriteByte(']')
	return b.String()
}

func BenchmarkSummaryRows(b *testing.B) {
	text := summaryPage()
	b.SetBytes(int64(len(text)))
	b.ReportAllocs()
	for b.Loop() {
		if rows, err := summaryRows(text); err != nil || len(rows) != 500 {
			b.Fatal(len(rows), err)
		}
	}
}

func BenchmarkPayloadObject(b *testing.B) {
	records := synthetic.Records(10)["Eventos"]
	b.ReportAllocs()
	for b.Loop() {
		for _, rec := range records {
			if _, err := payloadObject(rec.Payload); err != nil {
				b.Fatal(err)
			}
		}
	}
}
