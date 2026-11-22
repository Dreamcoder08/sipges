package http_test

import (
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	analysthttp "github.com/Dreamcoder08/sipges/apps/api-go/internal/analyst/http"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/analyst/infrastructure"
)

// Every way Claude can answer badly reaches the person as one of the fixed Spanish errors, never
// as the model's own text or a citation nobody checked.
func TestAskTurnsEachBadReplyIntoAFixedSpanishError(t *testing.T) {
	t.Parallel()
	const (
		noAnswer   = `{"detail":"El analista no llegó a una respuesta; vuelve a preguntar"}`
		badSources = `{"detail":"El analista no citó bien sus fuentes; vuelve a preguntar"}`
	)
	cases := map[string]struct{ reply, want string }{
		"refusal":         {`{"stop_reason":"refusal","content":[{"type":"text","text":"No puedo [1]."}]}`, noAnswer},
		"max_tokens":      {`{"stop_reason":"max_tokens","content":[{"type":"text","text":"El bloqueo sig"}]}`, noAnswer},
		"pause_turn":      {`{"stop_reason":"pause_turn","content":[{"type":"text","text":"El bloqueo sigue."}]}`, noAnswer},
		"blank answer":    {`{"stop_reason":"end_turn","content":[{"type":"text","text":"  \n "}]}`, noAnswer},
		"thinking only":   {`{"stop_reason":"end_turn","content":[{"type":"thinking","thinking":"…","signature":"s"}]}`, noAnswer},
		"unreadable":      {`{"stop_reason":"end_turn","content":"nope"}`, noAnswer},
		"unsourced cite":  {`{"stop_reason":"end_turn","content":[{"type":"text","text":"Hubo heridos [7]."}]}`, badSources},
		"five-digit cite": {`{"stop_reason":"end_turn","content":[{"type":"text","text":"Hubo heridos [12345]."}]}`, badSources},
	}
	for name, tc := range cases {
		t.Run(name, func(t *testing.T) {
			t.Parallel()
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				_, _ = io.Copy(io.Discard, r.Body)
				w.Header().Set("Content-Type", "application/json")
				_, _ = io.WriteString(w, tc.reply)
			}))
			t.Cleanup(srv.Close)
			model := infrastructure.NewClaude("m", lookup(map[string]string{"ANTHROPIC_BASE_URL": srv.URL, "ANTHROPIC_API_KEY": "synthetic-test-value"}))
			res := ask(t, analysthttp.Options{Ask: analystFor(model, oneTool{}, nil)}, `{"question":"¿Algo?"}`)
			if res.Code != http.StatusBadGateway || strings.TrimSpace(res.Body.String()) != tc.want {
				t.Fatalf("status = %d, body = %s", res.Code, res.Body)
			}
		})
	}
}
