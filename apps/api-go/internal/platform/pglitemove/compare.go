package pglitemove

import (
	"bytes"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"math/big"
	"slices"
	"sort"
	"strings"
)

// listed is how many problems of one table are printed (tables.mjs LISTED).
const listed = 20

// table is one table as readDatabase reads it: values as text, nil for NULL.
type table struct {
	columns   []string
	pk        []string // nil without a primary key
	rows      [][]*string
	structure structure
}

type column struct {
	typ     string
	notNull bool
}

// structure is what tables.mjs compares of a table besides its rows.
type structure struct {
	columnOrder []string
	columns     map[string]column
	keys        map[string]string // "constraint <name>" / "unique index <name>" -> definition
	rlsEnabled  bool
	rlsForced   bool
	policies    []string          // sorted names
	triggers    map[string]string // name -> tgenabled
}

// database is readDatabase's result: tables by name (bare in public, schema-qualified elsewhere)
// and each sequence's last value (nil when never used).
type database struct {
	tables    map[string]*table
	sequences map[string]*string
}

func plural(n int, word string) string {
	if n == 1 {
		return fmt.Sprintf("%d %s", n, word)
	}
	return fmt.Sprintf("%d %ss", n, word)
}

func samePtr(a, b *string) bool {
	if a == nil || b == nil {
		return a == nil && b == nil
	}
	return *a == *b
}

// lower reports whether an integer value (text, or nil when unset) went back.
func lower(was, now *string) bool {
	if was == nil {
		return false
	}
	if now == nil {
		return true
	}
	a, okA := new(big.Int).SetString(*was, 10)
	b, okB := new(big.Int).SetString(*now, 10)
	return okA && okB && b.Cmp(a) < 0
}

func sortedKeys[V any](m map[string]V) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}

// mapChanges lists removed, added and changed entries of two maps, labelled, in name order.
func mapChanges(was, now map[string]string, label string, changed func(a, b string) string) []string {
	var out []string
	for _, k := range sortedKeys(was) {
		v := was[k]
		other, ok := now[k]
		switch {
		case !ok:
			out = append(out, label+k+" missing after")
		case other != v:
			out = append(out, label+k+" "+changed(v, other))
		}
	}
	for _, k := range sortedKeys(now) {
		if _, ok := was[k]; !ok {
			out = append(out, label+k+" new")
		}
	}
	return out
}

func differs(string, string) string { return "differs" }

// structureProblems are the structure differences of one table (tables.mjs structureProblems).
func structureProblems(was, now structure) []string {
	var out []string
	for _, name := range was.columnOrder {
		other, ok := now.columns[name]
		if !ok {
			continue
		}
		col := was.columns[name]
		if col.typ != other.typ {
			out = append(out, fmt.Sprintf("column %s type %s -> %s", name, col.typ, other.typ))
		}
		if col.notNull != other.notNull {
			if col.notNull {
				out = append(out, fmt.Sprintf("column %s NOT NULL -> nullable", name))
			} else {
				out = append(out, fmt.Sprintf("column %s nullable -> NOT NULL", name))
			}
		}
	}
	out = append(out, mapChanges(was.keys, now.keys, "", differs)...)
	state := func(on bool, yes, no string) string {
		if on {
			return yes
		}
		return no
	}
	if was.rlsEnabled != now.rlsEnabled {
		out = append(out, fmt.Sprintf("row-level security %s -> %s",
			state(was.rlsEnabled, "enabled", "disabled"), state(now.rlsEnabled, "enabled", "disabled")))
	}
	if was.rlsForced != now.rlsForced {
		out = append(out, fmt.Sprintf("row-level security %s -> %s",
			state(was.rlsForced, "forced", "not forced"), state(now.rlsForced, "forced", "not forced")))
	}
	set := func(names []string) map[string]string {
		m := make(map[string]string, len(names))
		for _, n := range names {
			m[n] = ""
		}
		return m
	}
	out = append(out, mapChanges(set(was.policies), set(now.policies), "policy ", differs)...)
	out = append(out, mapChanges(was.triggers, now.triggers, "trigger ", func(a, b string) string {
		return fmt.Sprintf("enabled %s -> %s", a, b)
	})...)
	return out
}

// valuesKey is the JSON array of a row's values in columns, as tables.mjs keys rows.
func valuesKey(row []*string, idx []int) string {
	vals := make([]*string, len(idx))
	for i, j := range idx {
		vals[i] = row[j]
	}
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	_ = enc.Encode(vals) // []*string always encodes
	return strings.TrimSuffix(buf.String(), "\n")
}

func indexes(columns, names []string) []int {
	out := make([]int, len(names))
	for i, n := range names {
		out[i] = slices.Index(columns, n)
	}
	return out
}

