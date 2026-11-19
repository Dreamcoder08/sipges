package pglitemove

import (
	"strings"
	"testing"
)

func s(v string) *string { return &v }

func syntheticTable(pk []string, rows ...[]*string) *table {
	return &table{
		columns: []string{"id", "label"},
		pk:      pk,
		rows:    rows,
		structure: structure{
			columnOrder: []string{"id", "label"},
			columns:     map[string]column{"id": {typ: "integer", notNull: true}, "label": {typ: "text"}},
			keys:        map[string]string{"constraint t_pkey": "PRIMARY KEY (id)"},
			rlsEnabled:  true,
			policies:    []string{"tenant_isolation"},
			triggers:    map[string]string{"touch": "O"},
		},
	}
}

func lines(t *testing.T, was, now *database, wasCat, nowCat map[string]string) (bool, string) {
	t.Helper()
	var out []string
	differ := report(was, now, wasCat, nowCat, []byte("synthetic key"), func(l string) { out = append(out, l) })
	text := strings.Join(out, "\n")
	if strings.Contains(text, secret) {
		t.Fatalf("a value reached the output:\n%s", text)
	}
	return differ, text
}

func TestReportFindsNoDifferenceInIdenticalDatabases(t *testing.T) {
	db := func() *database {
		return &database{
			tables:    map[string]*table{"t": syntheticTable([]string{"id"}, []*string{s("1"), s(secret + " a")}, []*string{s("2"), nil})},
			sequences: map[string]*string{"t_id_seq": s("2"), "unused_seq": nil},
		}
	}
	differ, text := lines(t, db(), db(), map[string]string{"function public.f()": "abc"}, map[string]string{"function public.f()": "abc"})
	if differ {
		t.Fatalf("a difference in identical databases:\n%s", text)
	}
	for _, want := range []string{
		"Migrations applied between the two: none",
		"t: 2 -> 2, identical",
		"Sequences: 2 -> 2, none decreased",
		"Catalog (functions, views, indexes, triggers, policies, grants, columns, tables, sequences, default privileges, extensions): 1 -> 1, identical",
		"RESULT: no difference",
	} {
		if !strings.Contains(text, want) {
			t.Errorf("missing %q:\n%s", want, text)
		}
	}
}

func TestReportPrintsFingerprintsNeverValues(t *testing.T) {
	was := &database{tables: map[string]*table{"t": syntheticTable([]string{"id"},
		[]*string{s(secret + "-1"), s(secret + " a")}, []*string{s(secret + "-2"), s("b")})}, sequences: map[string]*string{}}
	now := &database{tables: map[string]*table{"t": syntheticTable([]string{"id"},
		[]*string{s(secret + "-1"), s(secret + " changed")}, []*string{s(secret + "-3"), s("b")})}, sequences: map[string]*string{}}
	differ, text := lines(t, was, now, nil, nil)
	if !differ {
		t.Fatalf("no difference found:\n%s", text)
	}
	for _, want := range []string{"t: 2 -> 2, 3 differences:", "] differs in label", "] missing", "] new", "RESULT: 3 differences"} {
		if !strings.Contains(text, want) {
			t.Errorf("missing %q:\n%s", want, text)
		}
	}
}

func TestReportComparesRowsWithoutAPrimaryKeyAsAMultiset(t *testing.T) {
	row := []*string{s("1"), s(secret)}
	was := &database{tables: map[string]*table{"t": syntheticTable(nil, row, row, []*string{nil, nil})}, sequences: map[string]*string{}}
	same := &database{tables: map[string]*table{"t": syntheticTable(nil, []*string{nil, nil}, row, row)}, sequences: map[string]*string{}}
	if differ, text := lines(t, was, same, nil, nil); differ {
		t.Errorf("reordered duplicates read as a difference:\n%s", text)
	}
	fewer := &database{tables: map[string]*table{"t": syntheticTable(nil, row, []*string{nil, s("")})}, sequences: map[string]*string{}}
	differ, text := lines(t, was, fewer, nil, nil)
	if !differ || !strings.Contains(text, "2 rows missing or changed (no primary key)") || !strings.Contains(text, "1 row new or changed (no primary key)") {
		t.Errorf("a lost duplicate or a NULL read as empty text went unseen:\n%s", text)
	}
}

