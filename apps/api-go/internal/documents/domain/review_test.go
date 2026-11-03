//nolint:misspell // Spanish module slugs, labels and themes, verbatim from the TypeScript API.
package domain

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestBoundedIntIsTheRouteQueryRule(t *testing.T) {
	for _, c := range []struct {
		raw      string
		min, max int64
		want     int64
		ok       bool
	}{
		{"1", 1, 200, 1, true},
		{"200", 1, 200, 200, true},
		{"0050", 1, 200, 50, true},
		{"0", 1, 200, 0, false},
		{"201", 1, 200, 0, false},
		{"", 1, 200, 0, false},
		{"-1", 1, 200, 0, false},
		{"+5", 1, 200, 0, false},
		{" 5", 1, 200, 0, false},
		{"5 ", 1, 200, 0, false},
		{"1.0", 1, 200, 0, false},
		{"1e2", 1, 200, 0, false},
		// \d is ASCII only: an Arabic-Indic digit is no digit.
		{"٥", 1, 200, 0, false},
		{"0", 0, MaxSafeInteger, 0, true},
		{"9007199254740991", 0, MaxSafeInteger, MaxSafeInteger, true},
		{"9007199254740992", 0, MaxSafeInteger, 0, false},
		{"99999999999999999999999999", 0, MaxSafeInteger, 0, false},
	} {
		got, ok := BoundedInt(c.raw, c.min, c.max)
		if got != c.want || ok != c.ok {
			t.Errorf("BoundedInt(%q, %d, %d) = %d, %v; want %d, %v", c.raw, c.min, c.max, got, ok, c.want, c.ok)
		}
	}
}

func TestReviewTargetFollowsTheTheme(t *testing.T) {
	for theme, want := range map[string]ReviewTarget{
		"Representatividad y gobernanza":      {"actores", "Actores"},
		"Demandas e intereses":                {"demandas", "Demandas"},
		"Compromisos y trazabilidad":          {"compromisos", "Compromisos"},
		"Controversias y hechos compartidos":  {"hechos", "Hechos compartidos"},
		"Diálogo y construcción de consensos": {"dialogos", "Diálogos"},
		"Oportunidades de valor compartido":   {"oportunidades", "Valor compartido"},
		"Territorio y ambiente":               {"narrativas", "Narrativas"},
		"":                                    {"hechos", "Hechos compartidos"},
		"tema libre":                          {"hechos", "Hechos compartidos"},
		"territorio y ambiente":               {"hechos", "Hechos compartidos"},
		"constructor":                         {"hechos", "Hechos compartidos"},
	} {
		if got := ReviewTargetFor(theme); got != want {
			t.Errorf("ReviewTargetFor(%q) = %v; want %v", theme, got, want)
		}
	}
}

func TestEveryTargetIsARecordsModule(t *testing.T) {
	for _, target := range targets {
		if _, ok := RecordModule(target.Module); !ok {
			t.Errorf("target %q has no records module", target.Module)
		}
	}
	if _, ok := RecordModule("constructor"); ok {
		t.Error("an inherited property name is not a module")
	}
}

func TestApprovalsAndRecordIDs(t *testing.T) {
	for status, want := range map[string]bool{
		"pendiente": false, "aceptado_para_revision": true, "descartado": false, "corroborado_documentalmente": true,
	} {
		if IsApproval(status) != want {
			t.Errorf("IsApproval(%q) != %v", status, want)
		}
	}
	if got := ReviewRecordID("abc"); got != "REV-abc" {
		t.Errorf("ReviewRecordID = %q", got)
	}
}

func TestLookupableIDCountsUTF16Units(t *testing.T) {
	if !IsLookupableID(strings.Repeat("a", 200)) || IsLookupableID(strings.Repeat("a", 201)) {
		t.Error("200 units is the limit")
	}
	// 100 emoji are 200 UTF-16 units; one more is over.
	if !IsLookupableID(strings.Repeat("😀", 100)) || IsLookupableID(strings.Repeat("😀", 100)+"a") {
		t.Error("an emoji counts as two units")
	}
	if IsLookupableID("a\x00b") {
		t.Error("NUL can never be stored")
	}
}

func TestThemeCountsKeepTheJavaScriptKeyOrder(t *testing.T) {
	var counts ThemeCounts
	for _, theme := range []string{"", "10", "2", "Agua", "01", "4294967295", "4294967294", "Zeta", "-1"} {
		counts.Add(theme, int64(len(theme)))
	}
	got, err := json.Marshal(counts)
	if err != nil {
		t.Fatal(err)
	}
	// Canonical array indexes first, ascending; then the rest in insertion (SQL) order.
	want := `{"2":1,"10":2,"4294967294":10,"":0,"Agua":4,"01":2,"4294967295":10,"Zeta":4,"-1":2}`
	if string(got) != want {
		t.Errorf("got  %s\nwant %s", got, want)
	}
	empty, _ := json.Marshal(ThemeCounts{})
	if string(empty) != `{}` {
		t.Errorf("empty counts = %s", empty)
	}
}