// compareIdentical is tables.mjs compareTable under the move's only rule, identical: same
// columns, same rows, every common column. Returns the line and the problems.
func compareIdentical(name string, was, now *table, fp func(string) string) (string, []string) {
	label := fmt.Sprintf("%s: %d -> %d", name, len(was.rows), len(now.rows))
	var problems []string
	for _, c := range was.columns {
		if !slices.Contains(now.columns, c) {
			problems = append(problems, fmt.Sprintf("column %s missing after", c))
		}
	}
	for _, c := range now.columns {
		if !slices.Contains(was.columns, c) {
			problems = append(problems, fmt.Sprintf("column %s new", c))
		}
	}
	var common []string
	for _, c := range was.columns {
		if slices.Contains(now.columns, c) {
			common = append(common, c)
		}
	}
	samePk := was.pk != nil && now.pk != nil && slices.Equal(was.pk, now.pk)
	for _, c := range was.pk {
		samePk = samePk && slices.Contains(common, c)
	}
	if samePk {
		wasKey, nowKey := indexes(was.columns, was.pk), indexes(now.columns, was.pk)
		wasCommon, nowCommon := indexes(was.columns, common), indexes(now.columns, common)
		byKey := make(map[string]int, len(now.rows))
		order := make([]string, 0, len(now.rows))
		for i, row := range now.rows {
			k := valuesKey(row, nowKey)
			if _, seen := byKey[k]; !seen {
				order = append(order, k)
			}
			byKey[k] = i
		}
		for _, row := range was.rows {
			k := valuesKey(row, wasKey)
			i, ok := byKey[k]
			delete(byKey, k)
			if !ok {
				problems = append(problems, fmt.Sprintf("row [%s] missing", fp(k)))
				continue
			}
			var differ []string
			for n, c := range common {
				if !samePtr(row[wasCommon[n]], now.rows[i][nowCommon[n]]) {
					differ = append(differ, c)
				}
			}
			if len(differ) > 0 {
				problems = append(problems, fmt.Sprintf("row [%s] differs in %s", fp(k), strings.Join(differ, ", ")))
			}
		}
		for _, k := range order {
			if _, left := byKey[k]; left {
				problems = append(problems, fmt.Sprintf("row [%s] new", fp(k)))
			}
		}
	} else {
		wasCommon, nowCommon := indexes(was.columns, common), indexes(now.columns, common)
		left := map[string]int{}
		for _, row := range now.rows {
			left[valuesKey(row, nowCommon)]++
		}
		missing := 0
		for _, row := range was.rows {
			k := valuesKey(row, wasCommon)
			if left[k] > 0 {
				left[k]--
			} else {
				missing++
			}
		}
		extra := 0
		for _, n := range left {
			extra += n
		}
		if missing > 0 {
			problems = append(problems, plural(missing, "row")+" missing or changed (no primary key)")
		}
		if extra > 0 {
			problems = append(problems, plural(extra, "row")+" new or changed (no primary key)")
		}
	}
	if len(problems) > 0 {
		return label, problems
	}
	return label + ", identical", nil
}

// comparison is compareDatabases' result.
type comparison struct {
	lines       []string
	differences int
	incomplete  []string
}

func versions(db map[string]*table) map[string]bool {
	out := map[string]bool{}
	t := db["schema_migrations"]
	if t == nil {
		return out
	}
	i := slices.Index(t.columns, "version")
	if i < 0 {
		return out
	}
	for _, row := range t.rows {
		if row[i] != nil {
			out[*row[i]] = true
		}
	}
	return out
}

