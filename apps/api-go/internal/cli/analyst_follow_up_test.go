package cli

import (
	"encoding/json"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

const syntheticHistory = `[{"question":"¿Qué pasa en el norte?","answer":"El bloqueo sigue [1]."}]`

func historyFile(t *testing.T, content string) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "history.json")
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
	return path
}

// odd/tasks/chat-first-ui.md T9: --follow-up adds the earlier turns of a file to the body as
// "history", on /ask and, with --steps, on /ask/stream.
func TestAnalystAskFollowUpSendsTheHistoryWithTheQuestion(t *testing.T) {
	for _, steps := range []bool{false, true} {
		var body map[string]any
		h := newHarness(t, func(w http.ResponseWriter, r *http.Request) {
			raw, _ := io.ReadAll(r.Body)
			_ = json.Unmarshal(raw, &body)
			if steps {
				streamEvents(w, "event: answer\ndata: "+syntheticAnswer+"\n\n", "event: done\ndata: {}\n\n")
				return
			}
			jsonAnswer(w, http.StatusOK, syntheticAnswer)
		})
		args := []string{"analyst", "ask", "--body", "-", "--follow-up", historyFile(t, syntheticHistory)}
		if steps {
			args = append(args, "--steps")
		}
		got := h.run(`{"question":"¿Desde cuándo?"}`, args...)
		if got.code != ExitOK {
			t.Fatalf("steps=%v: exit %d, stderr %s", steps, got.code, got.stderr)
		}
		raw, _ := json.Marshal(body)
		want := `{"history":[{"answer":"El bloqueo sigue [1].","question":"¿Qué pasa en el norte?"}],"question":"¿Desde cuándo?"}`
		if string(raw) != want {
			t.Fatalf("steps=%v: body %s, want %s", steps, raw, want)
		}
	}
}

func TestAnalystAskFollowUpRefusesWhatItCannotMerge(t *testing.T) {
	h := newHarness(t, func(w http.ResponseWriter, _ *http.Request) {
		t.Error("nothing should reach the API")
		jsonAnswer(w, http.StatusOK, syntheticAnswer)
	})
	cases := map[string]struct {
		stdin string
		args  []string
		says  string
	}{
		"no body":          {"", []string{"--follow-up", historyFile(t, syntheticHistory)}, "--follow-up needs --body"},
		"not a list":       {syntheticAsk, []string{"--body", "-", "--follow-up", historyFile(t, `{"question":"x"}`)}, "a JSON list"},
		"history in body":  {`{"question":"x","history":[]}`, []string{"--body", "-", "--follow-up", historyFile(t, syntheticHistory)}, "already has a history"},
		"body not object":  {`["x"]`, []string{"--body", "-", "--follow-up", historyFile(t, syntheticHistory)}, "a JSON object"},
		"missing the file": {syntheticAsk, []string{"--body", "-", "--follow-up", filepath.Join(t.TempDir(), "none.json")}, "history"},
	}
	for name, tc := range cases {
		got := h.run(tc.stdin, append([]string{"analyst", "ask"}, tc.args...)...)
		if got.code == ExitOK || !strings.Contains(got.stderr, tc.says) {
			t.Errorf("%s: exit %d, stderr %q, want it to say %q", name, got.code, got.stderr, tc.says)
		}
	}
}
