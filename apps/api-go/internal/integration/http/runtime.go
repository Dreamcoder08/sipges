//nolint:misspell // Spanish module names, fields and messages, verbatim from the TypeScript API.
package http

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"math"
	"net/http"
	"regexp"
	"strings"

	identityhttp "github.com/Dreamcoder08/sipges/apps/api-go/internal/identity/http"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/integration/application"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/integration/domain"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/platform/database"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/platform/httpx"
	records "github.com/Dreamcoder08/sipges/apps/api-go/internal/records/domain"
	tenancyhttp "github.com/Dreamcoder08/sipges/apps/api-go/internal/tenancy/http"
)

// The integration runtime routes, with the answers of apps/api/src/contexts/integration/http:
// the public webhooks POST /hooks/ingest/{module} (ingest-routes.ts) and POST /hooks/signals
// (signal-routes.ts), authenticated by an API key; the admin writes of media-routes.ts and
// source-routes.ts; and POST and DELETE /system/integrations/api-keys (api-key-routes.ts).

// KeyService verifies, issues and revokes API keys.
type KeyService interface {
	Authenticate(ctx context.Context, header string, present bool) (*domain.Principal, error)
	Create(ctx context.Context, tenantID string, input domain.KeyInput, actor string) (application.IssuedKey, error)
	Revoke(ctx context.Context, tenantID string, id int) (bool, error)
}

// IngestService runs one inbound webhook call.
type IngestService interface {
	Run(ctx context.Context, req application.IngestRequest) (application.Outcome, error)
}

// MediaService is the media monitor.
type MediaService interface {
	Create(ctx context.Context, tenantID string, in domain.FeedInput, actor string) (*domain.MediaFeed, string, error)
	Update(ctx context.Context, tenantID string, id int, in domain.FeedInput, actor string) (*domain.MediaFeed, string, error)
	Remove(ctx context.Context, tenantID string, id int) (bool, error)
	Preview(ctx context.Context, url string, keywords []string) (*application.Preview, string, error)
	Poll(ctx context.Context, tenantID string, force bool) (application.PollReport, error)
}

// SourceService is the Defensoría connector.
type SourceService interface {
	Preview(ctx context.Context, query string) ([]domain.OfficialPost, error)
	Configure(ctx context.Context, tenantID string, in domain.SourceConfig, username string) (domain.SourceState, error)
	Import(ctx context.Context, tenantID string, in domain.SourceImport) (string, bool, error)
	Poll(ctx context.Context, tenantID string) (application.SourcePoll, error)
}

// Runtime holds the services of the runtime routes.
type Runtime struct {
	Keys    KeyService
	Ingest  IngestService
	Media   MediaService
	Sources SourceService
	Log     *slog.Logger
}

// Body limits of the webhooks.
const (
	ingestLimit = 512 * 1024
	signalLimit = 64 * 1024
)

// RegisterRuntime mounts the runtime routes. The webhooks are machine paths: the session,
// project scope and role gate let them through (internal/identity/http), and the API key is
// their only credential. The admin writes run behind those gates (admin only for media and API
// keys, a writing role for the Defensoría connector).
func RegisterRuntime(mux *http.ServeMux, rt Runtime) {
	mux.HandleFunc("POST /hooks/ingest/{module}", rt.ingest)
	mux.HandleFunc("POST /hooks/signals", rt.signal)
	mux.HandleFunc("POST /system/v4/media/feeds", rt.scoped(rt.createFeed))
	mux.HandleFunc("PUT /system/v4/media/feeds/{id}", rt.scoped(rt.updateFeed))
	mux.HandleFunc("DELETE /system/v4/media/feeds/{id}", rt.scoped(rt.removeFeed))
	mux.HandleFunc("POST /system/v4/media/preview", rt.scoped(rt.previewFeed))
	mux.HandleFunc("POST /system/v4/media/poll", rt.scoped(rt.pollFeeds))
	mux.HandleFunc("GET /system/intelligence/sources/defensoria/preview", rt.scoped(rt.previewSource))
	mux.HandleFunc("PUT /system/intelligence/sources/defensoria/config", rt.scoped(rt.configureSource))
	mux.HandleFunc("POST /system/intelligence/sources/defensoria/import", rt.scoped(rt.importSource))
	mux.HandleFunc("POST /system/intelligence/sources/defensoria/poll", rt.scoped(rt.pollSource))
	mux.HandleFunc("POST /system/integrations/api-keys", rt.scoped(rt.issueKey))
	mux.HandleFunc("DELETE /system/integrations/api-keys/{id}", rt.scoped(rt.revokeKey))
}

type request struct {
	w      http.ResponseWriter
	r      *http.Request
	tenant string
	user   string
}

