package http

import (
	"context"
	"crypto/sha256"
	"crypto/subtle"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/Dreamcoder08/sipges/apps/api-go/internal/automation/application"
	identityhttp "github.com/Dreamcoder08/sipges/apps/api-go/internal/identity/http"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/platform/httpx"
	tenancyhttp "github.com/Dreamcoder08/sipges/apps/api-go/internal/tenancy/http"
)

// CronPath is AUTOMATION_CRON_PATH: reached by schedulers with a bearer secret, never by
// browsers (ADR 0014 §4).
const CronPath = "/system/automations/cron"

// WriteOptions configures WriteRoutes.
type WriteOptions struct {
	Service application.Service
	Runtime *application.Runtime
	// CronSecret is SIPGES_CRON_SECRET (or CRON_SECRET); empty refuses every cron call.
	CronSecret string
	Logger     *slog.Logger
}

var ruleErrors = map[string]struct {
	status int
	detail string
}{
	"invalid_module":    {422, "Origen de eventos no válido"},
	"invalid_action":    {422, "Acción de auditoría no válida"},
	"invalid_condition": {422, "Condición no válida"},
	"invalid_step":      {422, "Acción de la regla no válida o canal inexistente"},
	"missing":           {404, "Regla no encontrada"},
	"duplicate":         {409, "Ya existe una regla con ese nombre"},
}

var channelErrors = map[string]struct {
	status int
	detail string
}{
	"invalid_url":      {422, "La dirección debe ser una URL https válida"},
	"private_host":     {422, "No se permiten destinos locales o de red privada"},
	"wrong_host":       {422, "La URL no corresponde al servicio elegido"},
	"invalid_settings": {422, "Configuración del canal incompleta o no válida"},
	"duplicate":        {409, "Ya existe un canal con ese nombre"},
}

type okID struct {
	OK bool  `json:"ok"`
	ID int64 `json:"id"`
}

type okOnly struct {
	OK bool `json:"ok"`
}

var idPattern = regexp.MustCompile(`^[0-9]{1,9}$`)

// idParam is idParam: up to nine digits, else nothing.
func idParam(r *http.Request) (int64, bool) {
	raw := httpx.PathParam(r, "id")
	if !idPattern.MatchString(raw) {
		return 0, false
	}
	id, err := strconv.ParseInt(raw, 10, 64)
	return id, err == nil
}

func tenantOf(r *http.Request) (string, bool) {
	scope, ok := tenancyhttp.ScopeFrom(r.Context())
	return scope.TenantID(), ok
}

func username(r *http.Request) (string, bool) {
	p, ok := identityhttp.PrincipalFrom(r.Context())
	if !ok || p == nil {
		return "", false
	}
	return p.Username, true
}

// bearerMatches is bearerMatches: a constant-time comparison of the bearer token's SHA-256
// against the secret's.
func bearerMatches(header string, present bool, secret string) bool {
	if secret == "" || !present || !strings.HasPrefix(header, "Bearer ") {
		return false
	}
	got := sha256.Sum256([]byte(strings.TrimFunc(header[7:], isJSSpace)))
	want := sha256.Sum256([]byte(secret))
	return subtle.ConstantTimeCompare(got[:], want[:]) == 1
}

func writeIssues(w http.ResponseWriter, issues []issue) {
	httpx.WriteJSONText(w, http.StatusUnprocessableEntity, httpx.ErrorBody{Detail: issues})
}

// writeDetail is c.json({ detail }, status), written as JSON.stringify writes it.
func writeDetail(w http.ResponseWriter, status int, detail string) {
	httpx.WriteJSONText(w, status, httpx.ErrorBody{Detail: detail})
}

