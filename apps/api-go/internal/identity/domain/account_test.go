package domain

import (
	"strings"
	"testing"
)

// Ported from apps/api/test/identity/account-rules.test.ts.
func TestValidateNewAccount(t *testing.T) {
	base := NewAccount{Username: "ana.perez", FullName: "Ana Pérez", Password: "twelve-chars", Role: "analista"}
	got, detail := ValidateNewAccount(NewAccount{Username: base.Username, FullName: strings.Repeat("x", 200), Password: base.Password, Role: base.Role})
	if detail != "" || got.FullName != strings.Repeat("x", 120) {
		t.Fatalf("got %+v %q", got, detail)
	}
	if got, detail = ValidateNewAccount(NewAccount{Username: base.Username, FullName: strings.Repeat("x", 119) + "😀", Password: base.Password, Role: base.Role}); detail != "" || got.FullName != strings.Repeat("x", 119)+"�" {
		t.Fatalf("a cut pair must reach PostgreSQL as U+FFFD: %q", got.FullName)
	}
	for _, username := range []string{"ab", "Ana", strings.Repeat("a", 41), "ana perez", "ana@x", "ana\n"} {
		c := base
		c.Username = username
		if _, detail := ValidateNewAccount(c); detail != "Usuario inválido" {
			t.Errorf("%q: %q", username, detail)
		}
	}
	c := base
	c.Role = "root"
	if _, detail := ValidateNewAccount(c); detail != "Rol no válido" {
		t.Errorf("role: %q", detail)
	}
	for password, want := range map[string]string{
		strings.Repeat("x", 11):  "Contraseña demasiado corta: mínimo 12 caracteres",
		strings.Repeat("😀", 11):  "Contraseña demasiado corta: mínimo 12 caracteres",
		strings.Repeat("x", 12):  "",
		strings.Repeat("😀", 256): "",
		strings.Repeat("x", 257): "Contraseña demasiado larga: máximo 256 caracteres",
	} {
		c := base
		c.Password = password
		if _, detail := ValidateNewAccount(c); detail != want {
			t.Errorf("%d code points: %q", len([]rune(password)), detail)
		}
	}
	// Username first, then role, as in TypeScript.
	if _, detail := ValidateNewAccount(NewAccount{Username: "x", Role: "root"}); detail != "Usuario inválido" {
		t.Errorf("order: %q", detail)
	}
}

func TestAdminUsername(t *testing.T) {
	for _, c := range [][2]string{{" Ana.Perez ", "ana.perez"}, {"\u212Aana", "kana"}} {
		if got, ok := AdminUsername(c[0]); !ok || got != c[1] {
			t.Errorf("%q: %q %v", c[0], got, ok)
		}
	}
	for _, raw := range []string{"", "   ", "a\x00", strings.Repeat("a", 121)} {
		if _, ok := AdminUsername(raw); ok {
			t.Errorf("%q passed", raw)
		}
	}
}

// The CHECK of users.username (migration 0001): char_length counts code points.
func TestStorableUsername(t *testing.T) {
	for _, username := range []string{"a", strings.Repeat("a", 120), strings.Repeat("😀", 120)} {
		if !StorableUsername(username) {
			t.Errorf("%d code points refused", len([]rune(username)))
		}
	}
	for _, username := range []string{"", strings.Repeat("a", 121), strings.Repeat("😀", 121)} {
		if StorableUsername(username) {
			t.Errorf("%d code points passed", len([]rune(username)))
		}
	}
}