// scoped runs a handler of a session route with the resolved project's tenant and the user, or
// answers the onError 500 when the request has none (the gates always set them). The routes
// under /system/v4/media and /system/intelligence/sources carry sourceRequestLimit.
func (rt Runtime) scoped(h func(request) error) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		scope, ok := tenancyhttp.ScopeFrom(r.Context())
		principal, signed := identityhttp.PrincipalFrom(r.Context())
		if !ok || !signed {
			rt.fail(w, r, tenancyhttp.ErrNoScope)
			return
		}
		if isSourcePath(r.URL.Path) && !limited(w, r, sourceLimit) {
			return
		}
		if err := h(request{w: w, r: r, tenant: scope.TenantID(), user: principal.Username}); err != nil {
			rt.fail(w, r, err)
		}
	}
}

// fail is the TypeScript API's onError: a 500 that never carries the cause.
func (rt Runtime) fail(w http.ResponseWriter, r *http.Request, _ error) {
	if rt.Log != nil {
		rt.Log.LogAttrs(r.Context(), slog.LevelError, "integration runtime failed",
			slog.String("request_id", httpx.RequestIDFrom(r.Context())))
	}
	httpx.WriteJSONText(w, http.StatusInternalServerError, httpx.ErrorBody{Detail: "Internal Server Error"})
}

func writeRaw(w http.ResponseWriter, status int, body []byte) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_, _ = w.Write(body)
}

func detail(w http.ResponseWriter, status int, text string) {
	httpx.WriteJSONText(w, status, httpx.ErrorBody{Detail: text})
}

// jsonBody is parseJson's first half: c.req.json(), or the 422 json_invalid.
func jsonBody(w http.ResponseWriter, r *http.Request) (any, bool) {
	data, err := io.ReadAll(r.Body)
	if err == nil {
		var v any
		if v, err = records.ParseBody(data); err == nil {
			return v, true
		}
	}
	invalid(w, []domain.Issue{{Type: "json_invalid", Loc: []any{"body"}, Msg: "JSON decode error"}})
	return nil, false
}

func invalid(w http.ResponseWriter, issues []domain.Issue) {
	httpx.WriteJSONText(w, http.StatusUnprocessableEntity, httpx.ErrorBody{Detail: issues})
}

// ---- Webhooks ----

// authenticate is authenticateKey: the key, made the request's actor (`api:<name>`, with its
// clearance), or the 401/403 already written.
func (rt Runtime) authenticate(w http.ResponseWriter, r *http.Request) (*domain.Principal, *http.Request, bool) {
	header, present := httpx.Header(r, "Authorization")
	principal, err := rt.Keys.Authenticate(r.Context(), header, present)
	if err != nil {
		rt.fail(w, r, err)
		return nil, nil, false
	}
	if principal == nil {
		w.Header().Set("WWW-Authenticate", `Bearer realm="sipges"`)
		detail(w, http.StatusUnauthorized, "Clave de API no válida o revocada")
		return nil, nil, false
	}
	if principal.Access != "write" {
		detail(w, http.StatusForbidden, "La clave es de solo lectura")
		return nil, nil, false
	}
	ctx := database.WithActor(r.Context(), database.Actor{
		Name: domain.KeyActor(*principal), Clearance: database.Clearance(principal.Clearance),
	})
	return principal, r.WithContext(ctx), true
}

func (rt Runtime) answer(w http.ResponseWriter, r *http.Request, req application.IngestRequest) {
	outcome, err := rt.Ingest.Run(r.Context(), req)
	if err != nil {
		rt.fail(w, r, err)
		return
	}
	if outcome.Replayed {
		w.Header().Set("Idempotent-Replayed", "true")
	}
	writeRaw(w, outcome.Status, outcome.Body)
}

// ingest is POST /hooks/ingest/:module: a write API key creates records in its project from one
// JSON record, many, or a form.
func (rt Runtime) ingest(w http.ResponseWriter, r *http.Request) {
	if !limited(w, r, ingestLimit) {
		return
	}
	principal, r, ok := rt.authenticate(w, r)
	if !ok {
		return
	}
	header, present := httpx.Header(r, "Idempotency-Key")
	if !present {
		header, present = httpx.Header(r, "Webhook-Id")
	}
	key, bad := domain.IdempotencyKey(header, present)
	if bad {
		detail(w, http.StatusBadRequest, "Idempotency-Key no válida")
		return
	}
	contentType, _ := httpx.Header(r, "Content-Type")
	media := strings.ToLower(contentType)
	data, readErr := io.ReadAll(r.Body)
	var body any
	switch {
	case strings.HasPrefix(media, "application/x-www-form-urlencoded") || strings.HasPrefix(media, "multipart/form-data"):
		form, err := parseForm(contentType, data)
		if err != nil || readErr != nil {
			detail(w, http.StatusBadRequest, "Cuerpo no válido")
			return
		}
		body = form
	case strings.HasPrefix(media, "application/json"):
		v, err := records.ParseBody(data)
		if err != nil || readErr != nil {
			detail(w, http.StatusBadRequest, "Cuerpo no válido")
			return
		}
		body = v
	default:
		detail(w, http.StatusUnsupportedMediaType, "Usa application/json o un formulario")
		return
	}
	rt.answer(w, r, application.IngestRequest{
		Principal: *principal, ProjectID: principal.ProjectID(), Slug: httpx.PathParam(r, "module"),
		Body: body, Key: key,
	})
}