// compareDatabases is tables.mjs compareDatabases with the move's rules: every table of either
// side identical (strictRules) and no migration declared. It prints no value, only names, counts
// and 8-hex fingerprints keyed with key.
func compareDatabases(was, now *database, key []byte) comparison {
	fp := func(text string) string {
		m := hmac.New(sha256.New, key)
		m.Write([]byte(text))
		return hex.EncodeToString(m.Sum(nil))[:8]
	}
	old, current := versions(was.tables), versions(now.tables)
	var applied []string
	for v := range current {
		if !old[v] {
			applied = append(applied, v)
		}
	}
	sort.Strings(applied)
	appliedText := "none"
	if len(applied) > 0 {
		appliedText = strings.Join(applied, ", ")
	}
	r := comparison{lines: []string{"Migrations applied between the two: " + appliedText}}
	// No migration is declared for a move: one applied between the two leaves it not fully compared.
	structureCompared := len(applied) == 0
	if structureCompared {
		r.lines = append(r.lines, "Structure: compared (column types and nullability, keys and constraints, row-level security, policies, triggers, sequences)")
	} else {
		r.lines = append(r.lines, "Structure: not compared (a migration without a declared expected change ran between the two: structure changes are expected and the run is not fully compared)")
	}
	names := map[string]bool{}
	for n := range was.tables {
		names[n] = true
	}
	for n := range now.tables {
		names[n] = true
	}
	for _, name := range sortedKeys(names) {
		a, b := was.tables[name], now.tables[name]
		if b == nil {
			r.differences++
			r.lines = append(r.lines, fmt.Sprintf("%s: %d -> -, table missing after", name, len(a.rows)))
			continue
		}
		if a == nil {
			r.differences++
			r.lines = append(r.lines, fmt.Sprintf("%s: - -> %d, new table", name, len(b.rows)))
			continue
		}
		line, problems := compareIdentical(name, a, b, fp)
		r.differences += len(problems)
		switch {
		case len(problems) == 1:
			r.lines = append(r.lines, line+", "+problems[0])
		case len(problems) == 0:
			r.lines = append(r.lines, line)
		default:
			r.lines = append(r.lines, fmt.Sprintf("%s, %s:", line, plural(len(problems), "difference")))
			for _, p := range problems[:min(len(problems), listed)] {
				r.lines = append(r.lines, "  "+p)
			}
			if len(problems) > listed {
				r.lines = append(r.lines, fmt.Sprintf("  … and %d more", len(problems)-listed))
			}
		}
		if !structureCompared {
			continue
		}
		changed := structureProblems(a.structure, b.structure)
		r.differences += len(changed)
		for _, p := range changed {
			r.lines = append(r.lines, fmt.Sprintf("%s: structure differs: %s", name, p))
		}
	}
	if structureCompared {
		var changed []string
		for _, name := range sortedKeys(was.sequences) {
			after, ok := now.sequences[name]
			if !ok {
				changed = append(changed, fmt.Sprintf("sequence %s: missing after", name))
			} else if lower(was.sequences[name], after) {
				changed = append(changed, fmt.Sprintf("sequence %s: last value decreased", name))
			}
		}
		for _, name := range sortedKeys(now.sequences) {
			if _, ok := was.sequences[name]; !ok {
				changed = append(changed, fmt.Sprintf("sequence %s: new", name))
			}
		}
		r.differences += len(changed)
		suffix := ""
		if len(changed) == 0 {
			suffix = ", none decreased"
		}
		r.lines = append(r.lines, fmt.Sprintf("Sequences: %d -> %d%s", len(was.sequences), len(now.sequences), suffix))
		r.lines = append(r.lines, changed...)
	}
	for _, v := range applied {
		r.incomplete = append(r.incomplete, fmt.Sprintf("migration %s ran between the two and declares no expected change here", v))
	}
	return r
}

// verdict is tables.mjs verdict's line.
func verdict(differences int, incomplete []string) string {
	partial := ""
	if len(incomplete) > 0 {
		partial = "not fully compared (" + strings.Join(incomplete, "; ") + ")"
	}
	switch {
	case differences == 0 && partial == "":
		return "RESULT: no difference"
	case differences == 0:
		return "RESULT: " + partial
	case partial != "":
		return "RESULT: " + plural(differences, "difference") + "; " + partial
	default:
		return "RESULT: " + plural(differences, "difference")
	}
}

// catalogLabel is the subject of report's catalog line.
const catalogLabel = "Catalog (functions, views, indexes, triggers, policies, grants, columns, tables, sequences, default privileges, extensions)"

// report prints the whole comparison (pglite-to-postgres.mjs report) and returns whether
// anything differs.
func report(source, target *database, sourceCatalog, targetCatalog map[string]string, key []byte, say func(string)) bool {
	result := compareDatabases(source, target, key)
	for _, line := range result.lines {
		say(line)
	}
	differences := result.differences
	// tables.mjs only refuses a lower sequence; a move must keep every one exactly.
	for _, name := range sortedKeys(source.sequences) {
		if after, ok := target.sequences[name]; ok && !samePtr(after, source.sequences[name]) {
			differences++
			say(fmt.Sprintf("sequence %s: last value differs", name))
		}
	}
	var changed []string
	for _, k := range sortedKeys(sourceCatalog) {
		if v, ok := targetCatalog[k]; !ok {
			changed = append(changed, k+": missing after")
		} else if v != sourceCatalog[k] {
			changed = append(changed, k+": differs")
		}
	}
	for _, k := range sortedKeys(targetCatalog) {
		if _, ok := sourceCatalog[k]; !ok {
			changed = append(changed, k+": new")
		}
	}
	suffix := ""
	if len(changed) == 0 {
		suffix = ", identical"
	}
	say(fmt.Sprintf("%s: %d -> %d%s", catalogLabel, len(sourceCatalog), len(targetCatalog), suffix))
	for _, line := range changed {
		say("  " + line)
	}
	differences += len(changed)
	say(verdict(differences, result.incomplete))
	return differences > 0 || len(result.incomplete) > 0
}
