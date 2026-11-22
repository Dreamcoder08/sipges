//nolint:misspell // Spanish questions and answers in synthetic fixtures.
package http_test

import (
	"bytes"
	"encoding/json"
	"log/slog"
	"net/http"
	"strings"
	"testing"

	"github.com/Dreamcoder08/sipges/apps/api-go/internal/analyst/application"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/analyst/domain"
	analysthttp "github.com/Dreamcoder08/sipges/apps/api-go/internal/analyst/http"
)

// Each question logs one line with its token counts across the loop: counts, model, turns and
// duration, never the question, a record or the answer.
func TestAskLogsTheTokenCountsWithoutContent(t *testing.T) {
	t.Parallel()
	var logs bytes.Buffer
	logger := slog.New(slog.NewJSONHandler(&logs, nil))
	refs := []domain.RecordRef{{Slug: "conflictos", ID: "C-1", Title: "Bloqueo de vía secreto"}}
	model := &stepModel{steps: []application.Step{
		{Model: "claude-opus-5-5", Calls: []application.ToolCall{{ID: "1", Name: "search_records"}}, Usage: application.Usage{Input: 100, Output: 10, CacheCreation: 900}},
		{Model: "claude-opus-5-5", Text: "El bloqueo sigue [1].", Usage: application.Usage{Input: 50, Output: 25, CacheRead: 900}},
	}}
	res := ask(t, analysthttp.Options{Logger: logger, Ask: analystFor(model, oneTool{refs}, nil)}, `{"question":"¿Qué pasa en el norte?"}`)
	if res.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", res.Code, res.Body)
	}
	text := logs.String()
	for _, content := range []string{"norte", "bloqueo", "Bloqueo", "secreto", "C-1"} {
		if strings.Contains(text, content) {
			t.Fatalf("the log carries %q: %s", content, text)
		}
	}
	var line map[string]any
	if strings.Count(text, "\n") != 1 || json.Unmarshal([]byte(text), &line) != nil {
		t.Fatalf("want one JSON line, got %s", text)
	}
	want := map[string]any{
		"msg": "analyst_ask_usage", "model": "claude-opus-5-5", "turns": float64(2), "tool_calls": float64(1), "ok": true,
		"input_tokens": float64(150), "output_tokens": float64(35),
		"cache_creation_input_tokens": float64(900), "cache_read_input_tokens": float64(900),
	}
	for key, value := range want {
		if line[key] != value {
			t.Fatalf("%s = %v, want %v: %s", key, line[key], value, text)
		}
	}
	if _, ok := line["request_id"]; !ok {
		t.Fatalf("no request_id: %s", text)
	}
	if _, ok := line["duration_ms"]; !ok {
		t.Fatalf("no duration_ms: %s", text)
	}
}
