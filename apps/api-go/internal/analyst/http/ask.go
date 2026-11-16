package http

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"strings"
	"unicode/utf8"

	"github.com/Dreamcoder08/sipges/apps/api-go/internal/analyst/application"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/analyst/domain"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/platform/httpx"
	privacy "github.com/Dreamcoder08/sipges/apps/api-go/internal/privacy/application"
	tenancyhttp "github.com/Dreamcoder08/sipges/apps/api-go/internal/tenancy/http"
)

// POST /system/analyst/ask (odd/tasks/agentic-analyst.md S2): one question from the Inicio box,
// answered by the tool loop with cited sources. The session, project scope and role gate ran
// before (internal/app); the question computes and stores nothing, like /system/analyze.

// maxQuestion bounds a question, in characters.
const maxQuestion = 500

const (
	askInvalid     = "Escribe una pregunta de 1 a 500 caracteres"
	askUnavailable = "El analista no está configurado en esta instalación"
	askBadSources  = "El analista no citó bien sus fuentes; vuelve a preguntar"
	askNoAnswer    = "El analista no llegó a una respuesta; vuelve a preguntar"
	askTooSlow     = "El analista tardó demasiado; vuelve a preguntar"
)

type askSourceJSON struct {
	N      int    `json:"n"`
	Module string `json:"module"`
	ID     string `json:"id"`
	Title  string `json:"title"`
}

type askJSON struct {
	Answer  string          `json:"answer"`
	Sources []askSourceJSON `json:"sources"`
}

func askRoute(opts Options) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		question, ok := readQuestion(r)
		if !ok {
			httpx.WriteError(w, http.StatusUnprocessableEntity, askInvalid)
			return
		}
		scope, scoped := tenancyhttp.ScopeFrom(r.Context())
		if opts.Ask == nil || !scoped {
			httpx.WriteError(w, http.StatusServiceUnavailable, askUnavailable)
			return
		}
		analyst, err := opts.Ask(r.Context(), scope.TenantID())
		if err == nil {
			var answer domain.CitedAnswer
			if answer, err = analyst.Answer(r.Context(), question); err == nil {
				httpx.WriteJSON(w, http.StatusOK, toAskJSON(answer))
				return
			}
		}
		status, detail := askFailure(err)
		if status >= http.StatusInternalServerError && opts.Logger != nil {
			// Only the event: errors may carry a provider's or the driver's details.
			opts.Logger.LogAttrs(r.Context(), slog.LevelWarn, "analyst_ask_failed",
				slog.Int("status", status), slog.String("request_id", httpx.RequestIDFrom(r.Context())))
		}
		httpx.WriteError(w, status, detail)
	}
}

// readQuestion reads {"question": "..."}: trimmed, 1 to maxQuestion characters.
func readQuestion(r *http.Request) (string, bool) {
	raw, err := io.ReadAll(io.LimitReader(r.Body, 16<<10))
	if err != nil {
		return "", false
	}
	var body struct {
		Question *string `json:"question"`
	}
	if json.Unmarshal(raw, &body) != nil || body.Question == nil {
		return "", false
	}
	question := strings.TrimSpace(*body.Question)
	n := utf8.RuneCountInString(question)
	return question, n >= 1 && n <= maxQuestion
}

func askFailure(err error) (int, string) {
	switch {
	case errors.Is(err, privacy.ErrDisabled):
		return http.StatusConflict, privacy.ExternalAIDisabled
	case errors.Is(err, domain.ErrUnresolvedCitation), errors.Is(err, domain.ErrUncited):
		return http.StatusBadGateway, askBadSources
	case errors.Is(err, application.ErrTooManyToolCalls):
		return http.StatusBadGateway, askNoAnswer
	case errors.Is(err, context.DeadlineExceeded):
		return http.StatusGatewayTimeout, askTooSlow
	case errors.Is(err, application.ErrModel):
		return http.StatusBadGateway, askNoAnswer
	}
	return http.StatusInternalServerError, "Internal Server Error"
}

func toAskJSON(answer domain.CitedAnswer) askJSON {
	out := askJSON{Answer: answer.Text, Sources: make([]askSourceJSON, 0, len(answer.Sources))}
	for _, s := range answer.Sources {
		out.Sources = append(out.Sources, askSourceJSON{N: s.N, Module: s.Slug, ID: s.ID, Title: s.Title})
	}
	return out
}
