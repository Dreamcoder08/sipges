package app_test

import (
	"encoding/json"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"testing"

	"github.com/Dreamcoder08/sipges/apps/api-go/internal/identity/infrastructure"
)

// Ported from apps/api/test/integration-context/ingest-http.test.ts and mcp-http.test.ts (key
// issuing), plus the T35 probes.

const (
	keyPath      = "/system/integrations/api-keys"
	duplicateKey = `{"detail":"Ya existe una clave con ese nombre"}`
)

var apiToken = regexp.MustCompile(`^mscli_([a-f0-9]{12})_([A-Za-z0-9_-]{43})$`)

type issuedKey struct {
	OK    bool   `json:"ok"`
	ID    int    `json:"id"`
	Token string `json:"token"`
}

func (f accountsFixture) issue(t *testing.T, user, body string) issuedKey {
	t.Helper()
	got := f.send(t, keyPath, user, body)
	var key issuedKey
	if got.status != http.StatusOK || json.Unmarshal([]byte(got.body), &key) != nil || !key.OK {
		t.Fatalf("issue: %d %s", got.status, got.body)
	}
	return key
}

// ingest calls a machine route with the token, the way an external client does.
func (f accountsFixture) ingest(t *testing.T, token string) reply {
	t.Helper()
	return f.s.do(t, req{method: "POST", path: "/hooks/ingest/Eventos", body: `{}`,
		headers: map[string]string{"Authorization": "Bearer " + token, "Content-Type": "application/json"}})
}

func TestIssueAPIKeyStoresOnlyTheHashAndAuditsIt(t *testing.T) {
	f := newAccountsFixture(t, "keyissue")
	admin := f.session(t, "admin", "admin", true)
	key := f.issue(t, admin, `{"name":"  Sensor Ñandú  ","access":"write","clearance":"full"}`)
	match := apiToken.FindStringSubmatch(key.Token)
	if match == nil {
		t.Fatalf("token %q", key.Token)
	}
	prefix, secret := match[1], match[2]
	if n := f.count(t, `SELECT count(*) FROM api_keys WHERE id = $1 AND tenant_id = $2 AND name = 'Sensor Ñandú' AND prefix = $3
	      AND secret_hash = $4 AND access = 'write' AND clearance = 'full' AND created_by = $5 AND created_at = $6
	      AND last_used_at IS NULL AND revoked_at IS NULL`,
		key.ID, f.project, prefix, infrastructure.HashToken(secret), admin, f.s.clock.now()); n != 1 {
		t.Fatal("the stored row differs")
	}
	if n := f.count(t, `SELECT count(*) FROM api_keys WHERE secret_hash = $1`, secret); n != 0 {
		t.Fatal("the raw secret was stored")
	}
	if n := f.count(t, `SELECT count(*) FROM audit WHERE tenant_id = $1 AND module = 'Integraciones' AND record_id = $2 AND action = 'CREATE'
	      AND detail = $3 AND ts = $4`, f.project, "clave-"+strconv.Itoa(key.ID),
		"Clave de API «Sensor Ñandú» (write, full) "+prefix, f.s.clock.now()); n != 1 {
		t.Fatal("the audit row differs")
	}

	listed := f.s.do(t, req{path: keyPath, user: admin, headers: map[string]string{"X-SIPGES-Scope": f.project}})
	if !strings.Contains(listed.body, prefix) || strings.Contains(listed.body, secret) || strings.Contains(listed.body, "secret_hash") {
		t.Fatalf("list %s", listed.body)
	}
}

