package app

import (
	"errors"
	"net/http"
	"os"

	analyst "github.com/Dreamcoder08/sipges/apps/api-go/internal/analyst/application"
	analysthttp "github.com/Dreamcoder08/sipges/apps/api-go/internal/analyst/http"
	analystsql "github.com/Dreamcoder08/sipges/apps/api-go/internal/analyst/infrastructure"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/platform/config"
)

func init() {
	registerContext("analyst", func(d Deps) (func(*http.ServeMux), error) {
		assisted, err := assistedBriefing(d)
		if err != nil {
			return nil, err
		}
		options := analysthttp.Options{DB: d.Pool, Now: d.Now, Logger: d.Logger, Assisted: assisted}
		return func(mux *http.ServeMux) { analysthttp.Routes(mux, options) }, nil
	})
}

// assistedBriefing is the narrator; nil unless SIPGES_ANALYST_PROVIDER configures one. Without
// SIPGES_DATA_KEY there is no guard, so the narrator gets nothing.
func assistedBriefing(d Deps) (*analyst.Assisted, error) {
	settings, err := config.LoadAnalyst(os.LookupEnv)
	if err != nil || !settings.Enabled {
		return nil, err
	}
	assisted := &analyst.Assisted{Narrator: analystsql.NewClaude(settings.Model, os.LookupEnv), Logger: d.Logger}
	guard, err := egressGuard(d)
	switch {
	case err == nil:
		assisted.Egress = guard
	case !errors.Is(err, config.ErrNoDataKey):
		return nil, err
	}
	return assisted, nil
}
