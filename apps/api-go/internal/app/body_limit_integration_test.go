package app_test

import (
	"io"
	"net/http"
	"strings"
	"testing"
)

// maxBody mirrors app.maxRequestBody: TypeScript has no global limit, so this one is SIPGES Go's.
const maxBody = 16 << 20

const bodyTooLarge = `{"detail":"Cuerpo demasiado grande"}`

// sendBody posts a body with a declared Content-Length, or chunked when chunked is set.
func (s *server) sendBody(t *testing.T, path, user, contentType, body string, chunked bool, headers ...string) reply {
	t.Helper()
	var payload io.Reader = strings.NewReader(body)
	if chunked {
		payload = struct{ io.Reader }{payload} // hides the length from the client
	}
	r, err := http.NewRequestWithContext(t.Context(), http.MethodPost, s.url+path, payload)
	if err != nil {
		t.Fatal(err)
	}
	r.Header.Set("Origin", s.url)
	r.Header.Set("Content-Type", contentType)
	if user != "" {
		r.Header.Set("Cookie", "sipges_session="+tokens[user])
	}
	for i := 0; i+1 < len(headers); i += 2 {
		r.Header.Set(headers[i], headers[i+1])
	}
	res, err := http.DefaultClient.Do(r)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = res.Body.Close() }()
	got, _ := io.ReadAll(res.Body)
	return reply{res.StatusCode, string(got)}
}

func TestRefusesOversizeBodiesOnRoutesWithoutALimitOfTheirOwn(t *testing.T) {
	s := start(t, false)
	over := `{"project_id":"NORTE","x":"` + strings.Repeat("x", maxBody) + `"}`
	for _, path := range []string{"/system/import/hechos", "/system/irsa/config", "/system/graph/neighbourhood"} {
		for name, chunked := range map[string]bool{"declared": false, "chunked": true} {
			t.Run(path+" "+name, func(t *testing.T) {
				// 413 and not the scope's 403: the body is refused before the project check reads it.
				expect(t, s.sendBody(t, path, "solo", "application/json", over, chunked), http.StatusRequestEntityTooLarge, bodyTooLarge)
			})
		}
	}
	t.Run("a body of exactly the limit reaches the route", func(t *testing.T) {
		exact := `{"x":"` + strings.Repeat("x", maxBody-len(`{"x":""}`)) + `"}`
		for name, chunked := range map[string]bool{"declared": false, "chunked": true} {
			if got := s.sendBody(t, "/system/nothing-here", "solo", "application/json", exact, chunked); got.status != http.StatusNotFound {
				t.Fatalf("%s: status %d: %.200s", name, got.status, got.body)
			}
		}
	})
	t.Run("the session gate still answers first", func(t *testing.T) {
		if got := s.sendBody(t, "/system/import/hechos", "", "application/json", over, false); got.status != http.StatusUnauthorized {
			t.Fatalf("status %d: %.200s", got.status, got.body)
		}
	})
	t.Run("a smaller route limit keeps its own answer", func(t *testing.T) {
		expect(t, s.sendBody(t, "/system/geography/query", "solo", "application/json", over, false),
			http.StatusRequestEntityTooLarge, `{"detail":"Consulta demasiado extensa"}`)
	})
}

// Routes that bound the body themselves keep their limit and their answer past the global one.
func TestRoutesWithTheirOwnLimitIgnoreTheGlobalOne(t *testing.T) {
	t.Setenv("SIPGES_MAX_UPLOAD_BYTES", "20971520") // 20 MiB: over the global limit
	s := start(t, false)
	over := strings.Repeat("x", maxBody+1)
	formInvalid := `{"detail":[{"type":"value_error","loc":["body"],"msg":"Invalid form body"}]}`
	jsonInvalid := `{"detail":[{"type":"json_invalid","loc":["body"],"msg":"JSON decode error"}]}`

	t.Run("login", func(t *testing.T) {
		expect(t, s.sendBody(t, "/login", "", "application/x-www-form-urlencoded", "password="+over, false), http.StatusUnprocessableEntity, formInvalid)
	})
	t.Run("account creation", func(t *testing.T) {
		expect(t, s.sendBody(t, "/system/auth/accounts", "multi", "text/plain", over, false, "X-SIPGES-Scope", "SIPGES/PRJ-SECHURA"), http.StatusUnprocessableEntity, jsonInvalid)
	})
	for _, path := range []string{"/system/uploads", "/system/document-lab/analyze", "/system/document-lab/report.docx", "/system/document-lab/compare"} {
		t.Run(path, func(t *testing.T) {
			if got := s.sendBody(t, path, "solo", "text/plain", over, false); got.status == http.StatusRequestEntityTooLarge {
				t.Fatalf("a body under the route's own limit was refused: %s", got.body)
			}
		})
	}
}