func TestIssuedKeyAuthenticatesUntilItIsRevoked(t *testing.T) {
	f := newAccountsFixture(t, "keyauth")
	admin := f.session(t, "admin", "admin", true)
	key := f.issue(t, admin, `{"name":"sensor","access":"write"}`)
	const unauthorized = http.StatusUnauthorized
	if got := f.ingest(t, key.Token); got.status == unauthorized {
		t.Fatalf("a new key was refused: %s", got.body)
	}
	if n := f.count(t, `SELECT count(*) FROM api_keys WHERE id = $1 AND last_used_at IS NOT NULL`, key.ID); n != 1 {
		t.Fatal("use was not recorded")
	}
	if got := f.ingest(t, key.Token[:len(key.Token)-1]+"A"); got.status != unauthorized && !strings.HasSuffix(key.Token, "A") {
		t.Fatalf("a wrong secret passed: %d", got.status)
	}
	expect(t, f.s.do(t, req{method: "DELETE", path: keyPath + "/" + strconv.Itoa(key.ID), user: admin, sameOrigin: true,
		headers: map[string]string{"X-SIPGES-Scope": f.project}}), http.StatusOK, okTrue)
	if got := f.ingest(t, key.Token); got.status != unauthorized {
		t.Fatalf("a revoked key passed: %d", got.status)
	}
}

func TestIssueAPIKeyDefaultsAndDuplicates(t *testing.T) {
	f := newAccountsFixture(t, "keydup")
	admin := f.session(t, "admin", "admin", true)
	other := accountsFixture{f.loginFixture, "keydup2/PRJ"}
	other.exec(t, `INSERT INTO tenants (company_id, project_id, label) VALUES ('keydup2', 'PRJ', 'Synthetic')`)
	other.exec(t, `INSERT INTO grants (username, tenant_id) VALUES ($1, $2)`, admin, other.project)
	key := f.issue(t, admin, `{"name":"sensor"}`)
	if n := f.count(t, `SELECT count(*) FROM api_keys WHERE id = $1 AND access = 'read' AND clearance = 'limited'`, key.ID); n != 1 {
		t.Fatal("the defaults differ")
	}
	expect(t, f.send(t, keyPath, admin, `{"name":" sensor "}`), http.StatusConflict, duplicateKey)
	if n := f.count(t, `SELECT count(*) FROM audit WHERE tenant_id = $1 AND action = 'CREATE' AND module = 'Integraciones'`, f.project); n != 1 {
		t.Fatalf("a duplicate was audited: %d rows", n)
	}
	// The same name in another project is another key.
	other.issue(t, admin, `{"name":"sensor"}`)
}

func TestIssueAPIKeyValidation(t *testing.T) {
	f := newAccountsFixture(t, "keyval")
	admin := f.session(t, "admin", "admin", true)
	small := `{"type":"too_small","loc":["body","name"],"msg":"Too small: expected string to have >=1 characters"}`
	big := `{"type":"too_big","loc":["body","name"],"msg":"Too big: expected string to have <=80 characters"}`
	nul := `{"type":"custom","loc":["body","name"],"msg":"Text must not contain NUL characters"}`
	for body, want := range map[string]string{
		`{}`:                 `{"detail":[{"type":"missing","loc":["body","name"],"msg":"Field required"}]}`,
		`{"name":""}`:        `{"detail":[` + small + `]}`,
		`{"name":"  \t "}`:   `{"detail":[` + small + `]}`,
		`{"name":"a\u0000"}`: `{"detail":[` + nul + `]}`,
		`{"name":"` + strings.Repeat("x", 81) + `"}`:      `{"detail":[` + big + `]}`,
		`{"name":"` + strings.Repeat(`\u0000`, 81) + `"}`: `{"detail":[` + big + `,` + nul + `]}`,
		`{"name":1}`: `{"detail":[{"type":"invalid_type","loc":["body","name"],"msg":"Invalid input: expected string, received number"}]}`,
		`{"name":"a","access":"x","clearance":"y"}`: `{"detail":[{"type":"invalid_value","loc":["body","access"],"msg":"Invalid option: expected one of \"read\"|\"write\""},{"type":"invalid_value","loc":["body","clearance"],"msg":"Invalid option: expected one of \"limited\"|\"full\""}]}`,
		`{"name":"a","access":null}`:                `{"detail":[{"type":"invalid_value","loc":["body","access"],"msg":"Invalid option: expected one of \"read\"|\"write\""}]}`,
		`[]`:                                        `{"detail":[{"type":"invalid_type","loc":["body"],"msg":"Invalid input: expected object, received array"}]}`,
		`{`:                                         `{"detail":[{"type":"json_invalid","loc":["body"],"msg":"JSON decode error"}]}`,
	} {
		expect(t, f.send(t, keyPath, admin, body), http.StatusUnprocessableEntity, want)
	}
	key := f.issue(t, admin, `{"name":"`+strings.Repeat("😀", 40)+`"}`) // 80 UTF-16 units
	if key.ID == 0 {
		t.Fatal("no id")
	}
	if n := f.count(t, `SELECT count(*) FROM api_keys WHERE tenant_id = $1`, f.project); n != 1 {
		t.Fatalf("a refused body stored a key: %d rows", n)
	}
}

