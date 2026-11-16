package app

import (
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"testing"
)

// tableOwners maps a table to the only package allowed to write it, as a path prefix from the
// module root (ADR 0002: contexts talk through exported application APIs, never through each
// other's tables). Other packages reach these writes through ports wired in this composition
// root (odd/tasks/go-context-ports.md). The audit trail is cross-cutting, so its writer is the
// platform package audittrail, as platform/database/audit-trail.ts is in TypeScript.
var tableOwners = map[string]string{
	"audit":              "internal/platform/audittrail/",
	"automation_cursors": "internal/automation/",
	"module_records":     "internal/records/",
}

// pendingWriters are files still allowed to write a table they do not own, each with the task
// that removes it. Empty: every write goes through its owner (odd/tasks/go-context-ports.md).
var pendingWriters = map[string]string{}

// scannedDirs are the module directories holding production code.
var scannedDirs = []string{"internal", "cmd"}

// writeStatement finds SQL that changes a table: INSERT INTO t, UPDATE [ONLY] t,
// DELETE FROM [ONLY] t, with an optional schema and optional double quotes around each name.
var writeStatement = regexp.MustCompile(
	`(?i)\b(?:INSERT\s+INTO|UPDATE(?:\s+ONLY)?|DELETE\s+FROM(?:\s+ONLY)?)\s+(?:"?[a-z_][a-z0-9_]*"?\.)?"?([a-z_][a-z0-9_]*)"?`)

func TestNoContextWritesAnotherContextsTable(t *testing.T) {
	root := filepath.Join("..", "..") // the apps/api-go module root
	var violations []string
	for _, dir := range scannedDirs {
		err := filepath.WalkDir(filepath.Join(root, dir), func(path string, d fs.DirEntry, err error) error {
			if err != nil {
				return err
			}
			if d.IsDir() || !strings.HasSuffix(path, ".go") || strings.HasSuffix(path, "_test.go") {
				return nil
			}
			rel, err := filepath.Rel(root, path)
			if err != nil {
				return err
			}
			rel = filepath.ToSlash(rel)
			src, err := os.ReadFile(path)
			if err != nil {
				return err
			}
			violations = append(violations, foreignWrites(rel, string(src))...)
			return nil
		})
		if err != nil {
			t.Fatal(err)
		}
	}
	sort.Strings(violations)
	if len(violations) > 0 {
		t.Fatalf("packages write tables they do not own:\n%s", strings.Join(violations, "\n"))
	}
}

// foreignWrites lists the writes in src (the file at rel) to a table owned by another package.
func foreignWrites(rel, src string) []string {
	var out []string
	for _, m := range writeStatement.FindAllStringSubmatch(code(src), -1) {
		table := strings.ToLower(m[1])
		if pendingWriters[rel] == table {
			continue
		}
		if owner, ok := tableOwners[table]; ok && !strings.HasPrefix(rel, owner) {
			out = append(out, rel+" writes "+m[1]+" (owned by "+owner+")")
		}
	}
	return out
}

// code drops whole-line comments, so prose such as "the UPDATE audit row" is not a write.
func code(src string) string {
	lines := strings.Split(src, "\n")
	kept := lines[:0]
	for _, line := range lines {
		if !strings.HasPrefix(strings.TrimSpace(line), "//") {
			kept = append(kept, line)
		}
	}
	return strings.Join(kept, "\n")
}

// keptRecordReaders are the files outside records allowed to read module_records directly, with
// their verdict (odd/tasks/go-context-ports.md T5). Each is a read model of its own context: a
// projection no records query returns, run under row-level security in the caller's tenant
// transaction. A new reader needs a verdict here, or a records port.
var keptRecordReaders = map[string]string{
	"internal/analyst/infrastructure/reader.go":          "graph nodes and recent records as text for the analyst",
	"internal/analytics/infrastructure/dated_records.go": "dated series for the analytics engines",
	"internal/analytics/infrastructure/records.go":       "engine inputs for the analytics engines",
	"internal/automation/infrastructure/writes.go":       "the record a rule evaluates",
	"internal/evidence/infrastructure/attach.go":         "row lock and payload read before the records write",
	"internal/geography/infrastructure/records.go":       "records with a location for the map",
	"internal/indicators/infrastructure/store.go":        "indicator engine inputs",
	"internal/intelligence/infrastructure/narratives.go": "narratives for alert evaluation",
	"internal/management/infrastructure/readmodel.go":    "management read model",
	"internal/ontology/infrastructure/embeddings.go":     "stale embeddings to refresh",
	"internal/ontology/infrastructure/store.go":          "graph nodes, full-text search and dated records",
	"internal/ontology/infrastructure/writes.go":         "presence checks and row lock before the records write",
	"internal/privacy/infrastructure/name_directory.go":  "names to pseudonymize, across clearances",
	"internal/situations/infrastructure/store.go":        "situation engine inputs",
}

