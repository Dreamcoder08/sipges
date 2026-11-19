package application

import (
	"context"
	"encoding/json"
	"testing"

	"github.com/Dreamcoder08/sipges/apps/api-go/internal/indicators/domain"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/platform/engines"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/platform/synthetic"
)

// inputsStore answers IrsaInputs with fixed records; the other reads are unused here.
type inputsStore struct {
	Store
	in IrsaInputs
}

func (s inputsStore) IrsaInputs(context.Context, string) (IrsaInputs, error) { return s.in, nil }

func benchRecords() domain.Records {
	out := domain.Records{}
	all := synthetic.Records(10)
	for _, module := range domain.Modules {
		for _, rec := range all[module] {
			out[module] = append(out[module], domain.Record{ID: rec.ID, Payload: json.RawMessage(rec.Payload)})
		}
	}
	return out
}

// BenchmarkIrsa is GET /system/irsa without the database: 2,450 records through the Rust engine.
func BenchmarkIrsa(b *testing.B) {
	set, err := engines.Shared(context.Background())
	if err != nil {
		b.Fatal(err)
	}
	s := &Service{Store: inputsStore{in: IrsaInputs{Records: benchRecords()}}, Engine: set.Indicators}
	b.ReportAllocs()
	for b.Loop() {
		if _, err := s.Irsa(context.Background(), "T"); err != nil {
			b.Fatal(err)
		}
	}
}

// BenchmarkIrsaMemo is BenchmarkIrsa behind the engine memo the API uses: unchanged records
// skip the engine.
func BenchmarkIrsaMemo(b *testing.B) {
	set, err := engines.Shared(context.Background())
	if err != nil {
		b.Fatal(err)
	}
	s := &Service{Store: inputsStore{in: IrsaInputs{Records: benchRecords()}}, Engine: engines.NewMemo(set.Indicators)}
	b.ReportAllocs()
	for b.Loop() {
		if _, err := s.Irsa(context.Background(), "T"); err != nil {
			b.Fatal(err)
		}
	}
}
