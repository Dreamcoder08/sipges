package app_test

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5"
)

// The analyst's proposals end to end (odd/tasks/agentic-analyst.md S4): real router, session, RLS
// and decision flow, with the scripted model of analyst_ask_integration_test.go.

const storedProposals = "/system/analyst/proposals"

func scratchConn(t *testing.T) *pgx.Conn {
	t.Helper()
	conn, err := pgx.Connect(context.Background(), scratch.URL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = conn.Close(context.Background()) })
	return conn
}

func count(t *testing.T, conn *pgx.Conn, sql string, args ...any) int {
	t.Helper()
	var n int
	if err := conn.QueryRow(context.Background(), sql, args...).Scan(&n); err != nil {
		t.Fatal(err)
	}
	return n
}

// proposeTwo asks the analyst, as multi in ACME/NORTE, to propose one action and one link.
func proposeTwo(t *testing.T) (*server, *pgx.Conn) {
	t.Helper()
	model := analystSetup(t, true)
	t.Setenv("SIPGES_DATA_KEY", dataKey)
	conn := scratchConn(t)
	t.Cleanup(func() {
		for _, sql := range []string{
			`DELETE FROM proposal_decisions WHERE fingerprint LIKE 'stored:%'`,
			`DELETE FROM analyst_proposals`,
			`DELETE FROM module_records WHERE module = 'Acciones'`,
			`DELETE FROM audit WHERE module IN ('Acciones', 'Analista')`,
		} {
			if _, err := conn.Exec(context.Background(), sql); err != nil {
				t.Fatal(err)
			}
		}
	})
	model.steps = []string{
		toolCall("p1", "propose_record", `{"module":"acciones","fields":{"Accion":"Visitar la comunidad","Estado":"Pendiente"},"reason":"El evento north sigue sin atención"}`),
		toolCall("p2", "propose_link", `{"link_type":"relacionado_con","source":{"module":"eventos","id":"north"},"target":{"module":"eventos","id":"north-secret"},"reason":"Mismo lugar"}`),
		`{"choices":[{"message":{"content":"Dejé dos propuestas en Bandeja."}}]}`,
	}
	s := start(t, false)
	if got := askAs(t, s, "multi", "ACME/NORTE", "Registra una acción para el evento north"); got.status != http.StatusOK {
		t.Fatalf("ask: status %d, body %s", got.status, got.body)
	}
	if last := model.requests()[2]; !strings.Contains(last, "pendiente de aprobación en Bandeja") {
		t.Fatalf("the model did not read the acknowledgement: %s", last)
	}
	return s, conn
}

type storedOut struct {
	ID     string `json:"id"`
	Kind   string `json:"kind"`
	Title  string `json:"title"`
	Record *struct {
		Module string `json:"module"`
	} `json:"record"`
	ProposedBy string `json:"proposed_by"`
}

func pendingAs(t *testing.T, s *server, user, scope string) []storedOut {
	t.Helper()
	got := s.do(t, req{path: storedProposals, user: user, headers: map[string]string{"X-SIPGES-Scope": scope}})
	if got.status != http.StatusOK {
		t.Fatalf("%s in %s: status %d, body %s", user, scope, got.status, got.body)
	}
	var out []storedOut
	if err := json.Unmarshal([]byte(got.body), &out); err != nil {
		t.Fatal(err)
	}
	return out
}

// byKind is the pending proposal of kind; the test clock stamps both with the same instant.
func byKind(t *testing.T, pending []storedOut, kind string) storedOut {
	t.Helper()
	for _, p := range pending {
		if p.Kind == kind {
			return p
		}
	}
	t.Fatalf("no %s proposal in %+v", kind, pending)
	return storedOut{}
}

func decideAs(t *testing.T, s *server, user, id, decision string) reply {
	t.Helper()
	body, _ := json.Marshal(map[string]string{"id": id, "decision": decision})
	return s.do(t, req{method: http.MethodPost, path: storedProposals, user: user, sameOrigin: true,
		headers: map[string]string{"X-SIPGES-Scope": "ACME/NORTE", "Content-Type": "application/json"}, body: string(body)})
}

