// Package domain holds the project scope rules of apps/api/src/contexts/tenancy/domain/scope.ts.
package domain

// Scope is a company/project pair: one tenant.
type Scope struct {
	CompanyID string
	ProjectID string
}

// TenantID is formatScope: "company/project", the tenants.tenant_id and app.tenant_id value.
func (s Scope) TenantID() string { return s.CompanyID + "/" + s.ProjectID }

// Grant is one project a user may enter (TenantSummary).
type Grant struct {
	Scope
	Label string
}

// ResolveScope is resolveScope (app.py enforce_auth step 4): the X-SIPGES-Scope header, then
// the scope cookie, then the only grant when nothing was requested. Anything not granted
// resolves to false.
func ResolveScope(header, cookie string, grants []Grant) (Scope, bool) {
	requested := header
	if requested == "" {
		requested = cookie
	}
	if requested == "" {
		if len(grants) == 1 {
			return grants[0].Scope, true
		}
		return Scope{}, false
	}
	for _, g := range grants {
		if g.TenantID() == requested {
			return g.Scope, true
		}
	}
	return Scope{}, false
}
