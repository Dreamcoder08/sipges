package main

import (
	"bytes"
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func writeMigration(t *testing.T, dir, name, sql string) {
	t.Helper()
	if err := os.WriteFile(filepath.Join(dir, name), []byte(sql), 0o600); err != nil {
		t.Fatal(err)
	}
}

func TestMigrateNeedsADatabaseURL(t *testing.T) {
	err := runMigrate(context.Background(), lookup(map[string]string{}), &bytes.Buffer{})
	if err == nil || !strings.Contains(err.Error(), "SIPGES_DATABASE_URL") {
		t.Fatalf("err = %v", err)
	}
}

// A wrong path must stop the install, never report an up-to-date database.
func TestMigrateRefusesADirectoryWithoutMigrations(t *testing.T) {
	url := "postgres://synthetic@127.0.0.1:1/synthetic?connect_timeout=1"
	for name, dir := range map[string]string{"missing": filepath.Join(t.TempDir(), "none"), "empty": t.TempDir()} {
		err := runMigrate(context.Background(), migrateEnv(url, dir), &bytes.Buffer{})
		if err == nil || !strings.Contains(err.Error(), "migrations") {
			t.Fatalf("%s: err = %v", name, err)
		}
	}
}

func TestUnknownCommandIsRefused(t *testing.T) {
	err := dispatch(context.Background(), []string{"seed"}, lookup(map[string]string{}), &bytes.Buffer{}, nil)
	if err == nil || !strings.Contains(err.Error(), `unknown command "seed"`) {
		t.Fatalf("err = %v", err)
	}
}
