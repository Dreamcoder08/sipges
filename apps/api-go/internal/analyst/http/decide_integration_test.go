package http_test

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"sync"
	"testing"

	"github.com/jackc/pgx/v5"
)

const proposalsPath = "/system/briefing/proposals"

func post(t *testing.T, base, user, body string) (int, string) {
	t.Helper()
	r, err := http.NewRequestWithContext(context.Background(), http.MethodPost, base+proposalsPath, strings.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	r.Header.Set("Origin", base)
	r.Header.Set("Content-Type", "application/json")
	r.Header.Set("Cookie", "sipges_session="+tokens[user])
	res, err := http.DefaultClient.Do(r)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = res.Body.Close() }()
	raw, err := io.ReadAll(res.Body)
	if err != nil {
		t.Fatal(err)
	}
	return res.StatusCode, strings.TrimSpace(string(raw))
}

// undoDecisions keeps the proposals the read tests of this package compare exactly.
func undoDecisions(t *testing.T) {
	t.Helper()
	needsDatabase(t)
	t.Cleanup(func() {
		ctx := context.Background()
		conn, err := pgx.Connect(ctx, scratch.URL)
		if err != nil {
			t.Fatal(err)
		}
		defer func() { _ = conn.Close(ctx) }()
		for _, sql := range []string{
			`DELETE FROM proposal_decisions WHERE subject_id IN ('AL-1', 'N-1')`,
			`DELETE FROM record_links WHERE note = 'Propuesta del analista aprobada'`,
			`DELETE FROM module_records WHERE module = 'Acciones'`,
		} {
			if _, err := conn.Exec(ctx, sql); err != nil {
				t.Fatal(err)
			}
		}
	})
}

func scalar[T any](t *testing.T, sql string, args ...any) T {
	t.Helper()
	needsDatabase(t)
	ctx := context.Background()
	conn, err := pgx.Connect(ctx, scratch.URL)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = conn.Close(ctx) }()
	var value T
	if err := conn.QueryRow(ctx, sql, args...).Scan(&value); err != nil {
		t.Fatal(err)
	}
	return value
}

func decision(module, id, fingerprint, verdict string) string {
	body, _ := json.Marshal(map[string]string{"module": module, "id": id, "fingerprint": fingerprint, "decision": verdict})
	return string(body)
}

const alertFingerprint = "record:acciones:alertas/AL-1"

func TestApprovingAFollowUpCreatesTheRecordAndAuditsIt(t *testing.T) {
	undoDecisions(t)
	base := start(t)
	code, body := post(t, base, "solo", decision("alertas", "AL-1", alertFingerprint, "approve"))
	var got struct {
		OK     bool   `json:"ok"`
		Result string `json:"result"`
	}
	if err := json.Unmarshal([]byte(body), &got); err != nil || code != http.StatusOK || !got.OK || !strings.HasPrefix(got.Result, "acciones/") {
		t.Fatalf("%d %s", code, body)
	}
	id := strings.TrimPrefix(got.Result, "acciones/")
	stored := scalar[string](t, `SELECT payload->>'Alerta_Asociada' FROM module_records WHERE module = 'Acciones' AND id = $1 AND tenant_id = 'SIPGES/PRJ-SECHURA'`, id)
	if stored != "AL-1" {
		t.Fatalf("stored = %q", stored)
	}
	saved := scalar[string](t, `SELECT decision || '|' || result || '|' || decided_by || '|' || kind FROM proposal_decisions WHERE fingerprint = $1`, alertFingerprint)
	if saved != "approved|acciones/"+id+"|solo|record" {
		t.Fatalf("saved = %q", saved)
	}
	audit := scalar[string](t, `SELECT action || '|' || record_id || '|' || detail FROM audit WHERE module = 'Analista' AND record_id = 'AL-1' ORDER BY ts DESC LIMIT 1`)
	if !strings.HasPrefix(audit, "REVIEW|AL-1|Aprobada: ") || !strings.HasSuffix(audit, " → acciones/"+id) {
		t.Fatalf("audit = %q", audit)
	}
	if created := scalar[int](t, `SELECT count(*) FROM audit WHERE module = 'Acciones' AND record_id = $1 AND action = 'CREATE'`, id); created != 1 {
		t.Fatalf("the record's own audit rows = %d", created)
	}
	code, body = post(t, base, "solo", decision("alertas", "AL-1", alertFingerprint, "approve"))
	if code != http.StatusNotFound || body != `{"detail":"La propuesta ya no está disponible"}` {
		t.Fatalf("again: %d %s", code, body)
	}
}