func TestAnAnalystProposalWritesNothingUntilAPersonApproves(t *testing.T) {
	s, conn := proposeTwo(t)
	if n := count(t, conn, `SELECT count(*) FROM module_records WHERE module = 'Acciones'`); n != 0 {
		t.Fatalf("proposing wrote %d records", n)
	}
	if n := count(t, conn, `SELECT count(*) FROM record_links`); n != 0 {
		t.Fatalf("proposing wrote %d links", n)
	}
	pending := pendingAs(t, s, "multi", "ACME/NORTE")
	record := byKind(t, pending, "record")
	if len(pending) != 2 || record.Record.Module != "acciones" || record.Title != "Crear Acción: «Visitar la comunidad»" ||
		record.ProposedBy != "multi" || byKind(t, pending, "link").Title != "Vincular: Evento north está relacionado con Evento north-secret" {
		t.Fatalf("pending = %+v", pending)
	}
}

func TestAStoredProposalIsVisibleOnlyInItsProject(t *testing.T) {
	s, conn := proposeTwo(t)
	if other := pendingAs(t, s, "multi", "SIPGES/PRJ-SECHURA"); len(other) != 0 {
		t.Fatalf("another project sees %+v", other)
	}
	if got := decideAs(t, s, "multi", byKind(t, pendingAs(t, s, "multi", "ACME/NORTE"), "record").ID, "approve"); got.status != http.StatusOK {
		t.Fatalf("approve in its project: %d %s", got.status, got.body)
	}
	// Row-level security itself, as the tenant role sees the table.
	tx, err := conn.Begin(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = tx.Rollback(context.Background()) }()
	if _, err := tx.Exec(context.Background(), `SELECT set_config('role', 'sipges_tenant', true),
		set_config('app.tenant_id', 'SIPGES/PRJ-SECHURA', true)`); err != nil {
		t.Fatal(err)
	}
	var seen int
	if err := tx.QueryRow(context.Background(), `SELECT count(*) FROM analyst_proposals`).Scan(&seen); err != nil || seen != 0 {
		t.Fatalf("SIPGES/PRJ-SECHURA sees %d proposals (err %v)", seen, err)
	}
	_, err = tx.Exec(context.Background(), `INSERT INTO analyst_proposals
		(tenant_id, id, kind, target_module, title, reason, proposal, proposed_by, proposed_at)
		VALUES ('ACME/NORTE', 'AP-X', 'record', 'acciones', 't', 'r', '{}', 'x', now())`)
	if err == nil {
		t.Fatal("a tenant wrote a proposal into another project")
	}
}

func TestApprovingWritesOnceThroughTheActionsAndAudits(t *testing.T) {
	s, conn := proposeTwo(t)
	id := byKind(t, pendingAs(t, s, "multi", "ACME/NORTE"), "record").ID
	got := decideAs(t, s, "multi", id, "approve")
	if got.status != http.StatusOK || !strings.Contains(got.body, `"result":"acciones/`) {
		t.Fatalf("approve: %d %s", got.status, got.body)
	}
	if again := decideAs(t, s, "multi", id, "approve"); again.status != http.StatusNotFound {
		t.Fatalf("second approval: %d %s", again.status, again.body)
	}
	if n := count(t, conn, `SELECT count(*) FROM module_records WHERE tenant_id = 'ACME/NORTE' AND module = 'Acciones'
		AND payload->>'Accion' = 'Visitar la comunidad' AND payload->>'Proyecto_ID' = 'NORTE'`); n != 1 {
		t.Fatalf("%d records written", n)
	}
	if n := count(t, conn, `SELECT count(*) FROM audit WHERE tenant_id = 'ACME/NORTE' AND module = 'Acciones' AND action = 'CREATE'`); n != 1 {
		t.Fatalf("%d record audits", n)
	}
	if n := count(t, conn, `SELECT count(*) FROM audit WHERE tenant_id = 'ACME/NORTE' AND module = 'Analista'
		AND action = 'REVIEW' AND record_id = $1 AND detail LIKE 'Aprobada: Crear Acción%'`, id); n != 1 {
		t.Fatalf("%d decision audits", n)
	}
	if n := count(t, conn, `SELECT count(*) FROM proposal_decisions WHERE fingerprint = $1 AND decision = 'approved' AND decided_by = 'multi'`,
		"stored:"+id); n != 1 {
		t.Fatalf("%d decisions", n)
	}
	if left := pendingAs(t, s, "multi", "ACME/NORTE"); len(left) != 1 || left[0].ID == id {
		t.Fatalf("still pending: %+v", left)
	}
}

