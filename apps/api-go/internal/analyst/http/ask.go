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
// before (internal/app); the question writes no record, like /system/analyze, and files a pending
// proposal only for a person who may write its module (S4).

// maxQuestion bounds a question, in characters.
const maxQuestion = 500

const (
	askInvalid     = "Escribe una pregunta de 1 a 500 caracteres"
	askUnavailable = "El analista no está configurado en esta instalación"
	askBadSources  = "El analista no citó bien sus fuentes; vuelve a preguntar"
	askNoAnswer    = "El analista no llegó a una respuesta; vuelve a preguntar"
	askTooSlow     = "El analista tardó demasiado; vuelve a preguntar"
	// askProviderDown is a model provider out of reach (local QA T6): the bridge stopped, its
	// login expired or its quota ran out. A 503, like no analyst at all: the search still works.
	askProviderDown = "El analista no respondió: el servicio de IA no está disponible. " +
		"Prueba de nuevo en unos minutos o avisa a quien administra SIPGES."
)

// StatusClientClosed answers a question whose client went away (nginx's 499): no server fault,
// so it is neither a 5xx nor logged as a failure.
const StatusClientClosed = 499

type askSourceJSON struct {
	N      int    `json:"n"`
	Module string `json:"module"`
	ID     string `json:"id"`
	Title  string `json:"title"`
}

type askEntryJSON struct {
	Date string `json:"date"`
	Text string `json:"text"`
}

// askBlockJSON is a typed block (S3): its kind, its record, and by kind a plain text or events.
type askBlockJSON struct {
	Type string `json:"type"`
	askSourceJSON
	Text    string         `json:"text,omitempty"`
	Entries []askEntryJSON `json:"entries,omitempty"`
}

// askJSON keeps T1's answer and sources unchanged; blocks came later and is always a list.
type askJSON struct {
	Answer  string          `json:"answer"`
	Sources []askSourceJSON `json:"sources"`
	Blocks  []askBlockJSON  `json:"blocks"`
}

func askRoute(opts Options) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		question, valid := readQuestion(r)
		answer, err := answerQuestion(r.Context(), opts, question, valid, nil)
		if err == nil {
			httpx.WriteJSON(w, http.StatusOK, toAskJSON(answer))
			return
		}
		status, detail := askFailure(err)
		logAskFailure(r, opts, status, err)
		httpx.WriteError(w, status, detail)
	}
}

var (
	// errInvalidQuestion is a body without a question of 1 to maxQuestion characters.
	errInvalidQuestion = errors.New("analyst: invalid question")
	// errNoAnalyst is an installation without an analyst, or a request without a project.
	errNoAnalyst = errors.New("analyst: no analyst for this request")
)

// answerQuestion is the question of /ask and /ask/stream: the same checks in the same order, the
// analyst of the request's project, and the loop, reporting to progress when it is not nil.
func answerQuestion(ctx context.Context, opts Options, question string, valid bool, progress application.Progress) (domain.CitedAnswer, error) {
	if !valid {
		return domain.CitedAnswer{}, errInvalidQuestion
	}
	scope, scoped := tenancyhttp.ScopeFrom(ctx)
	if opts.Ask == nil || !scoped {
		return domain.CitedAnswer{}, errNoAnalyst
	}
	analyst, err := opts.Ask(ctx, scope.TenantID())
	if err != nil {
		return domain.CitedAnswer{}, err
	}
	return analyst.AnswerWithProgress(ctx, question, progress)
}

// logAskFailure logs a server-side failure of a question; the client's own failures are not logged.
func logAskFailure(r *http.Request, opts Options, status int, err error) {
	if status < http.StatusInternalServerError || opts.Logger == nil {
		return
	}
	attrs := []slog.Attr{slog.Int("status", status), slog.String("request_id", httpx.RequestIDFrom(r.Context()))}
	// Model errors are the adapters' fixed texts; any other error may carry the driver's
	// details, so only the event is logged.
	if errors.Is(err, application.ErrModel) {
		attrs = append(attrs, slog.String("cause", err.Error()))
	}
	opts.Logger.LogAttrs(r.Context(), slog.LevelWarn, "analyst_ask_failed", attrs...)
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
	case errors.Is(err, errInvalidQuestion):
		return http.StatusUnprocessableEntity, askInvalid
	case errors.Is(err, errNoAnalyst):
		return http.StatusServiceUnavailable, askUnavailable
	case errors.Is(err, privacy.ErrDisabled):
		return http.StatusConflict, privacy.ExternalAIDisabled
	case errors.Is(err, domain.ErrUnresolvedCitation), errors.Is(err, domain.ErrUncited):
		return http.StatusBadGateway, askBadSources
	case errors.Is(err, application.ErrTooManyToolCalls):
		return http.StatusBadGateway, askNoAnswer
	case errors.Is(err, context.Canceled):
		return StatusClientClosed, "Pregunta cancelada"
	case errors.Is(err, context.DeadlineExceeded):
		return http.StatusGatewayTimeout, askTooSlow
	case errors.Is(err, application.ErrModelUnavailable):
		return http.StatusServiceUnavailable, askProviderDown
	case errors.Is(err, application.ErrModel):
		return http.StatusBadGateway, askNoAnswer
	}
	return http.StatusInternalServerError, "Internal Server Error"
}

func toSourceJSON(s domain.Cited) askSourceJSON {
	return askSourceJSON{N: s.N, Module: s.Slug, ID: s.ID, Title: s.Title}
}

func toAskJSON(answer domain.CitedAnswer) askJSON {
	out := askJSON{
		Answer:  answer.Text,
		Sources: make([]askSourceJSON, 0, len(answer.Sources)),
		Blocks:  make([]askBlockJSON, 0, len(answer.Blocks)),
	}
	for _, s := range answer.Sources {
		out.Sources = append(out.Sources, toSourceJSON(s))
	}
	for _, b := range answer.Blocks {
		block := askBlockJSON{Type: string(b.Kind), askSourceJSON: toSourceJSON(b.Source), Text: b.Text}
		for _, e := range b.Entries {
			block.Entries = append(block.Entries, askEntryJSON{Date: e.Date, Text: e.Text})
		}
		out.Blocks = append(out.Blocks, block)
	}
	return out
}
