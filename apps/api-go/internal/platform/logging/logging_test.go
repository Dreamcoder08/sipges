package logging

import (
	"bytes"
	"encoding/json"
	"log/slog"
	"strings"
	"testing"
)

func TestNewWritesJSONAndRedactsSecretKeys(t *testing.T) {
	t.Parallel()
	var buf bytes.Buffer
	log := New(&buf, slog.LevelInfo)
	log.Info("start",
		slog.String("password", "synthetic-secret-1"),
		slog.String("database_url", "postgres://u:synthetic-secret-2@h/db"),
		slog.Group("req", slog.String("Authorization", "Bearer synthetic-secret-3"), slog.String("cookie", "sid=synthetic-secret-4")),
		slog.String("path", "/health"))
	line := buf.String()
	if strings.Contains(line, "synthetic-secret") {
		t.Fatalf("secret in log line: %s", line)
	}
	var entry map[string]any
	if err := json.Unmarshal([]byte(line), &entry); err != nil {
		t.Fatalf("not JSON: %v: %s", err, line)
	}
	if entry["msg"] != "start" || entry["path"] != "/health" || entry["password"] != Redacted {
		t.Fatalf("entry = %v", entry)
	}
}

func TestNewHonoursTheLevel(t *testing.T) {
	t.Parallel()
	var buf bytes.Buffer
	New(&buf, slog.LevelWarn).Info("hidden")
	if buf.Len() != 0 {
		t.Fatalf("info logged at warn level: %s", buf.String())
	}
}
