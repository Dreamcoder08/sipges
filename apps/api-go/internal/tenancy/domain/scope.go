// Package domain holds the tenancy rules that need no I/O, mirroring
// apps/api/src/contexts/tenancy/domain/scope.ts and the checks of tenancy-middleware.ts.
package domain

import (
	"encoding/json"
)

// Scope is the company and project a request works in.
type Scope struct {
	CompanyID string
	ProjectID string
}

// String is the "COMPANY/PROJECT" form of the X-SIPGES-Scope header and the scope cookie.
func (s Scope) String() string { return s.CompanyID + "/" + s.ProjectID }

// ResolveScope is resolveScope of scope.ts: the header, or when empty the cookie, must name a
// grant exactly; with nothing requested, a user with exactly one grant gets it.
func ResolveScope(header, cookie string, grants []Scope) *Scope {
	requested := header
	if requested == "" {
		requested = cookie
	}
	if requested == "" {
		if len(grants) == 1 {
			return &grants[0]
		}
		return nil
	}
	for i := range grants {
		if grants[i].String() == requested {
			return &grants[i]
		}
	}
	return nil
}

// truthy is JavaScript truthiness of a decoded JSON value.
func truthy(v any) bool {
	switch x := v.(type) {
	case nil:
		return false
	case bool:
		return x
	case float64:
		return x != 0
	case string:
		return x != ""
	default:
		return true // objects and arrays
	}
}

// BodyNamesOtherProject is the JSON-body check of tenancy-middleware.ts: the first truthy of
// body.project_id, body.payload.Proyecto_ID, body.payload.project_id, compared with !== against
// projectID (so only the identical string matches). A body that is not a JSON object names none.
func BodyNamesOtherProject(body []byte, projectID string) bool {
	var record map[string]any
	if json.Unmarshal(body, &record) != nil || record == nil {
		return false
	}
	payload, _ := record["payload"].(map[string]any)
	var supplied any
	switch {
	case truthy(record["project_id"]):
		supplied = record["project_id"]
	case truthy(payload["Proyecto_ID"]):
		supplied = payload["Proyecto_ID"]
	case truthy(payload["project_id"]):
		supplied = payload["project_id"]
	default:
		return false
	}
	text, isString := supplied.(string)
	return !isString || text != projectID
}
