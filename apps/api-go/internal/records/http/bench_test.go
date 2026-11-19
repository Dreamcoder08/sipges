package http

import (
	"testing"
	"time"

	"github.com/Dreamcoder08/sipges/apps/api-go/internal/platform/synthetic"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/records/application"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/records/domain"
)

func BenchmarkListJSON(b *testing.B) {
	var rows []application.StoredRecord
	for _, rec := range synthetic.Records(20)["Eventos"][:500] {
		payload, err := domain.ParseObject([]byte(rec.Payload))
		if err != nil {
			b.Fatal(err)
		}
		rows = append(rows, application.StoredRecord{ID: rec.ID, Payload: payload, UpdatedAt: time.Unix(1_790_000_000, 0)})
	}
	b.ReportAllocs()
	for b.Loop() {
		_ = listJSON(rows)
	}
}