func TestReportSeesStructureSequencesTablesAndCatalog(t *testing.T) {
	was := &database{tables: map[string]*table{
		"t":    syntheticTable([]string{"id"}),
		"gone": syntheticTable(nil),
	}, sequences: map[string]*string{"a_seq": s("5"), "b_seq": s("5"), "c_seq": s("1")}}
	changed := syntheticTable([]string{"id"})
	changed.structure.columns = map[string]column{"id": {typ: "bigint", notNull: true}, "label": {typ: "text", notNull: true}}
	changed.structure.rlsForced = true
	changed.structure.policies = nil
	changed.structure.triggers = map[string]string{"touch": "D"}
	changed.structure.keys = map[string]string{"constraint t_pkey": "PRIMARY KEY (id, label)"}
	now := &database{tables: map[string]*table{"t": changed, "extra": syntheticTable(nil)},
		sequences: map[string]*string{"a_seq": s("4"), "b_seq": s("6"), "d_seq": nil}}
	differ, text := lines(t, was, now,
		map[string]string{"index public.i": "x", "view public.v": "y"},
		map[string]string{"index public.i": "z", "grant relation public.t to PUBLIC SELECT": ""})
	if !differ {
		t.Fatalf("no difference:\n%s", text)
	}
	for _, want := range []string{
		"gone: 0 -> -, table missing after",
		"extra: - -> 0, new table",
		"t: structure differs: column id type integer -> bigint",
		"t: structure differs: column label nullable -> NOT NULL",
		"t: structure differs: constraint t_pkey differs",
		"t: structure differs: row-level security not forced -> forced",
		"t: structure differs: policy tenant_isolation missing after",
		"t: structure differs: trigger touch enabled O -> D",
		"sequence a_seq: last value decreased",
		"sequence c_seq: missing after",
		"sequence d_seq: new",
		"sequence a_seq: last value differs",
		"sequence b_seq: last value differs",
		"  index public.i: differs",
		"  view public.v: missing after",
		"  grant relation public.t to PUBLIC SELECT: new",
		"RESULT: 16 differences",
	} {
		if !strings.Contains(text, want) {
			t.Errorf("missing %q:\n%s", want, text)
		}
	}
}

func TestReportLeavesAMoveWithAnAppliedMigrationNotFullyCompared(t *testing.T) {
	migrations := func(versions ...string) *table {
		tb := &table{columns: []string{"version"}, pk: []string{"version"}, structure: structure{
			columnOrder: []string{"version"}, columns: map[string]column{"version": {typ: "text", notNull: true}},
			keys: map[string]string{}, triggers: map[string]string{},
		}}
		for _, v := range versions {
			tb.rows = append(tb.rows, []*string{s(v)})
		}
		return tb
	}
	was := &database{tables: map[string]*table{"schema_migrations": migrations("0001")}, sequences: map[string]*string{}}
	now := &database{tables: map[string]*table{"schema_migrations": migrations("0001", "0002")}, sequences: map[string]*string{}}
	differ, text := lines(t, was, now, nil, nil)
	if !differ || !strings.Contains(text, "Structure: not compared") ||
		!strings.Contains(text, "RESULT: 1 difference; not fully compared (migration 0002 ran between the two and declares no expected change here)") {
		t.Errorf("an applied migration was not reported:\n%s", text)
	}
}

func TestVerdictLines(t *testing.T) {
	for _, c := range []struct {
		n    int
		inc  []string
		want string
	}{
		{0, nil, "RESULT: no difference"},
		{0, []string{"x"}, "RESULT: not fully compared (x)"},
		{1, nil, "RESULT: 1 difference"},
		{2, []string{"x", "y"}, "RESULT: 2 differences; not fully compared (x; y)"},
	} {
		if got := verdict(c.n, c.inc); got != c.want {
			t.Errorf("verdict(%d, %v) = %q, want %q", c.n, c.inc, got, c.want)
		}
	}
}
