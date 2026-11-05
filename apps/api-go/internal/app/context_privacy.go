package app

import (
	"context"
	"errors"
	"net/http"
	"os"

	"github.com/Dreamcoder08/sipges/apps/api-go/internal/platform/config"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/platform/database"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/privacy/application"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/privacy/infrastructure"
	situationsdomain "github.com/Dreamcoder08/sipges/apps/api-go/internal/situations/domain"
	situationssql "github.com/Dreamcoder08/sipges/apps/api-go/internal/situations/infrastructure"
)

func init() {
	// The privacy context has no routes, in TypeScript either: it is the guard in front of every
	// path that sends tenant data out. SIPGES_DATA_KEY stays optional until such a path runs here,
	// but a malformed key stops the start, as it does in apps/api.
	registerContext("privacy", func(d Deps) (func(*http.ServeMux), error) {
		if _, err := egressGuard(d); err != nil && !errors.Is(err, config.ErrNoDataKey) {
			return nil, err
		}
		return func(*http.ServeMux) {}, nil
	})
}

// egressGuard builds the guard for a context that sends tenant data to an external model or
// client (compose.ts); the error is config.ErrNoDataKey when SIPGES_DATA_KEY is missing.
func egressGuard(d Deps) (*application.Guard, error) {
	dataKey, err := config.DataKey(os.LookupEnv)
	if err != nil {
		return nil, err
	}
	return application.NewGuard(application.Deps{
		Switch: externalAISwitch{d.Pool},
		Names:  infrastructure.NameDirectory{DB: d.Pool},
		Keys:   infrastructure.NewKeys(dataKey),
		Log:    infrastructure.EgressLog{DB: d.Pool},
		Now:    d.Now,
		Logger: d.Logger,
	}), nil
}

// externalAISwitch is situations.externalAiEnabled: the saved setting with its defaults.
type externalAISwitch struct {
	db database.Beginner
}

func (s externalAISwitch) Enabled(ctx context.Context, tenantID string) (bool, error) {
	stored, err := database.WithTenant(ctx, s.db, tenantID, func(ctx context.Context, q database.Querier) (*situationsdomain.Stored, error) {
		return situationssql.Store{}.Settings(ctx, q, tenantID)
	})
	if err != nil {
		return false, err
	}
	return situationsdomain.WithDefaults(stored).ExternalAIEnabled, nil
}
