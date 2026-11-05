package http

import (
	"io"
	"log/slog"
	"net/http"

	"github.com/Dreamcoder08/sipges/apps/api-go/internal/automation/application"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/platform/httpx"
)

type pushConfig struct {
	Enabled   bool    `json:"enabled"`
	PublicKey *string `json:"public_key"`
}

// PushRoutes registers the routes of one's own device notifications. Everyone with a session
// may use them, `consulta` included (SELF_SERVICE_POSTS). Logs name the request only: a body
// holds an endpoint and keys.
func PushRoutes(mux *http.ServeMux, opts WriteOptions) {
	fail := func(w http.ResponseWriter, r *http.Request) {
		if opts.Logger != nil {
			opts.Logger.LogAttrs(r.Context(), slog.LevelError, "automation write failed",
				slog.String("request_id", httpx.RequestIDFrom(r.Context())))
		}
		httpx.WriteError(w, http.StatusInternalServerError, "Internal Server Error")
	}
	// user reads the session's person; the gates set it for these paths.
	user := func(w http.ResponseWriter, r *http.Request) (string, bool) {
		name, ok := username(r)
		if !ok {
			fail(w, r)
		}
		return name, ok
	}
	body := func(r *http.Request) []byte {
		b, err := io.ReadAll(r.Body)
		if err != nil {
			return nil // like Hono: an unreadable body fails JSON.parse
		}
		return b
	}

	mux.HandleFunc("GET /system/notifications/push", func(w http.ResponseWriter, _ *http.Request) {
		out := pushConfig{}
		if key, ok := opts.Service.PushKey(); ok {
			out = pushConfig{Enabled: true, PublicKey: &key}
		}
		httpx.WriteJSONText(w, http.StatusOK, out)
	})
	mux.HandleFunc("GET /system/notifications/push/state", func(w http.ResponseWriter, r *http.Request) {
		name, ok := user(w, r)
		if !ok {
			return
		}
		state, err := opts.Service.PushState(r.Context(), name)
		if err != nil {
			fail(w, r)
			return
		}
		httpx.WriteJSONText(w, http.StatusOK, state)
	})
	mux.HandleFunc("POST /system/notifications/push/test", func(w http.ResponseWriter, r *http.Request) {
		name, ok := user(w, r)
		tenant, scoped := tenantOf(r)
		if !ok {
			return
		}
		if !scoped {
			fail(w, r)
			return
		}
		// A client that leaves does not undo sends already made, so they still get audited.
		ctx, cancel := detached(r.Context())
		defer cancel()
		result, err := opts.Service.TestPush(ctx, name, tenant)
		if err != nil {
			fail(w, r)
			return
		}
		status := http.StatusOK
		if result.Status == "failed" {
			status = http.StatusBadGateway
		}
		httpx.WriteJSONText(w, status, result)
	})
	mux.HandleFunc("POST /system/notifications/push", func(w http.ResponseWriter, r *http.Request) {
		in, issues := parse(body(r), pushSubscriptionIn)
		if issues != nil {
			writeIssues(w, issues)
			return
		}
		name, ok := user(w, r)
		if !ok {
			return
		}
		refused, err := opts.Service.SubscribePush(r.Context(), name, application.PushSubscription{
			Endpoint: in.Endpoint, P256dh: in.P256dh, Auth: in.Auth,
		})
		switch {
		case err != nil:
			fail(w, r)
		case refused == application.SubscribeDisabled:
			writeDetail(w, http.StatusConflict, "Las notificaciones en dispositivos no están configuradas")
		case refused != "":
			writeDetail(w, http.StatusUnprocessableEntity, "Suscripción de notificaciones no válida")
		default:
			httpx.WriteJSONText(w, http.StatusOK, okOnly{OK: true})
		}
	})
	mux.HandleFunc("POST /system/notifications/push/unsubscribe", func(w http.ResponseWriter, r *http.Request) {
		endpoint, issues := parse(body(r), pushUnsubscribeIn)
		if issues != nil {
			writeIssues(w, issues)
			return
		}
		name, ok := user(w, r)
		if !ok {
			return
		}
		if err := opts.Service.UnsubscribePush(r.Context(), name, endpoint); err != nil {
			fail(w, r)
			return
		}
		httpx.WriteJSONText(w, http.StatusOK, okOnly{OK: true})
	})
}
