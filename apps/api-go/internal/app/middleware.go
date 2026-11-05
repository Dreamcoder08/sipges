package app

import (
	"fmt"
	"sort"

	"github.com/Dreamcoder08/sipges/apps/api-go/internal/platform/httpx"
)

// prepareMiddleware builds a context's middleware: it wraps every route, after the identity and
// tenancy gates, as a context's app.use('*', …) after roleGate does in apps/api/src/app.ts (the
// automation wakeup). A context registers it from its own context_<name>.go, next to its routes.
type prepareMiddleware func(deps Deps) (httpx.Middleware, error)

var middlewares = map[string]prepareMiddleware{}

// registerMiddleware is called from the init function of a context_<name>.go file.
func registerMiddleware(name string, prepare prepareMiddleware) {
	if _, ok := middlewares[name]; ok {
		panic("app: middleware registered twice: " + name)
	}
	middlewares[name] = prepare
}

// contextMiddleware prepares every registered middleware, in name order (the first runs first).
func contextMiddleware(deps Deps) ([]httpx.Middleware, error) {
	names := make([]string, 0, len(middlewares))
	for name := range middlewares {
		names = append(names, name)
	}
	sort.Strings(names)
	out := make([]httpx.Middleware, 0, len(names))
	for _, name := range names {
		m, err := middlewares[name](deps)
		if err != nil {
			return nil, fmt.Errorf("%s middleware: %w", name, err)
		}
		out = append(out, m)
	}
	return out, nil
}
