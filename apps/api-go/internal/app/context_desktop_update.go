package app

import (
	"net/http"
	"os"

	"github.com/Dreamcoder08/sipges/apps/api-go/internal/platform/config"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/platform/httpx"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/system/application"
	systemhttp "github.com/Dreamcoder08/sipges/apps/api-go/internal/system/http"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/system/infrastructure"
)

// The update notice of a managed desktop install (desktop-update-routes.ts). Managed desktop
// installs only, as in apps/api/src/app.ts: without SIPGES_DESKTOP_UPDATE_DIR (the cloud and
// development builds) neither the routes nor their admin gate exist, and a relative folder stops
// the start.
func init() {
	registerContext("desktop_update", func(d Deps) (func(*http.ServeMux), error) {
		dir, err := config.DesktopUpdateDir(os.LookupEnv)
		if err != nil || dir == "" {
			return func(*http.ServeMux) {}, err
		}
		updates := application.NewDesktopUpdates(infrastructure.NewFileDesktopUpdateChannel(dir, d.Now))
		return func(mux *http.ServeMux) { systemhttp.Routes(mux, updates, d.Logger) }, nil
	})
	registerMiddleware("desktop_update", func(Deps) (httpx.Middleware, error) {
		dir, err := config.DesktopUpdateDir(os.LookupEnv)
		if err != nil || dir == "" {
			return func(next http.Handler) http.Handler { return next }, err
		}
		return systemhttp.AdminOnly(), nil
	})
}