// A browser's JSON.stringify sends a lone surrogate as an escape: TypeScript accepts it, counts it
// as one character and stores U+FFFD, as its driver's UTF-8 encoding writes it.
func TestIssueAPIKeyAcceptsALoneSurrogateInTheName(t *testing.T) {
	f := newAccountsFixture(t, "keysurrogate")
	admin := f.session(t, "admin", "admin", true)
	for body, stored := range map[string]string{
		`{"name":"x\ud83dy"}`:                              "x\uFFFDy",
		`{"name":"  \ud83d  "}`:                            "\uFFFD",
		`{"name":"a\ude00b"}`:                              "a\uFFFDb",
		`{"name":"` + strings.Repeat("x", 79) + `\ud83d"}`: strings.Repeat("x", 79) + "\uFFFD",
		`{"name":"` + strings.Repeat(`\ud83d`, 80) + `"}`:  strings.Repeat("\uFFFD", 80),
	} {
		key := f.issue(t, admin, body)
		if n := f.count(t, `SELECT count(*) FROM api_keys WHERE id = $1 AND name = $2`, key.ID, stored); n != 1 {
			t.Fatalf("%s: the stored name differs", body)
		}
		if n := f.count(t, `SELECT count(*) FROM audit WHERE record_id = $1 AND detail LIKE $2`,
			"clave-"+strconv.Itoa(key.ID), "Clave de API «"+stored+"»%"); n != 1 {
			t.Fatalf("%s: the audit detail differs", body)
		}
	}
	expect(t, f.send(t, keyPath, admin, `{"name":"`+strings.Repeat(`\ud83d`, 81)+`"}`), http.StatusUnprocessableEntity,
		`{"detail":[{"type":"too_big","loc":["body","name"],"msg":"Too big: expected string to have <=80 characters"}]}`)
}

func TestIssueAPIKeyGates(t *testing.T) {
	f := newAccountsFixture(t, "keygate")
	reader := f.session(t, "reader", "consulta", true)
	analyst := f.session(t, "analyst", "analista", true)
	for _, user := range []string{reader, analyst} {
		got := f.send(t, keyPath, user, `{"name":"x"}`)
		if got.status != http.StatusForbidden {
			t.Fatalf("%s: %d %s", user, got.status, got.body)
		}
	}
	expect(t, f.send(t, keyPath, "", `{"name":"x"}`), http.StatusUnauthorized, signIn)
	admin := f.session(t, "admin", "admin", false)
	got := f.send(t, keyPath, admin, `{"name":"x"}`)
	if got.status != http.StatusForbidden {
		t.Fatalf("no grant: %d %s", got.status, got.body)
	}
	if n := f.count(t, `SELECT count(*) FROM api_keys WHERE tenant_id = $1`, f.project); n != 0 {
		t.Fatal("a refused request stored a key")
	}
}
