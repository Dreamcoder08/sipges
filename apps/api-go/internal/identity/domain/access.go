// Package domain holds the identity rules that need no I/O: roles, the role gate, the public
// and machine paths, and session token handling. Each mirrors apps/api/src/contexts/identity.
package domain

import (
	"crypto/sha256"
	"encoding/hex"
	"regexp"
	"slices"
	"strings"
)

// Role is one of admin, analista, coordinador, consulta.
type Role string

// Principal is the signed-in user a valid session resolves to.
type Principal struct {
	Username   string
	FullName   string
	Role       Role
	MFAEnabled bool
}

// Decision is the outcome of the role gate; Detail is the 403 message when not allowed.
type Decision struct {
	Allowed bool
	Detail  string
}

var allow = Decision{Allowed: true}

func deny(detail string) Decision { return Decision{Detail: detail} }

func isReadMethod(method string) bool {
	return method == "GET" || method == "HEAD" || method == "OPTIONS"
}

// readOnlyPosts compute and persist nothing (ADR 0008 #3).
var readOnlyPosts = []string{
	"/system/analyze",
	"/system/document-lab/analyze",
	"/system/document-lab/compare",
	"/system/document-lab/report.docx",
	"/system/intelligence/semantic-analyze",
	"/system/geography/query",
	"/system/graph/neighbourhood",
}

// selfServicePosts are personal account actions every role must be able to complete (ADR 0009, 0014).
var selfServicePosts = []string{
	"/system/auth/totp/setup",
	"/system/auth/totp/enable",
	"/system/notifications/read",
	"/system/notifications/push",
	"/system/notifications/push/unsubscribe",
	"/system/notifications/push/test",
}

var coordinatorWritable = []string{"/system/prevention/", "/system/intelligence/territorial-alerts"}

func hasAnyPrefix(path string, prefixes ...string) bool {
	return slices.ContainsFunc(prefixes, func(p string) bool { return strings.HasPrefix(path, p) })
}

// CheckRoleAccess is checkRoleAccess of access-policy.ts (app.py:241-251), in the same order.
func CheckRoleAccess(role Role, method, path string) Decision {
	isAdmin := role == "admin"
	isRead := isReadMethod(method)
	if strings.HasPrefix(path, "/system/auth/accounts") && !isAdmin {
		return deny("Administración de cuentas restringida")
	}
	adminOnly := hasAnyPrefix(path, "/system/export", "/system/audit", "/system/metrics",
		"/system/automations", "/system/integrations") ||
		// Python gates every method except GET here, unlike the read set used elsewhere.
		(strings.HasPrefix(path, "/system/irsa/config") && method != "GET") ||
		(strings.HasPrefix(path, "/system/v4/settings") && !isRead) ||
		(strings.HasPrefix(path, "/system/v4/media") && !isRead)
	if adminOnly && !isAdmin {
		return deny("Requiere rol administrador")
	}
	if hasAnyPrefix(path, "/api/usuarios", "/api/roles") && !isAdmin {
		return deny("Acceso administrativo requerido")
	}
	if strings.HasPrefix(path, "/api/proyectos") && !isRead && !isAdmin {
		return deny("Solo el administrador puede gestionar proyectos")
	}
	if !isRead && !slices.Contains(readOnlyPosts, path) && !slices.Contains(selfServicePosts, path) {
		if role == "consulta" {
			return deny("Rol de consulta: solo lectura")
		}
		if role == "coordinador" && !hasAnyPrefix(path, coordinatorWritable...) {
			return deny("Operación restringida para coordinador")
		}
	}
	return allow
}

// ClearanceFor returns the record clearance of a role: read-only accounts never see records
// marked restringido (ADR 0012).
func ClearanceFor(role Role) string {
	if role == "consulta" {
		return "limited"
	}
	return "full"
}

// publicPaths are reachable without a session (auth-middleware.ts PUBLIC_PATHS).
var publicPaths = []string{
	"/health", "/health/ready", "/login", "/logout", "/select-project",
	"/system/auth/me", "/system/auth/providers", "/auth/google", "/auth/google/callback",
}

// IsPublicPath reports whether path needs no session.
func IsPublicPath(path string) bool { return slices.Contains(publicPaths, path) }

// IsMachinePath reports the endpoints that carry their own bearer credential (ADR 0014 §4, §6).
func IsMachinePath(path string) bool {
	return path == "/system/automations/cron" || path == "/mcp" || strings.HasPrefix(path, "/hooks/")
}

// IsMFAEnrollmentPath reports the only routes a session without a second factor may use (ADR 0009).
func IsMFAEnrollmentPath(path string) bool {
	return path == "/system/auth/totp/setup" || path == "/system/auth/totp/enable"
}

// MFARequiredDetail is the 403 message for a session that must enroll TOTP first.
const MFARequiredDetail = "Active la verificación en dos pasos (MFA) con /system/auth/totp/setup antes de continuar"

var sessionToken = regexp.MustCompile(`^[0-9a-f]{64}$`)

// ValidSessionToken reports whether token has the issued form: 64 lowercase hex characters.
func ValidSessionToken(token string) bool { return sessionToken.MatchString(token) }

// HashSessionToken is what sessions.token_hash stores: the hex SHA-256 of the token.
func HashSessionToken(token string) string {
	sum := sha256.Sum256([]byte(token))
	return hex.EncodeToString(sum[:])
}
