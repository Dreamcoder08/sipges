package domain_test

import (
	"encoding/json"
	"testing"

	"github.com/Dreamcoder08/sipges/apps/api-go/internal/analytics/domain"
)

func records(t *testing.T, raw string) domain.RecordsByModule {
	t.Helper()
	var in map[string][]struct {
		ID      string          `json:"id"`
		Payload json.RawMessage `json:"payload"`
	}
	if err := json.Unmarshal([]byte(raw), &in); err != nil {
		t.Fatal(err)
	}
	out := domain.EmptyRecords(domain.DashboardModules)
	for _, module := range domain.DashboardModules {
		for _, r := range in[module] {
			out.Add(module, domain.StoredRecord{ID: r.ID, Payload: r.Payload})
		}
	}
	return out
}

func summary(t *testing.T, raw string) string {
	t.Helper()
	s, err := domain.NewDashboardSummary(records(t, raw))
	if err != nil {
		t.Fatal(err)
	}
	out, err := json.Marshal(s)
	if err != nil {
		t.Fatal(err)
	}
	return string(out)
}

// The expected texts are JSON.stringify(dashboardSummary(input)) of the TypeScript API.

func TestDashboardCountsOpenItemsAndLevelsLikeTheTypeScriptAPI(t *testing.T) {
	// Statuses trimmed (U+FEFF too, U+0085 not) and lowered; null, absent and non-string
	// statuses are open; levels from Nivel_Preliminar or Nivel when truthy, as String(number)
	// and JSON.stringify, with array-index keys first.
	in := `{"Eventos":[{"id":"e","payload":{}}],"Demandas":[{"id":"1","payload":{"Estado":" Cerrada\ufeff"}},{"id":"2","payload":{"Estado":null}},{"id":"3","payload":{"Estado":"CERRADO"}},{"id":"4","payload":{}},{"id":"5","payload":{"Estado":true}}],"Alertas":[{"id":"a","payload":{"Nivel_Preliminar":"","Nivel":2.50,"Estado":"descartado"}},{"id":"b","payload":{"Nivel_Preliminar":0,"Nivel":{"b":1,"1":[true,null,"x\"y\n"]}}},{"id":"c","payload":{"Nivel_Preliminar":1e21,"Estado":"Descartada"}},{"id":"d","payload":{"Nivel_Preliminar":[],"Nivel":false}},{"id":"e","payload":{"Nivel":"__proto__"}},{"id":"f","payload":{"Nivel":10}},{"id":"g","payload":{"Nivel":1e-7,"Estado":"\u0085cerrada"}},{"id":"h","payload":{"Nivel":"Alto","Estado":" activa "}}]}` //nolint:misspell // Spanish name kept verbatim from the TypeScript API
	want := `{"eventos":1,"actores":0,"demandas_abiertas":3,"alertas_activas":6,"directorio":0,"priorizados":0,"niveles":{"10":1,"2.5":1,"{\"1\":[true,null,\"x\\\"y\\n\"],\"b\":1}":1,"1e+21":1,"Sin nivel":1,"__proto__":1,"1e-7":1,"Alto":1}}`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                //nolint:misspell // Spanish name kept verbatim from the TypeScript API
	if got := summary(t, in); got != want {
		t.Fatalf("got  %s\nwant %s", got, want)
	}
}

func TestDashboardOfNoRecords(t *testing.T) {
	want := `{"eventos":0,"actores":0,"demandas_abiertas":0,"alertas_activas":0,"directorio":0,"priorizados":0,"niveles":{}}` //nolint:misspell // Spanish name kept verbatim from the TypeScript API
	if got := summary(t, `{}`); got != want {
		t.Fatalf("got  %s\nwant %s", got, want)
	}
}
