// Package domain holds the tenancy rules that need no I/O, mirroring
// apps/api/src/contexts/tenancy/domain/scope.ts and the checks of tenancy-middleware.ts.
package domain

import (
	"bytes"
	"encoding/json"
	"strconv"
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
	case json.Number:
		// JavaScript numbers: 1e400 is Infinity (truthy), 1e-400 and -0 are 0 (falsy).
		f, _ := strconv.ParseFloat(x.String(), 64)
		return f != 0
	case string:
		return x != ""
	default:
		return true // objects and arrays
	}
}

// BodyNamesOtherProject is the JSON-body check of tenancy-middleware.ts: the first truthy of
// body.project_id, body.payload.Proyecto_ID, body.payload.project_id, compared with !== against
// projectID (so only the identical string matches). It reads the body as Hono's c.req.json()
// does (a leading UTF-8 BOM dropped, any number accepted); a body JSON.parse would refuse, or
// that is not an object, names none, as TypeScript reads it as {}.
func BodyNamesOtherProject(body []byte, projectID string) bool {
	decoder := json.NewDecoder(bytes.NewReader(bytes.TrimPrefix(body, []byte("\xef\xbb\xbf"))))
	decoder.UseNumber()
	var record map[string]any
	if decoder.Decode(&record) != nil || record == nil {
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
