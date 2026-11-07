package cli

import (
	_ "embed" // the inventory
	"encoding/json"
	"fmt"
	"regexp"
	"strings"
)

// Access says how a route is reached.
const (
	AccessPublic  = "public"  // no session needed
	AccessSession = "session" // a signed-in person
	AccessMachine = "machine" // its own bearer credential, never the session cookie
)

// Route is one entry of the inventory. Command is the typed command, or empty when only the
// generic call reaches it; the generic call reaches every route.
type Route struct {
	Method  string `json:"method"`
	Path    string `json:"path"`
	Access  string `json:"access"`
	Command string `json:"command,omitempty"`
	Summary string `json:"summary,omitempty"`
}

// Key is the route as ServeMux writes it.
func (r Route) Key() string { return r.Method + " " + r.Path }

// params lists the {names} of the path, in order.
func (r Route) params() []string {
	var names []string
	for _, part := range paramPattern.FindAllStringSubmatch(r.Path, -1) {
		names = append(names, part[1])
	}
	return names
}

var paramPattern = regexp.MustCompile(`\{([a-z]+)\}`)

//go:embed routes.json
var inventoryJSON []byte

// Routes is the inventory: every route the API serves. A test holds it equal to the real mux.
func Routes() ([]Route, error) {
	var routes []Route
	if err := json.Unmarshal(inventoryJSON, &routes); err != nil {
		return nil, fmt.Errorf("routes.json: %w", err)
	}
	return routes, nil
}

// findRoute matches a method and a path, concrete or still holding {names}. A literal segment
// wins over a parameter, as it does in ServeMux: /api/dashboard is not /api/{module}.
func findRoute(routes []Route, method, path string) (Route, bool) {
	wanted := strings.Split(path, "/")
	best, bestLiterals, found := Route{}, -1, false
	for _, route := range routes {
		if route.Method != method {
			continue
		}
		segments := strings.Split(route.Path, "/")
		if len(segments) != len(wanted) {
			continue
		}
		literals, matches := 0, true
		for i, segment := range segments {
			switch {
			case strings.HasPrefix(segment, "{"):
				matches = matches && wanted[i] != ""
			case segment == wanted[i]:
				literals++
			default:
				matches = false
			}
		}
		if matches && literals > bestLiterals {
			best, bestLiterals, found = route, literals, true
		}
	}
	return best, found
}