// WriteRoutes registers the automation write routes, the tick and the cron.
func WriteRoutes(mux *http.ServeMux, opts WriteOptions) {
	fail := func(w http.ResponseWriter, r *http.Request, err error) {
		if opts.Logger != nil {
			attrs := []slog.Attr{slog.String("request_id", httpx.RequestIDFrom(r.Context()))}
			if errors.Is(err, application.ErrNoSealer) {
				attrs = append(attrs, slog.String("reason", "SIPGES_DATA_KEY is not configured"))
			}
			opts.Logger.LogAttrs(r.Context(), slog.LevelError, "automation write failed", attrs...)
		}
		httpx.WriteError(w, http.StatusInternalServerError, "Internal Server Error")
	}
	// session reads what every write needs: the scope's tenant and the session's user. Both are
	// set by the gates for these paths; without them the route refuses instead of guessing.
	session := func(w http.ResponseWriter, r *http.Request) (string, string, bool) {
		tenant, okScope := tenantOf(r)
		user, okUser := username(r)
		if !okScope || !okUser {
			fail(w, r, errors.New("automation: request without scope or session"))
			return "", "", false
		}
		return tenant, user, true
	}
	body := func(r *http.Request) []byte {
		b, err := io.ReadAll(r.Body)
		if err != nil {
			return nil // like Hono: an unreadable body fails JSON.parse
		}
		return b
	}

	cron := func(w http.ResponseWriter, r *http.Request) {
		header, present := httpx.Header(r, "Authorization")
		if !bearerMatches(header, present, opts.CronSecret) {
			writeDetail(w, http.StatusUnauthorized, "Credencial de cron no válida")
			return
		}
		ctx, cancel := detached(workerContext(r.Context()))
		defer cancel()
		report, err := opts.Runtime.Scheduled(ctx)
		if err != nil {
			fail(w, r, err)
			return
		}
		httpx.WriteJSONText(w, http.StatusOK, report)
	}
	// Some schedulers call with GET, others with POST.
	mux.HandleFunc("GET "+CronPath, cron)
	mux.HandleFunc("POST "+CronPath, cron)

	saveRule := func(w http.ResponseWriter, r *http.Request, id *int64) {
		tenant, user, ok := session(w, r)
		if !ok {
			return
		}
		in, issues := parse(body(r), ruleIn)
		if issues != nil {
			writeIssues(w, issues)
			return
		}
		saved, bad, err := opts.Service.SaveRule(r.Context(), tenant, id, in, user)
		if err != nil {
			fail(w, r, err)
			return
		}
		if bad != "" {
			e := ruleErrors[bad]
			writeDetail(w, e.status, e.detail)
			return
		}
		httpx.WriteJSONText(w, http.StatusOK, okID{OK: true, ID: saved})
	}
	mux.HandleFunc("POST /system/automations/rules", func(w http.ResponseWriter, r *http.Request) {
		saveRule(w, r, nil)
	})
	mux.HandleFunc("PUT /system/automations/rules/{id}", func(w http.ResponseWriter, r *http.Request) {
		id, ok := idParam(r)
		if !ok {
			writeDetail(w, http.StatusNotFound, ruleErrors["missing"].detail)
			return
		}
		saveRule(w, r, &id)
	})
	mux.HandleFunc("DELETE /system/automations/rules/{id}", func(w http.ResponseWriter, r *http.Request) {
		tenant, _, ok := session(w, r)
		if !ok {
			return
		}
		id, valid := idParam(r)
		removed := false
		if valid {
			var err error
			if removed, err = opts.Service.DeleteRule(r.Context(), tenant, id); err != nil {
				fail(w, r, err)
				return
			}
		}
		if !removed {
			writeDetail(w, http.StatusNotFound, ruleErrors["missing"].detail)
			return
		}
		httpx.WriteJSONText(w, http.StatusOK, okOnly{OK: true})
	})

	mux.HandleFunc("POST /system/automations/channels", func(w http.ResponseWriter, r *http.Request) {
		tenant, user, ok := session(w, r)
		if !ok {
			return
		}
		in, issues := parse(body(r), channelIn)
		if issues != nil {
			writeIssues(w, issues)
			return
		}
		id, bad, err := opts.Service.CreateChannel(r.Context(), tenant, in.Kind, in.Name, in.Settings, user)
		if err != nil {
			fail(w, r, err)
			return
		}
		if bad != "" {
			e := channelErrors[bad]
			writeDetail(w, e.status, e.detail)
			return
		}
		httpx.WriteJSONText(w, http.StatusOK, okID{OK: true, ID: id})
	})
	mux.HandleFunc("POST /system/automations/channels/{id}/test", func(w http.ResponseWriter, r *http.Request) {
		id, valid := idParam(r)
		if !valid {
			writeDetail(w, http.StatusNotFound, "Canal no encontrado")
			return
		}
		tenant, _, ok := session(w, r)
		if !ok {
			return
		}
		detail, sent, err := opts.Service.TestChannel(r.Context(), tenant, id)
		if err != nil {
			fail(w, r, err)
			return
		}
		if !sent {
			writeDetail(w, http.StatusBadGateway, detail)
			return
		}
		httpx.WriteJSONText(w, http.StatusOK, okOnly{OK: true})
	})
	mux.HandleFunc("DELETE /system/automations/channels/{id}", func(w http.ResponseWriter, r *http.Request) {
		tenant, _, ok := session(w, r)
		if !ok {
			return
		}
		outcome := "missing"
		if id, valid := idParam(r); valid {
			var err error
			if outcome, err = opts.Service.DeleteChannel(r.Context(), tenant, id); err != nil {
				fail(w, r, err)
				return
			}
		}
		switch outcome {
		case "in_use":
			writeDetail(w, http.StatusConflict, "Una regla activa usa este canal; pausa o edita la regla")
		case "deleted":
			httpx.WriteJSONText(w, http.StatusOK, okOnly{OK: true})
		default:
			writeDetail(w, http.StatusNotFound, "Canal no encontrado")
		}
	})

	mux.HandleFunc("POST /system/automations/tick", func(w http.ResponseWriter, r *http.Request) {
		tenant, _, ok := session(w, r)
		if !ok {
			return
		}
		ctx, cancel := detached(r.Context())
		defer cancel()
		report, err := opts.Runtime.TickNow(ctx, tenant)
		if err != nil {
			fail(w, r, err)
			return
		}
		httpx.WriteJSONText(w, http.StatusOK, report)
	})

	mux.HandleFunc("POST /system/notifications/read", func(w http.ResponseWriter, r *http.Request) {
		tenant, user, ok := session(w, r)
		if !ok {
			return
		}
		in, issues := parse(body(r), readIn)
		if issues != nil {
			writeIssues(w, issues)
			return
		}
		ids := in.IDs
		if in.All {
			ids = nil
		}
		if err := opts.Service.MarkRead(r.Context(), tenant, user, ids); err != nil {
			fail(w, r, err)
			return
		}
		httpx.WriteJSONText(w, http.StatusOK, okOnly{OK: true})
	})
}

// TickTimeout bounds a tick a request runs (the cron, POST /system/automations/tick).
const TickTimeout = 5 * time.Minute

// detached keeps ctx's values (actor, request id) without its cancellation: a client that
// disconnects mid-tick must not stop it between a channel send and the run's bookkeeping, which
// would resend the message after the lease. On Node a client abort does not cancel the tick
// either.
func detached(ctx context.Context) (context.Context, context.CancelFunc) {
	return context.WithTimeout(context.WithoutCancel(ctx), TickTimeout)
}

// workerContext is the context the scheduler's ticks run in: the request's cancellation, the
// worker's actor ('automation', full clearance), as runWithRequestContext sets it in compose.ts.
func workerContext(ctx context.Context) context.Context {
	return application.WorkerContext(ctx)
}