// readsRecords finds SQL that reads module_records (FROM or JOIN, optional schema and quotes).
var readsRecords = regexp.MustCompile(`(?i)\b(?:FROM|JOIN)\s+(?:"?[a-z_][a-z0-9_]*"?\.)?"?module_records"?\b`)

func TestOnlyRecordsAndKeptReadModelsReadRecords(t *testing.T) {
	root := filepath.Join("..", "..")
	var unexpected []string
	seen := map[string]bool{}
	for _, dir := range scannedDirs {
		err := filepath.WalkDir(filepath.Join(root, dir), func(path string, d fs.DirEntry, err error) error {
			if err != nil {
				return err
			}
			if d.IsDir() || !strings.HasSuffix(path, ".go") || strings.HasSuffix(path, "_test.go") {
				return nil
			}
			rel, err := filepath.Rel(root, path)
			if err != nil {
				return err
			}
			rel = filepath.ToSlash(rel)
			if strings.HasPrefix(rel, tableOwners["module_records"]) {
				return nil
			}
			src, err := os.ReadFile(path)
			if err != nil {
				return err
			}
			if readsRecords.MatchString(code(string(src))) {
				seen[rel] = true
				if _, ok := keptRecordReaders[rel]; !ok {
					unexpected = append(unexpected, rel)
				}
			}
			return nil
		})
		if err != nil {
			t.Fatal(err)
		}
	}
	var stale []string
	for rel := range keptRecordReaders {
		if !seen[rel] {
			stale = append(stale, rel)
		}
	}
	sort.Strings(unexpected)
	sort.Strings(stale)
	if len(unexpected) > 0 || len(stale) > 0 {
		t.Fatalf("module_records readers without a verdict: %v; verdicts for files that no longer read it: %v", unexpected, stale)
	}
}

func TestTheOwnershipScanSeesWrites(t *testing.T) {
	for _, sql := range []string{
		"INSERT INTO automation_cursors (tenant_id) VALUES ($1)",
		"update automation_cursors set last_audit_id=$1",
		"DELETE FROM\n  automation_cursors WHERE tenant_id=$1",
		"UPDATE public.automation_cursors SET last_audit_id=$1",
		"DELETE FROM ONLY automation_cursors WHERE tenant_id=$1",
		`INSERT INTO "automation_cursors" (tenant_id) VALUES ($1)`,
		`UPDATE ONLY "public"."automation_cursors" SET last_audit_id=$1`,
	} {
		m := writeStatement.FindStringSubmatch(sql)
		if m == nil || strings.ToLower(m[1]) != "automation_cursors" {
			t.Fatalf("the scan missed %q (got %q)", sql, m)
		}
	}
	if m := writeStatement.FindStringSubmatch(code("\t// Update applies the change with its UPDATE audit row.")); m != nil {
		t.Fatalf("a comment was taken for a write: %q", m[0])
	}
	if m := writeStatement.FindStringSubmatch("SELECT tenant_id FROM automation_cursors"); m != nil {
		t.Fatalf("a read was taken for a write: %q", m[0])
	}
}

func TestOwnershipIsByPackagePathNotByTopLevelDirectory(t *testing.T) {
	audit := "INSERT INTO audit (tenant_id) VALUES ($1)"
	if got := foreignWrites("internal/platform/audittrail/audittrail.go", audit); len(got) != 0 {
		t.Fatalf("the owner was reported: %v", got)
	}
	for _, rel := range []string{"internal/platform/database/tenant.go", "cmd/api/migrate.go", "internal/records/infrastructure/writes.go"} {
		if got := foreignWrites(rel, audit); len(got) != 1 {
			t.Fatalf("%s writing audit: got %v, want one violation", rel, got)
		}
	}
}
