package app_test

import (
	"encoding/json"
	"net/http"
	"testing"
)

const (
	noCoordinates = `{"available":false,"data":null,"notice":"No hay geometría de referencia registrada para este proyecto."}`
	noEntities    = `{"available":false,"data":null,"notice":"Las denominaciones canónicas no reescriben los textos de las fuentes originales."}`
	outOfScope    = `{"detail":"Proyecto fuera de alcance"}`
	chooseSechura = `{"detail":"Seleccione un proyecto autorizado mediante X-SIPGES-Scope o /select-project","projects":["SIPGES/PRJ-SECHURA"]}`
)

// The reference routes sit behind the session, project scope and role gate, and only the
// registered tenant (SIPGES/PRJ-SECHURA) ever sees the repository references.
func TestReferenceRoutes(t *testing.T) {
	s := start(t, false)
	paths := []string{"/system/project-coordinates", "/system/canonical-entities"}
	unavailable := map[string]string{paths[0]: noCoordinates, paths[1]: noEntities}
	norte := map[string]string{"X-SIPGES-Scope": "ACME/NORTE"}
	for _, path := range paths {
		t.Run(path+" needs a session", func(t *testing.T) {
			expect(t, s.do(t, req{path: path}), http.StatusUnauthorized, signIn)
			expect(t, s.do(t, req{path: path, user: "expired"}), http.StatusUnauthorized, signIn)
		})
		t.Run(path+" serves the registered tenant", func(t *testing.T) {
			got := s.do(t, req{path: path, user: "solo"})
			var body struct {
				Available bool            `json:"available"`
				Data      json.RawMessage `json:"data"`
			}
			if got.status != http.StatusOK || json.Unmarshal([]byte(got.body), &body) != nil || !body.Available || len(body.Data) < 10 {
				t.Fatalf("got %d %s", got.status, got.body)
			}
		})
		t.Run(path+" is unavailable to another tenant", func(t *testing.T) {
			expect(t, s.do(t, req{path: path, user: "multi", headers: norte}), http.StatusOK, unavailable[path])
			expect(t, s.do(t, req{path: path, user: "reader"}), http.StatusOK, unavailable[path])
			expect(t, s.do(t, req{path: path, user: "coord"}), http.StatusOK, unavailable[path])
		})
		t.Run(path+" refuses an ungranted project", func(t *testing.T) {
			expect(t, s.do(t, req{path: path, user: "solo", headers: norte}), http.StatusForbidden, chooseSechura)
			expect(t, s.do(t, req{path: path + "?project_id=NORTE", user: "solo"}), http.StatusForbidden, outOfScope)
			expect(t, s.do(t, req{path: path, user: "nogrant"}), http.StatusForbidden,
				`{"detail":"Seleccione un proyecto autorizado mediante X-SIPGES-Scope o /select-project","projects":[]}`)
		})
		t.Run(path+" answers only GET and HEAD", func(t *testing.T) {
			if got := s.do(t, req{method: http.MethodHead, path: path, user: "solo"}); got.status != http.StatusOK {
				t.Fatalf("HEAD %d", got.status)
			}
			expect(t, s.do(t, req{method: http.MethodPost, path: path, user: "solo", sameOrigin: true}), http.StatusNotFound, notFound)
		})
	}
}
