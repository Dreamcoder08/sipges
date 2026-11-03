package app

import (
	"fmt"
	"log/slog"
	"net/http"
	"sort"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/Dreamcoder08/sipges/apps/api-go/internal/platform/engines"
)

// Deps is what the composition root hands every bounded context.
type Deps struct {
	Pool   *pgxpool.Pool
	Logger *slog.Logger
	// Now is the clock; nil means time.Now.
	Now func() time.Time
	// Engines are the compiled Rust engines (indicators, analytics).
	Engines *engines.Set
}

// prepareRoutes builds a context's services and returns the function that mounts its routes.
// It fails when the context cannot start (for example, embedded data that breaks its contract).
type prepareRoutes func(deps Deps) (func(mux *http.ServeMux), error)

// contexts holds every ported context. Each one registers itself from its own file,
// context_<name>.go, so ports built in parallel never edit the same lines (one file per entry
// instead of a shared list).
var contexts = map[string]prepareRoutes{}

// registerContext is called from the init function of a context_<name>.go file.
func registerContext(name string, prepare prepareRoutes) {
	if _, ok := contexts[name]; ok {
		panic("app: context registered twice: " + name)
	}
	contexts[name] = prepare
}

// contextNames lists the registered contexts in a fixed order, so routes mount the same way on
// every start.
func contextNames() []string {
	names := make([]string, 0, len(contexts))
	for name := range contexts {
		names = append(names, name)
	}
	sort.Strings(names)
	return names
}

// contextRoutes prepares every registered context, in name order.
func contextRoutes(deps Deps) ([]func(*http.ServeMux), error) {
	routes := make([]func(*http.ServeMux), 0, len(contexts))
	for _, name := range contextNames() {
		mount, err := contexts[name](deps)
		if err != nil {
			return nil, fmt.Errorf("%s: %w", name, err)
		}
		routes = append(routes, mount)
	}
	return routes, nil
}
