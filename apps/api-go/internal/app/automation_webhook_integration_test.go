package app_test

import (
	"io"
	"net/http"
	"strings"
	"testing"
)

//nolint:misspell // the Spanish module name
const webhookRule = `{"name":"Avisar webhooks","module":"Narrativas","actions":["CREATE"],"steps":[{"kind":"notify","title":"Webhook recibido"}]}`

const (
	webhookPath = "/hooks/ingest/narrativas" //nolint:misspell // the Spanish module slug
	// A synthetic write key of SIPGES/PRJ-SECHURA, hashed by the seed below.
	webhookPrefix = "c0ffee00b001"
)

var webhookSecret = strings.Repeat("w", 43)

// hook sends one webhook with the synthetic key, and a scope header no webhook may obey.
func (e pushEnv) hook(t *testing.T, id, idempotency string) (int, string) {
	t.Helper()
	body := strings.NewReader(`{"ID_Narrativa":"` + id + `","Descripcion":"Texto sintético"}`)
	r, err := http.NewRequestWithContext(t.Context(), http.MethodPost, e.base+webhookPath, body)
	if err != nil {
		t.Fatal(err)
	}
	r.Header.Set("Authorization", "Bearer mscli_"+webhookPrefix+"_"+webhookSecret)
	r.Header.Set("Content-Type", "application/json")
	r.Header.Set("X-SIPGES-Scope", "ACME/NORTE")
	if idempotency != "" {
		r.Header.Set("Idempotency-Key", idempotency)
	}
	res, err := http.DefaultClient.Do(r)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = res.Body.Close() }()
	b, _ := io.ReadAll(res.Body)
	return res.StatusCode, string(b)
}

// A webhook is a committed write: its project gets a scan with no session write after it, and the
// project is the key's, whatever the request says.
func TestAWebhookWakesItsKeysProjectAlone(t *testing.T) {
	e := startPush(t, false)
	if _, err := e.pool.Exec(t.Context(), `INSERT INTO api_keys (tenant_id, name, prefix, secret_hash, access, clearance, created_by, created_at)
		VALUES ('SIPGES/PRJ-SECHURA', 'webhook', $1, encode(sha256($2::bytea), 'hex'), 'write', 'full', 'test', now())`,
		webhookPrefix, webhookSecret); err != nil {
		t.Fatal(err)
	}
	if status, body := e.do(t, "POST", "/system/automations/rules", "boss", webhookRule); status != 200 {
		t.Fatalf("rule: %d %s", status, body)
	}
	finished := func() int64 {
		return e.count(t, `SELECT count(*) FROM automation_cursors WHERE tenant_id = 'SIPGES/PRJ-SECHURA' AND last_tick_status = 'completed'`)
	}
	e.until(t, "the rule's own scan", func() bool { return finished() == 1 })

	if status, body := e.hook(t, "WEBHOOK-1", "uno"); status != 201 {
		t.Fatalf("webhook: %d %s", status, body)
	}
	e.until(t, "the webhook's notification", func() bool {
		return e.count(t, `SELECT count(*) FROM notifications WHERE title = 'Webhook recibido'`) == 1
	})
	if n := e.count(t, `SELECT count(*) FROM automation_cursors WHERE tenant_id = 'ACME/NORTE'`); n != 0 {
		t.Fatalf("the scope header woke another project: %d cursors", n)
	}
}
