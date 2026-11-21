package http

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
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

// POST /system/analyst/ask (odd/archive/agentic-analyst.md S2): one question from the Inicio box,
// answered by the tool loop with cited sources. The session, project scope and role gate ran
// before (internal/app); the question writes no record, like /system/analyze, and files a pending
// proposal only for a person who may write its module (S4).

// maxQuestion bounds a question, in characters.
const maxQuestion = 500

const (
	askInvalid = "Escribe una pregunta de 1 a 500 caracteres"
	// askInvalidHistory is a follow-up whose earlier turns pass their limits (chat-first-ui T9).
	askInvalidHistory = "El historial admite hasta 6 turnos y 8.000 caracteres, cada uno con su pregunta y su respuesta"
	askUnavailable    = "El analista no está configurado en esta instalación"
	askBadSources     = "El analista no citó bien sus fuentes; vuelve a preguntar"
	askNoAnswer       = "El analista no llegó a una respuesta; vuelve a preguntar"
	askTooSlow        = "El analista tardó demasiado; vuelve a preguntar"
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
		req := readAsk(r)
		answer, err := answerQuestion(r.Context(), opts, req, nil)
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
func answerQuestion(ctx context.Context, opts Options, req askRequest, progress application.Progress) (domain.CitedAnswer, error) {
	if req.err != nil {
		return domain.CitedAnswer{}, req.err
	}
	scope, scoped := tenancyhttp.ScopeFrom(ctx)
	if opts.Ask == nil || !scoped {
		return domain.CitedAnswer{}, errNoAnalyst
	}
	analyst, err := opts.Ask(ctx, scope.TenantID())
	if err != nil {
		return domain.CitedAnswer{}, err
	}
	return analyst.AnswerFollowUp(ctx, req.question, req.history, progress)
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

// maxAskBody bounds the body: a question and a full history at their character limits, each
// character outside the BMP written as a JSON surrogate pair (\uXXXX\uXXXX, twelve bytes), with
// the keys around them. 8,500 × 12 is about 100 KB.
const maxAskBody = 128 << 10

// askRequest is a read body: the question, the earlier turns of a follow-up, or why it is refused.
type askRequest struct {
	question string
	history  []application.Exchange
	err      error
}

// readAsk reads {"question": "...", "history": [{"question": "...", "answer": "..."}]}: the
// question trimmed, 1 to maxQuestion characters; history optional, within application's limits.
func readAsk(r *http.Request) askRequest {
	raw, err := io.ReadAll(io.LimitReader(r.Body, maxAskBody))
	if err != nil {
		return askRequest{err: errInvalidQuestion}
	}
	var body struct {
		Question *string         `json:"question"`
		History  json.RawMessage `json:"history"`
	}
	if json.Unmarshal(raw, &body) != nil || body.Question == nil {
		return askRequest{err: errInvalidQuestion}
	}
	question := strings.TrimSpace(*body.Question)
	if n := utf8.RuneCountInString(question); n < 1 || n > maxQuestion {
		return askRequest{err: errInvalidQuestion}
	}
	history, err := readHistory(body.History)
	if err != nil {
		return askRequest{err: err}
	}
	return askRequest{question: question, history: history}
}

// readHistory reads the optional earlier turns; each needs both texts.
func readHistory(raw json.RawMessage) ([]application.Exchange, error) {
	if len(raw) == 0 || string(raw) == "null" {
		return nil, nil
	}
	var turns []struct {
		Question *string `json:"question"`
		Answer   *string `json:"answer"`
	}
	if json.Unmarshal(raw, &turns) != nil {
		return nil, application.ErrInvalidHistory
	}
	history := make([]application.Exchange, 0, len(turns))
	for _, turn := range turns {
		if turn.Question == nil || turn.Answer == nil {
			return nil, application.ErrInvalidHistory
		}
		history = append(history, application.Exchange{Question: *turn.Question, Answer: *turn.Answer})
	}
	return history, application.CheckHistory(history)
}

func askFailure(err error) (int, string) {
	status, detail := askFailureBase(err)
	var pending *application.PendingProposalsError
	if errors.As(err, &pending) && pending.Count > 0 {
		detail += ". " + pendingProposalsNote(pending.Count)
	}
	return status, detail
}

// pendingProposalsNote tells the person that the failed question left proposals in Bandeja.
func pendingProposalsNote(count int) string {
	if count == 1 {
		return "Antes de fallar dejó 1 propuesta pendiente de aprobación en Bandeja."
	}
	return fmt.Sprintf("Antes de fallar dejó %d propuestas pendientes de aprobación en Bandeja.", count)
}

func askFailureBase(err error) (int, string) {
	switch {
	case errors.Is(err, errInvalidQuestion):
		return http.StatusUnprocessableEntity, askInvalid
	case errors.Is(err, application.ErrInvalidHistory):
		return http.StatusUnprocessableEntity, askInvalidHistory
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
