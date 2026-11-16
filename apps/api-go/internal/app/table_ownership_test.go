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

// tableOwners maps a table to the only context allowed to write it (ADR 0002: contexts talk
// through exported application APIs, never through each other's tables). Other contexts reach
// these writes through ports wired in this composition root (odd/tasks/go-context-ports.md).
var tableOwners = map[string]string{
	"automation_cursors": "automation",
	"module_records":     "records",
}

// writeStatement finds SQL that changes a table: INSERT INTO t, UPDATE t, DELETE FROM t.
var writeStatement = regexp.MustCompile(`(?i)\b(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+([a-z_][a-z0-9_]*)\b`)

func TestNoContextWritesAnotherContextsTable(t *testing.T) {
	root := ".."
	var violations []string
	err := filepath.WalkDir(root, func(path string, d fs.DirEntry, err error) error {
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
		context := strings.SplitN(filepath.ToSlash(rel), "/", 2)[0]
		src, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		for _, m := range writeStatement.FindAllStringSubmatch(string(src), -1) {
			if owner, ok := tableOwners[strings.ToLower(m[1])]; ok && owner != context {
				violations = append(violations, filepath.ToSlash(rel)+" writes "+m[1]+" (owned by "+owner+")")
			}
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	sort.Strings(violations)
	if len(violations) > 0 {
		t.Fatalf("contexts write tables they do not own:\n%s", strings.Join(violations, "\n"))
	}
}

func TestTheOwnershipScanSeesWrites(t *testing.T) {
	for _, sql := range []string{
		"INSERT INTO automation_cursors (tenant_id) VALUES ($1)",
		"update automation_cursors set last_audit_id=$1",
		"DELETE FROM\n  automation_cursors WHERE tenant_id=$1",
	} {
		m := writeStatement.FindStringSubmatch(sql)
		if m == nil || strings.ToLower(m[1]) != "automation_cursors" {
			t.Fatalf("the scan missed %q", sql)
		}
	}
	if m := writeStatement.FindStringSubmatch("SELECT tenant_id FROM automation_cursors"); m != nil {
		t.Fatalf("a read was taken for a write: %q", m[0])
	}
}