func TestRolesThatMayNotWriteTheModuleCannotDecide(t *testing.T) {
	s, conn := proposeTwo(t)
	id := byKind(t, pendingAs(t, s, "multi", "ACME/NORTE"), "record").ID
	for _, user := range []string{"reader", "coord"} {
		for _, decision := range []string{"approve", "reject"} {
			if got := decideAs(t, s, user, id, decision); got.status != http.StatusForbidden {
				t.Fatalf("%s %s: %d %s", user, decision, got.status, got.body)
			}
		}
	}
	if n := count(t, conn, `SELECT count(*) FROM proposal_decisions WHERE fingerprint LIKE 'stored:%'`); n != 0 {
		t.Fatalf("%d decisions recorded", n)
	}
	if n := count(t, conn, `SELECT count(*) FROM module_records WHERE module = 'Acciones'`); n != 0 {
		t.Fatalf("%d records written", n)
	}
}

func TestRejectingWritesNothingAndAudits(t *testing.T) {
	s, conn := proposeTwo(t)
	link := byKind(t, pendingAs(t, s, "multi", "ACME/NORTE"), "link")
	if got := decideAs(t, s, "multi", link.ID, "reject"); got.status != http.StatusOK || !strings.Contains(got.body, `"result":null`) {
		t.Fatalf("reject: %d %s", got.status, got.body)
	}
	if n := count(t, conn, `SELECT count(*) FROM record_links`); n != 0 {
		t.Fatalf("rejecting wrote %d links", n)
	}
	if n := count(t, conn, `SELECT count(*) FROM audit WHERE module = 'Analista' AND record_id = $1 AND detail LIKE 'Descartada:%'`, link.ID); n != 1 {
		t.Fatalf("%d rejection audits", n)
	}
	if got := decideAs(t, s, "multi", "AP-NOPE", "approve"); got.status != http.StatusNotFound {
		t.Fatalf("unknown proposal: %d", got.status)
	}
	if got := decideAs(t, s, "multi", link.ID, "maybe"); got.status != http.StatusUnprocessableEntity {
		t.Fatalf("bad decision: %d", got.status)
	}
}

// ADR 0012: a read-only account never reads restricted content, and a proposal may quote it.
// The list shows only what the viewer may decide, and consulta may decide nothing.
func TestReadOnlyRolesNeverReadRestrictedContentThroughProposals(t *testing.T) {
	model := analystSetup(t, true)
	t.Setenv("SIPGES_DATA_KEY", dataKey)
	conn := scratchConn(t)
	t.Cleanup(func() { _, _ = conn.Exec(context.Background(), `DELETE FROM analyst_proposals`) })
	model.steps = []string{
		toolCall("p0", "get_record", `{"module":"eventos","id":"north-secret"}`),
		toolCall("p1", "propose_record", `{"module":"acciones","fields":{"Accion":"SECRETO de north-secret","Estado":"Pendiente"},"reason":"north-secret dice SECRETO"}`),
		`{"choices":[{"message":{"content":"Listo."}}]}`,
	}
	s := start(t, false)
	if got := askAs(t, s, "multi", "ACME/NORTE", "registra"); got.status != http.StatusOK {
		t.Fatalf("ask: %d %s", got.status, got.body)
	}
	got := s.do(t, req{path: storedProposals, user: "reader", headers: map[string]string{"X-SIPGES-Scope": "ACME/NORTE"}})
	if got.status != http.StatusOK || strings.Contains(got.body, "SECRETO") || strings.Contains(got.body, "north-secret") {
		t.Fatalf("consulta reads restricted content: %d %s", got.status, got.body)
	}
	if theirs := pendingAs(t, s, "reader", "ACME/NORTE"); len(theirs) != 0 {
		t.Fatalf("consulta lists %d proposals, want 0", len(theirs))
	}
	if mine := pendingAs(t, s, "multi", "ACME/NORTE"); len(mine) != 1 {
		t.Fatalf("the administrator sees %d proposals, want 1", len(mine))
	}
}
