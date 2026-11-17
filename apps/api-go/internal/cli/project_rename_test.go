package cli

import (
	"io"
	"net/http"
	"testing"
)

// project rename is PATCH /system/auth/scopes with the body as given; the API's refusals keep
// their exit codes, and project create still reaches POST.
func TestProjectRenamePatchesTheScopes(t *testing.T) {
	var method, path, seen string
	status, answer := http.StatusOK, `{"ok":true,"scope":"SIPGES/PRJ-SECHURA","label":"Proyecto Sechura"}`
	h := newHarness(t, func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		method, path, seen = r.Method, r.URL.Path, string(body)
		jsonAnswer(w, status, answer)
	})
	body := `{"company_id":"SIPGES","project_id":"PRJ-SECHURA","label":"Proyecto Sechura"}`
	got := h.run(body, "project", "rename", "--body", "-", "--json")
	if got.code != ExitOK || method != http.MethodPatch || path != "/system/auth/scopes" || seen != body {
		t.Fatalf("%+v %s %s %q", got, method, path, seen)
	}
	if data, _ := decode(t, got.stdout)["data"].(map[string]any); data["label"] != "Proyecto Sechura" {
		t.Fatalf("stdout %s", got.stdout)
	}

	for _, c := range []struct {
		status int
		want   int
	}{{http.StatusNotFound, ExitNotFound}, {http.StatusUnprocessableEntity, ExitRejected}, {http.StatusForbidden, ExitForbidden}} {
		status, answer = c.status, `{"detail":"refused"}`
		if got := h.run(body, "project", "rename", "--body", "-"); got.code != c.want {
			t.Fatalf("status %d: exit %d, want %d", c.status, got.code, c.want)
		}
	}

	status, answer = http.StatusOK, `{"ok":true,"scope":"ACME/NORTE"}`
	if got := h.run(`{}`, "project", "create", "--body", "-"); got.code != ExitOK || method != http.MethodPost || path != "/system/auth/scopes" {
		t.Fatalf("project create: %+v %s %s", got, method, path)
	}
}
