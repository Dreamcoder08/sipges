package domain

import (
	"encoding/json"
	"testing"
)

func alert(status, level, themes string) Alert {
	return Alert{Status: status, Level: level, Themes: json.RawMessage(themes)}
}

func summaryJSON(t *testing.T, alerts []Alert) string {
	t.Helper()
	s, err := NewSummary("PRJ", alerts)
	if err != nil {
		t.Fatal(err)
	}
	b, err := json.Marshal(s)
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

const (
	irsa    = `"irsa_integration":"Sin modificación automática del IRSA; requiere validación metodológica","caution":"Registros manuales, sin monitoreo permanente ni corroboración automática."}` //nolint:misspell // Spanish, verbatim from alerts.ts
	noState = `"by_status":{"Pendiente de verificación":0,"Corroborado":0,"Descartado":0,"En seguimiento":0},"by_priority":{"Alta":0,"Media":0,"Baja":0}`
)

func TestSummaryOfNoAlerts(t *testing.T) {
	got := summaryJSON(t, nil)
	want := `{"version":"2.6","project_id":"PRJ","total":0,` + noState + `,"themes":[],` + irsa
	if got != want {
		t.Fatalf("got  %s\nwant %s", got, want)
	}
}

// alertSummary of alerts.ts: counts per state and priority in their fixed order (unknown values
// count nowhere), and Counter.most_common(12) over the themes: count descending, ties in
// first-seen order.
func TestSummaryCountsStatesPrioritiesAndThemes(t *testing.T) {
	got := summaryJSON(t, []Alert{
		alert("Corroborado", "Alta", `[{"tema":"Agua"},{"tema":"Tierra"}]`),
		alert("Corroborado", "Media", `[{"tema":"Tierra"}]`),
		alert("En seguimiento", "Otro", `[{"tema":"Pesca","extra":1},{"tema":"Agua"}]`),
		alert("Archivado", "Baja", `[]`),
	})
	want := `{"version":"2.6","project_id":"PRJ","total":4,` +
		`"by_status":{"Pendiente de verificación":0,"Corroborado":2,"Descartado":0,"En seguimiento":1},` +
		`"by_priority":{"Alta":1,"Media":1,"Baja":1},` +
		`"themes":[{"name":"Agua","count":2},{"name":"Tierra","count":2},{"name":"Pesca","count":1}],` + irsa
	if got != want {
		t.Fatalf("got  %s\nwant %s", got, want)
	}
}

func TestSummaryKeepsTwelveThemes(t *testing.T) {
	themes := "["
	for i := range 14 {
		if i > 0 {
			themes += ","
		}
		themes += `{"tema":"T` + string(rune('a'+i)) + `"}`
	}
	s, err := NewSummary("PRJ", []Alert{alert("Corroborado", "Alta", themes+"]")})
	if err != nil {
		t.Fatal(err)
	}
	if len(s.Themes) != 12 || string(s.Themes[11].Name) != `"Tl"` {
		t.Fatalf("themes = %+v", s.Themes)
	}
}

// `t.tema` in JavaScript: a theme without a string `tema` counts under undefined (the name is
// left out of the JSON), numbers count by value, and objects each count on their own.
func TestSummaryReadsThemesLikeJavaScript(t *testing.T) {
	got := summaryJSON(t, []Alert{
		alert("Corroborado", "Alta", `[{"x":1},"texto",{"tema":1.0},{"tema":1},{"tema":{"a":1}},{"tema":{"a":1}},{"tema":null},[]]`),
	})
	want := `{"version":"2.6","project_id":"PRJ","total":1,` +
		`"by_status":{"Pendiente de verificación":0,"Corroborado":1,"Descartado":0,"En seguimiento":0},` +
		`"by_priority":{"Alta":1,"Media":0,"Baja":0},` +
		`"themes":[{"count":3},{"name":1,"count":2},{"name":{"a":1},"count":1},{"name":{"a":1},"count":1},{"name":null,"count":1}],` + irsa
	if got != want {
		t.Fatalf("got  %s\nwant %s", got, want)
	}
}

// Where JavaScript throws a TypeError (themes not an array, a null theme), the summary fails
// and the route answers 500, as the TypeScript API does.
func TestSummaryFailsWhereJavaScriptThrows(t *testing.T) {
	for _, themes := range []string{`{"tema":"Agua"}`, `null`, `"Agua"`, `[null]`} {
		if _, err := NewSummary("PRJ", []Alert{alert("Corroborado", "Alta", themes)}); err == nil {
			t.Fatalf("themes %s: no error", themes)
		}
	}
}

func TestListLimitClampsLikeTheService(t *testing.T) {
	for in, want := range map[int64]int{-5: 1, 0: 1, 1: 1, 50: 50, 200: 200, 201: 200, 1 << 62: 200} {
		if got := ListLimit(in); got != want {
			t.Fatalf("ListLimit(%d) = %d, want %d", in, got, want)
		}
	}
}

func TestAlertIDsTheServiceNeverLooksUp(t *testing.T) {
	long := ""
	for range 80 {
		long += "a"
	}
	for id, want := range map[string]bool{"": false, "DIG-1": true, long: true, long + "a": false,
		// UTF-16 length: 40 emoji are 80 code units, 41 are 82.
		repeat("😀", 40): true, repeat("😀", 41): false} {
		if got := LookupID(id); got != want {
			t.Fatalf("LookupID(%q) = %v, want %v", id, got, want)
		}
	}
}

func repeat(s string, n int) string {
	out := ""
	for range n {
		out += s
	}
	return out
}

func TestJSNumberText(t *testing.T) {
	for in, want := range map[string]string{"1.0": "1", "-0": "0", "1e21": "1e+21", "1e-7": "1e-7",
		"123456789012": "123456789012", "0.000001": "0.000001", "1.5E+2": "150", "2.5e-10": "2.5e-10", "1e400": "null"} {
		got, err := jsNumber(json.Number(in))
		if err != nil || got != want {
			t.Fatalf("jsNumber(%s) = %q, %v; want %q", in, got, err, want)
		}
	}
}