// signal is POST /hooks/signals: a structured reference to a public text becomes a narrative;
// the reference is never fetched.
func (rt Runtime) signal(w http.ResponseWriter, r *http.Request) {
	if !limited(w, r, signalLimit) {
		return
	}
	principal, r, ok := rt.authenticate(w, r)
	if !ok {
		return
	}
	data, err := io.ReadAll(r.Body)
	var body any
	if err == nil {
		if body, err = records.ParseBody(data); err != nil {
			body = nil
		}
	}
	input, valid, err := domain.ParseSignal(body)
	if errors.As(err, &domain.ErrSignalURL{}) {
		rt.fail(w, r, err)
		return
	}
	if !valid {
		detail(w, http.StatusUnprocessableEntity, "Referencia estructurada no válida")
		return
	}
	fingerprint, payload := domain.SignalNarrative(input)
	header, present := httpx.Header(r, "Idempotency-Key")
	key, bad := domain.IdempotencyKey(header, present)
	if bad {
		detail(w, http.StatusBadRequest, "Idempotency-Key no válida")
		return
	}
	if key == "" {
		key = "signal-" + fingerprint
	}
	rt.answer(w, r, application.IngestRequest{
		Principal: *principal, ProjectID: principal.ProjectID(), Slug: "narrativas", Body: payload, Key: key,
	})
}

// ---- Media feeds ----

// feedID is feedId of media-routes.ts: Number(value), an integer from 1 to 2^31-1.
func feedID(r *http.Request) (int, bool) {
	id := domain.NumberJS(httpx.PathParam(r, "id"))
	if id != math.Trunc(id) || id < 1 || id > math.MaxInt32 {
		return 0, false
	}
	return int(id), true
}

const feedNotFound = "Fuente no encontrada"

func feedInput(q request) (domain.FeedInput, bool) {
	body, ok := jsonBody(q.w, q.r)
	if !ok {
		return domain.FeedInput{}, false
	}
	in, issues := domain.ParseFeedInput(body)
	if issues != nil {
		invalid(q.w, issues)
		return domain.FeedInput{}, false
	}
	return in, true
}

func (rt Runtime) createFeed(q request) error {
	in, ok := feedInput(q)
	if !ok {
		return nil
	}
	saved, problem, err := rt.Media.Create(q.r.Context(), q.tenant, in, q.user)
	switch {
	case err != nil:
		return err
	case problem != "":
		detail(q.w, http.StatusUnprocessableEntity, problem)
	default:
		httpx.WriteJSONText(q.w, http.StatusCreated, toFeed(*saved))
	}
	return nil
}

func (rt Runtime) updateFeed(q request) error {
	id, ok := feedID(q.r)
	if !ok {
		detail(q.w, http.StatusNotFound, feedNotFound)
		return nil
	}
	in, ok := feedInput(q)
	if !ok {
		return nil
	}
	saved, problem, err := rt.Media.Update(q.r.Context(), q.tenant, id, in, q.user)
	switch {
	case err != nil:
		return err
	case problem != "":
		detail(q.w, http.StatusUnprocessableEntity, problem)
	case saved == nil:
		detail(q.w, http.StatusNotFound, feedNotFound)
	default:
		httpx.WriteJSONText(q.w, http.StatusOK, toFeed(*saved))
	}
	return nil
}

var okBody = []byte(`{"ok":true}`)

func (rt Runtime) removeFeed(q request) error {
	id, ok := feedID(q.r)
	removed := false
	if ok {
		var err error
		if removed, err = rt.Media.Remove(q.r.Context(), q.tenant, id); err != nil {
			return err
		}
	}
	if !removed {
		detail(q.w, http.StatusNotFound, feedNotFound)
		return nil
	}
	writeRaw(q.w, http.StatusOK, okBody)
	return nil
}

func (rt Runtime) previewFeed(q request) error {
	body, ok := jsonBody(q.w, q.r)
	if !ok {
		return nil
	}
	in, issues := domain.ParsePreviewInput(body)
	if issues != nil {
		invalid(q.w, issues)
		return nil
	}
	preview, problem, err := rt.Media.Preview(q.r.Context(), in.URL, in.Keywords)
	switch {
	case err != nil:
		detail(q.w, http.StatusBadGateway, domain.FeedErrorMessage(err))
	case problem != "":
		detail(q.w, http.StatusUnprocessableEntity, problem)
	default:
		httpx.WriteJSONText(q.w, http.StatusOK, preview)
	}
	return nil
}