func TestApprovingALinkReadFromTextCreatesIt(t *testing.T) {
	undoDecisions(t)
	base := start(t)
	code, body := get(t, base, proposalsPath+"?module=narrativas&id=N-1", "solo", nil) //nolint:misspell // Spanish, verbatim
	var open []struct {
		Fingerprint string `json:"fingerprint"`
		Kind        string `json:"kind"`
	}
	if err := json.Unmarshal([]byte(body), &open); err != nil || code != http.StatusOK || len(open) == 0 || open[0].Kind != "link" {
		t.Fatalf("%d %s", code, body)
	}
	code, body = post(t, base, "solo", decision("narrativas", "N-1", open[0].Fingerprint, "approve")) //nolint:misspell // Spanish, verbatim
	if code != http.StatusOK || body != `{"ok":true,"result":null}` {
		t.Fatalf("%d %s", code, body)
	}
	links := scalar[int](t, `SELECT count(*) FROM record_links WHERE note = 'Propuesta del analista aprobada' AND created_by = 'solo' AND tenant_id = 'SIPGES/PRJ-SECHURA'`)
	if links != 1 {
		t.Fatalf("links = %d", links)
	}
	if code, body = get(t, base, proposalsPath+"?module=narrativas&id=N-1", "solo", nil); code != http.StatusOK || body != "[]" { //nolint:misspell // Spanish, verbatim
		t.Fatalf("still open: %d %s", code, body)
	}
}

func TestRejectingWritesOnlyTheDecision(t *testing.T) {
	undoDecisions(t)
	base := start(t)
	before := scalar[int](t, `SELECT count(*) FROM module_records WHERE module = 'Acciones'`)
	code, body := post(t, base, "solo", decision("alertas", "AL-1", alertFingerprint, "reject"))
	if code != http.StatusOK || body != `{"ok":true,"result":null}` {
		t.Fatalf("%d %s", code, body)
	}
	if after := scalar[int](t, `SELECT count(*) FROM module_records WHERE module = 'Acciones'`); after != before {
		t.Fatalf("records %d, then %d", before, after)
	}
}

func TestConcurrentDecisionsWriteOneDecision(t *testing.T) {
	undoDecisions(t)
	base := start(t)
	var (
		wg sync.WaitGroup
		mu sync.Mutex
		ok int
	)
	for range 6 {
		wg.Go(func() {
			code, _ := post(t, base, "solo", decision("alertas", "AL-1", alertFingerprint, "reject"))
			mu.Lock()
			defer mu.Unlock()
			if code == http.StatusOK {
				ok++
			}
		})
	}
	wg.Wait()
	if ok != 1 {
		t.Fatalf("%d decisions succeeded", ok)
	}
	if rows := scalar[int](t, `SELECT count(*) FROM proposal_decisions WHERE fingerprint = $1`, alertFingerprint); rows != 1 {
		t.Fatalf("rows = %d", rows)
	}
}

func TestDecisionRefusals(t *testing.T) {
	undoDecisions(t)
	base := start(t)
	cases := []struct {
		name, user, body string
		status           int
		want             string
	}{
		{"unknown fingerprint", "solo", decision("alertas", "AL-1", "record:otra", "approve"), 404, `{"detail":"La propuesta ya no está disponible"}`},
		{"unknown record", "solo", decision("alertas", "NADA", alertFingerprint, "approve"), 404, `{"detail":"La propuesta ya no está disponible"}`},
		{"unknown module", "solo", decision("nada", "AL-1", alertFingerprint, "approve"), 404, `{"detail":"La propuesta ya no está disponible"}`},
		{"invalid decision", "solo", decision("alertas", "AL-1", alertFingerprint, "quizá"), 422, `{"detail":[{"type":"invalid_value","loc":["body","decision"],"msg":"Invalid option: expected one of \"approve\"|\"reject\""}]}`},
	}
	for _, c := range cases {
		code, body := post(t, base, c.user, c.body)
		if code != c.status || body != c.want {
			t.Errorf("%s: %d %s", c.name, code, body)
		}
	}
	if code, _ := post(t, base, "reader", decision("alertas", "AL-1", alertFingerprint, "reject")); code != http.StatusForbidden {
		t.Errorf("read-only role: %d", code)
	}
	if rows := scalar[int](t, `SELECT count(*) FROM proposal_decisions WHERE subject_id = 'AL-1'`); rows != 0 {
		t.Fatalf("a refusal wrote %d rows", rows)
	}
}
