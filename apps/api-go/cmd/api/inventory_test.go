package main

import (
	"bytes"
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func noEnvironment(string) (string, bool) { return "", false }

func inventoryFolder(t *testing.T) (root, report string) {
	t.Helper()
	root = t.TempDir()
	if err := os.WriteFile(filepath.Join(root, "data.csv"), []byte("Código,Monto\nsynthetic,12\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "names.csv"), []byte("Nombre\nsynthetic\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	return root, filepath.Join(t.TempDir(), "inventory.json")
}

func TestInventoryNeedsNoDatabaseAndWritesItsReport(t *testing.T) {
	root, report := inventoryFolder(t)
	var out bytes.Buffer

	err := dispatch(context.Background(), []string{"inventory", "--root", root, "--report", report}, noEnvironment, &out, nil)
	if err != nil {
		t.Fatal(err)
	}

	body, err := os.ReadFile(report)
	if err != nil {
		t.Fatal(err)
	}
	var parsed struct {
		Schema string `json:"schema"`
		Totals struct {
			Files int `json:"files"`
		} `json:"totals"`
		Tables []struct {
			Sheets []struct {
				Headers []string `json:"headers"`
			} `json:"sheets"`
		} `json:"tables"`
	}
	if err := json.Unmarshal(body, &parsed); err != nil {
		t.Fatal(err)
	}
	if parsed.Schema != "sipges.file-inventory/v1" || parsed.Totals.Files != 2 ||
		strings.Join(parsed.Tables[0].Sheets[0].Headers, "|") != "Código|Monto" {
		t.Errorf("%s", body)
	}
	if bytes.Contains(body, []byte("synthetic")) {
		t.Errorf("a value reached the report: %s", body)
	}
	if !strings.Contains(out.String(), "2 files") || strings.Contains(out.String(), "data.csv") {
		t.Errorf("summary: %s", out.String())
	}
	info, err := os.Stat(report)
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm()&0o007 != 0 {
		t.Errorf("other accounts may reach the report: %s", info.Mode())
	}
}

func TestInventoryShowsUnconfirmedHeadersOnlyWhenAsked(t *testing.T) {
	root, report := inventoryFolder(t)
	args := []string{"inventory", "--root", root, "--report", report, "--show-unconfirmed-headers"}
	if err := dispatch(context.Background(), args, noEnvironment, &bytes.Buffer{}, nil); err != nil {
		t.Fatal(err)
	}
	body, err := os.ReadFile(report)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Contains(body, []byte(`"Nombre"`)) {
		t.Errorf("%s", body)
	}
}

func TestInventoryNeverOverwritesAReport(t *testing.T) {
	root, report := inventoryFolder(t)
	if err := os.WriteFile(report, []byte("earlier"), 0o644); err != nil {
		t.Fatal(err)
	}
	args := []string{"inventory", "--root", root, "--report", report}
	if err := dispatch(context.Background(), args, noEnvironment, &bytes.Buffer{}, nil); err == nil {
		t.Fatal("no error")
	}
	if body, _ := os.ReadFile(report); string(body) != "earlier" {
		t.Errorf("overwritten: %s", body)
	}
}

func TestInventoryRefusesBadUse(t *testing.T) {
	root, report := inventoryFolder(t)
	for name, args := range map[string][]string{
		"no root":      {"inventory", "--report", report},
		"no report":    {"inventory", "--root", root},
		"extra":        {"inventory", "--root", root, "--report", report, "more"},
		"unknown flag": {"inventory", "--root", root, "--report", report, "--apply"},
		"no folder":    {"inventory", "--root", filepath.Join(root, "missing"), "--report", report},
	} {
		if err := dispatch(context.Background(), args, noEnvironment, &bytes.Buffer{}, nil); err == nil {
			t.Errorf("%s: no error", name)
		}
	}
}