func (rt Runtime) pollFeeds(q request) error {
	report, err := rt.Media.Poll(q.r.Context(), q.tenant, true)
	if err != nil {
		return err
	}
	httpx.WriteJSONText(q.w, http.StatusOK, report)
	return nil
}

// ---- Defensoría connector ----

func (rt Runtime) previewSource(q request) error {
	query, _ := httpx.QueryParam(q.r, "query")
	posts, err := rt.Sources.Preview(q.r.Context(), query)
	if err != nil {
		detail(q.w, http.StatusBadGateway, "La fuente oficial no está disponible o devolvió datos inválidos.")
		return nil
	}
	if posts == nil {
		posts = []domain.OfficialPost{}
	}
	httpx.WriteJSONText(q.w, http.StatusOK, posts)
	return nil
}

func (rt Runtime) configureSource(q request) error {
	body, ok := jsonBody(q.w, q.r)
	if !ok {
		return nil
	}
	in, issues := domain.ParseSourceConfig(body)
	if issues != nil {
		invalid(q.w, issues)
		return nil
	}
	if in.Enabled && in.AuthorizationNote == "" {
		detail(q.w, http.StatusBadRequest, "Se requiere una nota de autorización explícita")
		return nil
	}
	state, err := rt.Sources.Configure(q.r.Context(), q.tenant, in, q.user)
	if err != nil {
		return err
	}
	httpx.WriteJSONText(q.w, http.StatusOK, toSourceState(state))
	return nil
}

type imported struct {
	ID      string `json:"id"`
	Created bool   `json:"created"`
}

func (rt Runtime) importSource(q request) error {
	body, ok := jsonBody(q.w, q.r)
	if !ok {
		return nil
	}
	in, issues := domain.ParseSourceImport(body)
	if issues != nil {
		invalid(q.w, issues)
		return nil
	}
	id, created, err := rt.Sources.Import(q.r.Context(), q.tenant, in)
	if err != nil {
		detail(q.w, http.StatusBadGateway, "No se pudo importar la publicación oficial; no se creó una narrativa falsa.")
		return nil
	}
	status := http.StatusOK
	if created {
		status = http.StatusCreated
	}
	httpx.WriteJSONText(q.w, status, imported{ID: id, Created: created})
	return nil
}

func (rt Runtime) pollSource(q request) error {
	outcome, err := rt.Sources.Poll(q.r.Context(), q.tenant)
	if err != nil {
		detail(q.w, http.StatusBadGateway, "La consulta de la fuente falló. Consulte el estado del conector.")
		return nil
	}
	httpx.WriteJSONText(q.w, http.StatusOK, outcome)
	return nil
}

// ---- API keys ----

var keyID = regexp.MustCompile(`^\d{1,9}$`)

type issuedKey struct {
	OK    bool   `json:"ok"`
	ID    int    `json:"id"`
	Token string `json:"token"`
}

// issueKey is POST /system/integrations/api-keys: administrators only, by the role gate.
func (rt Runtime) issueKey(q request) error {
	body, ok := jsonBody(q.w, q.r)
	if !ok {
		return nil
	}
	input, issues := domain.ParseKeyInput(body)
	if issues != nil {
		invalid(q.w, issues)
		return nil
	}
	issued, err := rt.Keys.Create(q.r.Context(), q.tenant, input, q.user)
	if err != nil {
		return err
	}
	if issued.Duplicate {
		detail(q.w, http.StatusConflict, "Ya existe una clave con ese nombre")
		return nil
	}
	httpx.WriteJSONText(q.w, http.StatusOK, issuedKey{true, issued.ID, issued.Token})
	return nil
}

func (rt Runtime) revokeKey(q request) error {
	raw := httpx.PathParam(q.r, "id")
	revoked := false
	if keyID.MatchString(raw) {
		id := 0
		for _, c := range raw {
			id = id*10 + int(c-'0')
		}
		var err error
		if revoked, err = rt.Keys.Revoke(q.r.Context(), q.tenant, id); err != nil {
			return err
		}
	}
	if !revoked {
		detail(q.w, http.StatusNotFound, "Clave no encontrada")
		return nil
	}
	writeRaw(q.w, http.StatusOK, okBody)
	return nil
}

func toFeed(f domain.MediaFeed) feedJSON {
	return toMedia(application.MediaState{Feeds: []domain.MediaFeed{f}}).Feeds[0]
}

func toSourceState(s domain.SourceState) sourceStateJSON { return toCatalog(s).State }
