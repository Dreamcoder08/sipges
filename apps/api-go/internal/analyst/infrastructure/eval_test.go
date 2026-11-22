//nolint:misspell // Spanish refusals, as the MCP server words them.
package infrastructure

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"slices"
	"strings"
	"sync"
	"testing"

	"github.com/Dreamcoder08/sipges/apps/api-go/internal/analyst/application"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/analyst/domain"
	privacy "github.com/Dreamcoder08/sipges/apps/api-go/internal/privacy/application"
)

// The offline eval set (testdata/eval/README.md): each case replays hand-written Claude answers
// through the real loop (application.Ask over this adapter) against a fake server and grades what
// the pipeline did with them. No model is ever called.

type evalRecord struct {
	Module string `json:"module"`
	ID     string `json:"id"`
	Title  string `json:"title"`
	Text   string `json:"text"`
}

type evalCase struct {
	Description string            `json:"description"`
	Records     []evalRecord      `json:"records"`
	Question    string            `json:"question"`
	Turns       []json.RawMessage `json:"turns"`
	Expect      struct {
		// Cited lists module/id of the records the answer must cite, in number order; an empty list
		// is an answer that cites nothing. Error names the expected failure instead. ToolsRun counts
		// the calls that reached the tools (a malformed call never does).
		Cited    *[]string `json:"cited"`
		Error    string    `json:"error"`
		Cause    string    `json:"cause"`
		ToolsRun *int      `json:"tools_run"`
		Blocks   *int      `json:"blocks"`
	} `json:"expect"`
}

var evalErrors = map[string]error{
	"unresolved_citation": domain.ErrUnresolvedCitation,
	"uncited":             domain.ErrUncited,
	"too_many_tool_calls": application.ErrTooManyToolCalls,
	"model":               application.ErrModel,
}

func TestEvalSet(t *testing.T) {
	t.Parallel()
	paths, err := filepath.Glob(filepath.Join("testdata", "eval", "*.json"))
	if err != nil || len(paths) < 20 {
		t.Fatalf("eval cases = %d (%v), want at least 20", len(paths), err)
	}
	for _, path := range paths {
		name := strings.TrimSuffix(filepath.Base(path), ".json")
		t.Run(name, func(t *testing.T) {
			t.Parallel()
			raw, err := os.ReadFile(path)
			if err != nil {
				t.Fatal(err)
			}
			var c evalCase
			if err := json.Unmarshal(raw, &c); err != nil {
				t.Fatalf("unreadable case: %v", err)
			}
			if (c.Expect.Cited == nil) == (c.Expect.Error == "") {
				t.Fatal("a case expects either cited records or an error")
			}
			runEvalCase(t, c)
		})
	}
}

