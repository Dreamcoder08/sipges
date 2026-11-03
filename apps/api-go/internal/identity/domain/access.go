// Package domain holds the identity rules that need no I/O: the role gates of
// apps/api/src/contexts/identity/domain/access-policy.ts and the clearance of each role.
package domain

import (
	"slices"
	"strings"
)

// Role is one of the values the users.role CHECK constraint allows.
type Role string

// The roles of the users table.
const (
	RoleAdmin       Role = "admin"
	RoleAnalyst     Role = "analista"
	RoleCoordinator Role = "coordinador"
	RoleReadOnly    Role = "consulta"
)

// Principal is the identity of a valid session (SessionIdentity in the TypeScript API).
type Principal struct {
	Username string
	FullName string
	Role     Role
	// MFAEnabled is true when TOTP is enabled or the session came from Google sign-in, which
	// stands in for the app's second factor (ADR 0010).
	MFAEnabled bool
}

// Decision is the outcome of CheckRoleAccess; Detail is the 403 message when not Allowed.
type Decision struct {
	Allowed bool
	Detail  string
}

var allow = Decision{Allowed: true}

func deny(detail string) Decision { return Decision{Detail: detail} }

var readMethods = map[string]bool{"GET": true, "HEAD": true, "OPTIONS": true}

// readOnlyPosts compute and persist nothing (ADR 0008 #3).
var readOnlyPosts = map[string]bool{
	"/system/analyze":                       true,
	"/system/document-lab/analyze":          true,
	"/system/document-lab/compare":          true,
	"/system/document-lab/report.docx":      true,
	"/system/intelligence/semantic-analyze": true,
	"/system/geography/query":               true,
	"/system/graph/neighbourhood":           true,
}

// selfServicePosts are personal account actions every role may take (ADR 0009, ADR 0014).
var selfServicePosts = map[string]bool{
	"/system/auth/totp/setup":                true,
	"/system/auth/totp/enable":               true,
	"/system/notifications/read":             true,
	"/system/notifications/push":             true,
	"/system/notifications/push/unsubscribe": true,
	"/system/notifications/push/test":        true,
}

var coordinatorWritable = []string{"/system/prevention/", "/system/intelligence/territorial-alerts"}

// CheckRoleAccess is checkRoleAccess: the role gates of app.py:241-251, in the same order.
func CheckRoleAccess(role Role, method, path string) Decision {
	isAdmin := role == RoleAdmin
	isRead := readMethods[method]
	has := func(prefix string) bool { return strings.HasPrefix(path, prefix) }

	if has("/system/auth/accounts") && !isAdmin {
		return deny("Administración de cuentas restringida")
	}
	adminOnly := has("/system/export") ||
		has("/system/audit") ||
		has("/system/metrics") ||
		has("/system/automations") ||
		has("/system/integrations") ||
		// Python gates every method except GET here (app.py:244), unlike the read set elsewhere.
		(has("/system/irsa/config") && method != "GET") ||
		(has("/system/v4/settings") && !isRead) ||
		(has("/system/v4/media") && !isRead)
	if adminOnly && !isAdmin {
		return deny("Requiere rol administrador")
	}
	if (has("/api/usuarios") || has("/api/roles")) && !isAdmin {
		return deny("Acceso administrativo requerido")
	}
	if has("/api/proyectos") && !isRead && !isAdmin {
		return deny("Solo el administrador puede gestionar proyectos")
	}
	if !isRead && !readOnlyPosts[path] && !selfServicePosts[path] {
		if role == RoleReadOnly {
			return deny("Rol de consulta: solo lectura")
		}
		if role == RoleCoordinator && !slices.ContainsFunc(coordinatorWritable, has) {
			return deny("Operación restringida para coordinador")
		}
	}
	return allow
}

// Clearance is clearanceFor: read-only accounts never see records marked 'restringido'
// (ADR 0012).
func Clearance(role Role) string {
	if role == RoleReadOnly {
		return "limited"
	}
	return "full"
}
