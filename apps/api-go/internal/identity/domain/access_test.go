package domain_test

import (
	"testing"

	"github.com/Dreamcoder08/sipges/apps/api-go/internal/identity/domain"
)

// Ported case by case from apps/api/test/identity/access-policy.test.ts (app.py:241-251, ADR 0008 #3).
func TestCheckRoleAccess(t *testing.T) {
	t.Parallel()
	allowed := domain.Decision{Allowed: true}
	denied := func(detail string) domain.Decision { return domain.Decision{Detail: detail} }
	cases := []struct {
		role         domain.Role
		method, path string
		want         domain.Decision
	}{
		{"analista", "GET", "/system/auth/accounts", denied("Administración de cuentas restringida")},
		{"admin", "POST", "/system/auth/accounts", allowed},
		{"analista", "GET", "/system/export", denied("Requiere rol administrador")},
		{"analista", "GET", "/system/audit", denied("Requiere rol administrador")},
		{"analista", "POST", "/system/irsa/config", denied("Requiere rol administrador")},
		{"analista", "GET", "/system/irsa/config", allowed},
		{"analista", "GET", "/api/usuarios", denied("Acceso administrativo requerido")},
		{"coordinador", "GET", "/api/roles", denied("Acceso administrativo requerido")},
		{"analista", "POST", "/api/proyectos", denied("Solo el administrador puede gestionar proyectos")},
		{"analista", "GET", "/api/proyectos", allowed},
		{"consulta", "POST", "/api/eventos", denied("Rol de consulta: solo lectura")},
		{"consulta", "GET", "/api/eventos", allowed},
		{"coordinador", "POST", "/api/eventos", denied("Operación restringida para coordinador")},
		{"coordinador", "POST", "/system/prevention/actions", allowed},
		{"coordinador", "PATCH", "/system/intelligence/territorial-alerts/7", allowed},
		{"analista", "POST", "/system/auth/totp/setup", allowed},
		{"consulta", "POST", "/system/auth/totp/setup", allowed},
		{"consulta", "POST", "/system/auth/totp/enable", allowed},
		{"coordinador", "POST", "/system/auth/totp/setup", allowed},
		// Rules the TypeScript table does not list, from access-policy.ts.
		{"analista", "GET", "/system/metrics", denied("Requiere rol administrador")},
		{"analista", "GET", "/system/automations", denied("Requiere rol administrador")},
		{"analista", "GET", "/system/integrations/feeds", denied("Requiere rol administrador")},
		{"analista", "HEAD", "/system/irsa/config", denied("Requiere rol administrador")},
		{"analista", "GET", "/system/v4/settings", allowed},
		{"analista", "PUT", "/system/v4/settings", denied("Requiere rol administrador")},
		{"analista", "POST", "/system/v4/media/sources", denied("Requiere rol administrador")},
		{"consulta", "OPTIONS", "/api/eventos", allowed},
		{"consulta", "POST", "/system/notifications/read", allowed},
		{"consulta", "POST", "/system/geography/query", allowed},
		{"analista", "DELETE", "/api/eventos/1", allowed},
	}
	for _, c := range cases {
		if got := domain.CheckRoleAccess(c.role, c.method, c.path); got != c.want {
			t.Errorf("%s %s %s = %+v, want %+v", c.role, c.method, c.path, got, c.want)
		}
	}
	for _, path := range []string{
		"/system/analyze", "/system/document-lab/analyze", "/system/document-lab/compare",
		"/system/document-lab/report.docx", "/system/intelligence/semantic-analyze",
	} {
		for _, role := range []domain.Role{"consulta", "coordinador"} {
			if got := domain.CheckRoleAccess(role, "POST", path); got != allowed {
				t.Errorf("read-only POST %s for %s = %+v", path, role, got)
			}
		}
	}
}

func TestClearanceFor(t *testing.T) {
	t.Parallel()
	for role, want := range map[domain.Role]string{"consulta": "limited", "admin": "full", "analista": "full", "coordinador": "full"} {
		if got := domain.ClearanceFor(role); got != want {
			t.Errorf("ClearanceFor(%s) = %s, want %s", role, got, want)
		}
	}
}

func TestPaths(t *testing.T) {
	t.Parallel()
	for _, p := range []string{"/health", "/health/ready", "/login", "/logout", "/select-project", "/system/auth/me", "/system/auth/providers", "/auth/google", "/auth/google/callback"} {
		if !domain.IsPublicPath(p) {
			t.Errorf("%s should be public", p)
		}
	}
	for _, p := range []string{"/system/auth/me/", "/system/auth/accounts", "/health/x"} {
		if domain.IsPublicPath(p) {
			t.Errorf("%s should not be public", p)
		}
	}
	for p, want := range map[string]bool{"/system/automations/cron": true, "/mcp": true, "/hooks/feed": true, "/hooks": false, "/mcp/x": false} {
		if got := domain.IsMachinePath(p); got != want {
			t.Errorf("IsMachinePath(%s) = %v", p, got)
		}
	}
	if !domain.IsMFAEnrollmentPath("/system/auth/totp/setup") || domain.IsMFAEnrollmentPath("/system/auth/me") {
		t.Error("MFA enrollment paths")
	}
}

func TestValidSessionToken(t *testing.T) {
	t.Parallel()
	ok := "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
	for token, want := range map[string]bool{ok: true, "": false, ok[:63]: false, ok + "0": false, "0123456789ABCDEF0123456789abcdef0123456789abcdef0123456789abcdef": false} {
		if got := domain.ValidSessionToken(token); got != want {
			t.Errorf("ValidSessionToken(%q) = %v", token, got)
		}
	}
	// sha256("abc"), as Node's createHash('sha256').digest('hex').
	if got := domain.HashSessionToken("abc"); got != "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad" {
		t.Errorf("HashSessionToken = %s", got)
	}
}
