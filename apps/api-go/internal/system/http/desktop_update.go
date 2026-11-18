// Package http serves apps/api/src/contexts/system/http/desktop-update-routes.ts: the update
// notice of a managed desktop install. Nothing is downloaded or installed until POST, which only
// asks the launcher for the release it verified. The session, Origin, project scope and shared
// role gate ran before (internal/app).
package http

import (
	"log/slog"
	"net/http"
	"strings"

	identitydomain "github.com/Dreamcoder08/sipges/apps/api-go/internal/identity/domain"
	identityhttp "github.com/Dreamcoder08/sipges/apps/api-go/internal/identity/http"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/platform/httpx"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/system/application"
)

// DesktopUpdatePath is DESKTOP_UPDATE_PATH.
const DesktopUpdatePath = "/system/desktop/update"

// AdminOnly is the context's adminOnly, mounted on the path and everything under it
// (.use(PATH) and .use(`${PATH}/*`)): any method there, served or not, answers 403 to a role
// other than admin.
func AdminOnly() httpx.Middleware {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			path := httpx.HonoPath(r)
			if path != DesktopUpdatePath && !strings.HasPrefix(path, DesktopUpdatePath+"/") {
				next.ServeHTTP(w, r)
				return
			}
			if p, ok := identityhttp.PrincipalFrom(r.Context()); !ok || p.Role != identitydomain.RoleAdmin {
				httpx.WriteJSONText(w, http.StatusForbidden, httpx.ErrorBody{Detail: "Requiere rol administrador"})
				return
			}
			next.ServeHTTP(w, r)
		})
	}
}

// Routes registers GET and POST /system/desktop/update and POST /system/desktop/update/dismiss.
func Routes(mux *http.ServeMux, updates *application.DesktopUpdates, logger *slog.Logger) {
	if logger == nil {
		logger = slog.Default()
	}
	fail := func(w http.ResponseWriter, r *http.Request, err error) {
		logger.Error("unhandled_error", "method", r.Method, "path", r.URL.Path, "error", err.Error())
		httpx.WriteJSONText(w, http.StatusInternalServerError, httpx.ErrorBody{Detail: "Internal Server Error"})
	}
	mux.HandleFunc("GET "+DesktopUpdatePath, func(w http.ResponseWriter, r *http.Request) {
		status, err := updates.Status(r.Context())
		if err != nil {
			fail(w, r, err)
			return
		}
		w.Header().Set("Cache-Control", "no-store")
		httpx.WriteJSONText(w, http.StatusOK, status)
	})
	mux.HandleFunc("POST "+DesktopUpdatePath, func(w http.ResponseWriter, r *http.Request) {
		// The body is never read: the client cannot choose the version.
		version, ok, err := updates.Start(r.Context())
		switch {
		case err != nil:
			fail(w, r, err)
		case !ok:
			httpx.WriteJSONText(w, http.StatusConflict, httpx.ErrorBody{Detail: "No hay una actualización disponible"})
		default:
			httpx.WriteJSONText(w, http.StatusAccepted, struct {
				Status  string `json:"status"`
				Version string `json:"version"`
			}{"restarting", version})
		}
	})
	mux.HandleFunc("POST "+DesktopUpdatePath+"/dismiss", func(w http.ResponseWriter, _ *http.Request) {
		updates.Dismiss()
		w.WriteHeader(http.StatusNoContent)
	})
}