func runEvalCase(t *testing.T, c evalCase) {
	t.Helper()
	srv := &evalServer{t: t, turns: c.Turns}
	httpSrv := httptest.NewServer(srv)
	t.Cleanup(httpSrv.Close)
	tools := &evalTools{records: c.Records}
	var reports []application.AskReport
	ask := application.Ask{
		Model: NewClaude("claude-opus-5-5", environment(map[string]string{"ANTHROPIC_BASE_URL": httpSrv.URL, "ANTHROPIC_API_KEY": "synthetic-test-value"})),
		Tools: tools,
		Seal: func(_ context.Context, texts []string) ([]privacy.Sanitised[string], error) {
			out := make([]privacy.Sanitised[string], 0, len(texts))
			for _, text := range texts {
				out = append(out, privacy.ExemptPayload(text, privacy.ExemptConstant))
			}
			return out, nil
		},
		Report: func(_ context.Context, r application.AskReport) { reports = append(reports, r) },
	}
	answer, err := ask.Answer(t.Context(), c.Question)

	if c.Expect.Error != "" {
		want, known := evalErrors[c.Expect.Error]
		if !known {
			t.Fatalf("unknown expected error %q", c.Expect.Error)
		}
		if !errors.Is(err, want) || !strings.Contains(errText(err), c.Expect.Cause) {
			t.Fatalf("err = %v, want %s (%q); answer = %+v", err, c.Expect.Error, c.Expect.Cause, answer)
		}
	} else {
		if err != nil {
			t.Fatalf("err = %v, want an answer citing %v", err, *c.Expect.Cited)
		}
		cited := make([]string, 0, len(answer.Sources))
		for _, s := range answer.Sources {
			cited = append(cited, s.Slug+"/"+s.ID)
		}
		if !slices.Equal(cited, *c.Expect.Cited) {
			t.Fatalf("cited = %v, want %v; answer = %q", cited, *c.Expect.Cited, answer.Text)
		}
		if c.Expect.Blocks != nil && len(answer.Blocks) != *c.Expect.Blocks {
			t.Fatalf("blocks = %+v, want %d", answer.Blocks, *c.Expect.Blocks)
		}
	}

	srv.mu.Lock()
	served := srv.served
	srv.mu.Unlock()
	if served != len(c.Turns) {
		t.Fatalf("the loop made %d model calls, the case recorded %d", served, len(c.Turns))
	}
	if c.Expect.ToolsRun != nil && tools.ran+tools.refused != *c.Expect.ToolsRun {
		t.Fatalf("tools run = %d, want %d", tools.ran+tools.refused, *c.Expect.ToolsRun)
	}
	// Token accounting: one report, the usage of every recorded answer added up.
	if len(reports) != 1 || reports[0].Usage != recordedUsage(t, c.Turns) || reports[0].Turns != len(c.Turns) ||
		reports[0].OK != (err == nil) || reports[0].Model != "claude-opus-5-5" {
		t.Fatalf("reports = %+v, want the usage %+v over %d turns", reports, recordedUsage(t, c.Turns), len(c.Turns))
	}
}

func errText(err error) string {
	if err == nil {
		return ""
	}
	return err.Error()
}

func recordedUsage(t *testing.T, turns []json.RawMessage) application.Usage {
	t.Helper()
	var total application.Usage
	for _, turn := range turns {
		var answer struct {
			Usage claudeUsage `json:"usage"`
		}
		if err := json.Unmarshal(turn, &answer); err != nil {
			t.Fatal(err)
		}
		total = total.Plus(answer.Usage.counts())
	}
	return total
}

// evalServer answers request k with recorded turn k, after checking what a real API would refuse:
// every earlier assistant turn sent back unchanged (thinking blocks included), one tool result per
// tool call of the turn before, the cache breakpoints, and no request past the recorded turns.
type evalServer struct {
	t      *testing.T
	turns  []json.RawMessage
	mu     sync.Mutex
	served int
}

func (s *evalServer) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	s.mu.Lock()
	k := s.served
	s.served++
	s.mu.Unlock()
	body, _ := io.ReadAll(r.Body)
	if k >= len(s.turns) {
		s.t.Errorf("request %d past the %d recorded turns", k+1, len(s.turns))
		w.WriteHeader(http.StatusBadRequest)
		return
	}
	if problem := s.check(k, body); problem != "" {
		s.t.Errorf("request %d: %s\n%s", k+1, problem, body)
		w.WriteHeader(http.StatusBadRequest)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	_, _ = w.Write(s.turns[k])
}

type evalMessage struct {
	Role    string            `json:"role"`
	Content []json.RawMessage `json:"content"`
}

