package domain_test

import (
	"testing"

	"github.com/Dreamcoder08/sipges/apps/api-go/internal/identity/domain"
)

// Ported from apps/api/test/identity/access-policy.test.ts and hardening.test.ts (role gate
// parity with app.py:244, verifier finding A1).
func TestCheckRoleAccess(t *testing.T) {
	denied := func(detail string) domain.Decision { return domain.Decision{Detail: detail} }
	allowed := domain.Decision{Allowed: true}
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
		// Ending one's own sessions is personal account security too (Cuenta).
		{"consulta", "POST", "/system/auth/sessions/revoke-others", allowed},
		{"coordinador", "POST", "/system/auth/sessions/revoke-others", allowed},
		{"consulta", "DELETE", "/system/auth/sessions/0123456789abcdef0123456789abcdef", allowed},
		{"coordinador", "DELETE", "/system/auth/sessions/0123456789abcdef0123456789abcdef", allowed},
		{"consulta", "DELETE", "/system/auth/sessions/x/y", denied("Rol de consulta: solo lectura")},
		{"consulta", "DELETE", "/system/auth/sessions", denied("Rol de consulta: solo lectura")},
		{"consulta", "POST", "/system/auth/sessions/abc", denied("Rol de consulta: solo lectura")},
		{"analista", "PATCH", "/system/v4/settings", denied("Requiere rol administrador")},
		{"analista", "GET", "/system/v4/media/sources", allowed},
		{"consulta", "POST", "/system/notifications/push/test", allowed},
	}
	for _, method := range []string{"HEAD", "OPTIONS", "POST", "PUT"} {
		cases = append(cases,
			struct {
				role         domain.Role
				method, path string
				want         domain.Decision
			}{"analista", method, "/system/irsa/config", denied("Requiere rol administrador")},
			struct {
				role         domain.Role
				method, path string
				want         domain.Decision
			}{"admin", method, "/system/irsa/config", allowed})
	}
	for _, path := range []string{
		"/system/analyze", "/system/document-lab/analyze", "/system/document-lab/compare",
		"/system/document-lab/report.docx", "/system/intelligence/semantic-analyze",
	} {
		for _, role := range []domain.Role{"consulta", "coordinador"} {
			cases = append(cases, struct {
				role         domain.Role
				method, path string
				want         domain.Decision
			}{role, "POST", path, allowed})
		}
	}
	for _, c := range cases {
		if got := domain.CheckRoleAccess(c.role, c.method, c.path); got != c.want {
			t.Errorf("%s %s %s = %+v, want %+v", c.role, c.method, c.path, got, c.want)
		}
	}
}

func TestClearance(t *testing.T) {
	for role, want := range map[domain.Role]string{"admin": "full", "analista": "full", "coordinador": "full", "consulta": "limited"} {
		if got := domain.Clearance(role); got != want {
			t.Errorf("%s: %s, want %s", role, got, want)
		}
	}
}