func (s *evalServer) check(k int, body []byte) string {
	var req struct {
		System   []map[string]any `json:"system"`
		Messages []evalMessage    `json:"messages"`
	}
	if err := json.Unmarshal(body, &req); err != nil {
		return "unreadable request"
	}
	if len(req.System) != 1 || !isEphemeral(req.System[0]["cache_control"]) {
		return "the system prompt is not a cache breakpoint"
	}
	// The question, then for each earlier turn its assistant reply and the user's tool results.
	if len(req.Messages) != 1+2*k {
		return "unexpected number of messages"
	}
	for j := range k {
		var recorded struct {
			Content []any `json:"content"`
		}
		_ = json.Unmarshal(s.turns[j], &recorded)
		sent := make([]any, 0, len(req.Messages[1+2*j].Content))
		ids := []string{}
		for _, b := range req.Messages[1+2*j].Content {
			var block map[string]any
			_ = json.Unmarshal(b, &block)
			sent = append(sent, block)
			if block["type"] == "tool_use" {
				ids = append(ids, block["id"].(string))
			}
		}
		if req.Messages[1+2*j].Role != "assistant" || !reflect.DeepEqual(sent, recorded.Content) {
			return "an earlier assistant turn was not sent back unchanged"
		}
		results := req.Messages[2+2*j]
		got := []string{}
		for _, b := range results.Content {
			var block struct {
				Type      string `json:"type"`
				ToolUseID string `json:"tool_use_id"`
			}
			_ = json.Unmarshal(b, &block)
			if block.Type == "tool_result" {
				got = append(got, block.ToolUseID)
			}
		}
		if results.Role != "user" || !slices.Equal(got, ids) {
			return "the tool results do not answer the tool calls"
		}
	}
	last := req.Messages[len(req.Messages)-1].Content
	var lastBlock map[string]any
	_ = json.Unmarshal(last[len(last)-1], &lastBlock)
	if !isEphemeral(lastBlock["cache_control"]) {
		return "the conversation does not end in a cache breakpoint"
	}
	return ""
}

// evalTools is a synthetic project behind two of the MCP read tools: search_records finds the
// records whose title or text contains the query, get_record reads one record.
type evalTools struct {
	records []evalRecord
	ran     int
	refused int
}

func (e *evalTools) Specs() []application.ToolSpec {
	return []application.ToolSpec{
		{Name: "search_records", Description: "Busca registros del proyecto por texto.", InputSchema: json.RawMessage(`{"type":"object","properties":{"query":{"type":"string"}},"required":["query"]}`)},
		{Name: "get_record", Description: "Lee un registro por módulo e id.", InputSchema: json.RawMessage(`{"type":"object","properties":{"module":{"type":"string"},"id":{"type":"string"}},"required":["module","id"]}`)},
	}
}

func (e *evalTools) Run(_ context.Context, name string, input json.RawMessage) (application.ToolOutput, error) {
	var args struct {
		Query  string `json:"query"`
		Module string `json:"module"`
		ID     string `json:"id"`
	}
	if err := json.Unmarshal(input, &args); err != nil {
		e.refused++
		return application.ToolOutput{Refusal: "Argumentos no válidos"}, nil
	}
	var found []evalRecord
	switch name {
	case "search_records":
		query := strings.ToLower(args.Query)
		for _, r := range e.records {
			if query != "" && strings.Contains(strings.ToLower(r.Title+" "+r.Text), query) {
				found = append(found, r)
			}
		}
	case "get_record":
		for _, r := range e.records {
			if r.Module == args.Module && r.ID == args.ID {
				found = append(found, r)
			}
		}
		if len(found) == 0 {
			e.refused++
			return application.ToolOutput{Refusal: "Registro no encontrado"}, nil
		}
	default:
		e.refused++
		return application.ToolOutput{Refusal: "Herramienta desconocida: " + name}, nil
	}
	e.ran++
	refs := make([]domain.RecordRef, 0, len(found))
	items := make([]map[string]string, 0, len(found))
	for _, r := range found {
		refs = append(refs, domain.RecordRef{Slug: r.Module, ID: r.ID, Title: r.Title})
		items = append(items, map[string]string{"module": r.Module, "id": r.ID, "title": r.Title, "text": r.Text})
	}
	data := map[string]any{"total": len(found), "items": items}
	return application.ToolOutput{OK: true, Data: privacy.ExemptPayload[any](data, privacy.ExemptConstant), Records: refs}, nil
}
