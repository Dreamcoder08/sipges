//nolint:misspell // Spanish module names, fields and messages, verbatim from the TypeScript API.
package http_test

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	identityhttp "github.com/Dreamcoder08/sipges/apps/api-go/internal/identity/http"
	identitysql "github.com/Dreamcoder08/sipges/apps/api-go/internal/identity/infrastructure"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/integration/application"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/integration/domain"
	integrationhttp "github.com/Dreamcoder08/sipges/apps/api-go/internal/integration/http"
	integrationsql "github.com/Dreamcoder08/sipges/apps/api-go/internal/integration/infrastructure"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/platform/database"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/platform/httpx"
	recordsapp "github.com/Dreamcoder08/sipges/apps/api-go/internal/records/application"
	recordssql "github.com/Dreamcoder08/sipges/apps/api-go/internal/records/infrastructure"
	tenancyapp "github.com/Dreamcoder08/sipges/apps/api-go/internal/tenancy/application"
	tenancyhttp "github.com/Dreamcoder08/sipges/apps/api-go/internal/tenancy/http"
	tenancysql "github.com/Dreamcoder08/sipges/apps/api-go/internal/tenancy/infrastructure"
)

// The integration runtime against a migrated synthetic PostgreSQL: the webhooks with real API
// key rows (a forged secret, a revoked key, a read-only key, another tenant's key), idempotency
// receipts, oversize bodies, and the admin writes with their audit rows, all under row-level
// security. Every key, secret and record is synthetic.

// The synthetic secrets: 43 base64url characters, stored as SHA-256 like keyCrypto.hash.
var (
	secretWrite   = strings.Repeat("w", 43)
	secretLimited = strings.Repeat("l", 43)
	secretRead    = strings.Repeat("r", 43)
	secretRevoked = strings.Repeat("v", 43)
	secretNorte   = strings.Repeat("n", 43)
	secretRevoke  = strings.Repeat("k", 43)
)

func hashOf(secret string) string {
	sum := sha256.Sum256([]byte(secret))
	return hex.EncodeToString(sum[:])
}

func bearer(prefix, secret string) string { return "Bearer mscli_" + prefix + "_" + secret }

var (
	writeKey   = bearer("c0ffee00a001", secretWrite)
	limitedKey = bearer("c0ffee00a002", secretLimited)
	readKey    = bearer("c0ffee00a003", secretRead)
	revokedKey = bearer("c0ffee00a004", secretRevoked)
	norteKey   = bearer("c0ffee00b001", secretNorte)
	revokeMe   = bearer("c0ffee00a005", secretRevoke)
)

var seedRuntime sync.Once

func runtimeSeed(t *testing.T) {
	t.Helper()
	seedRuntime.Do(func() {
		conn, err := pgx.Connect(context.Background(), scratch.URL)
		if err != nil {
			t.Fatal(err)
		}
		defer func() { _ = conn.Close(context.Background()) }()
		_, err = conn.Exec(context.Background(), `
			INSERT INTO api_keys (id, tenant_id, name, prefix, secret_hash, access, clearance, created_by,
			  created_at, last_used_at, revoked_at) OVERRIDING SYSTEM VALUE VALUES
			  (41,'SIPGES/PRJ-SECHURA','hook-escritura','c0ffee00a001',$1,'write','full','multi','2026-10-01T00:00:00Z',NULL,NULL),
			  (42,'SIPGES/PRJ-SECHURA','hook-limitada','c0ffee00a002',$2,'write','limited','multi','2026-10-01T00:00:00Z','2026-11-03T10:59:30Z',NULL),
			  (43,'SIPGES/PRJ-SECHURA','hook-lectura','c0ffee00a003',$3,'read','full','multi','2026-10-01T00:00:00Z',NULL,NULL),
			  (44,'SIPGES/PRJ-SECHURA','hook-revocada','c0ffee00a004',$4,'write','full','multi','2026-10-01T00:00:00Z',NULL,'2026-10-02T00:00:00Z'),
			  (45,'SIPGES/PRJ-SECHURA','hook-a-revocar','c0ffee00a005',$6,'write','full','multi','2026-10-01T00:00:00Z',NULL,NULL),
			  (51,'ACME/NORTE','hook-escritura','c0ffee00b001',$5,'write','full','multi','2026-10-01T00:00:00Z',NULL,NULL)`,
			hashOf(secretWrite), hashOf(secretLimited), hashOf(secretRead), hashOf(secretRevoked), hashOf(secretNorte), hashOf(secretRevoke))
		if err != nil {
			t.Fatal(err)
		}
		// The read seed inserted feeds 1 and 2 with explicit ids; new feeds start after them.
		if _, err := conn.Exec(context.Background(), `SELECT setval(pg_get_serial_sequence('media_feeds', 'id'), 100)`); err != nil {
			t.Fatal(err)
		}
	})
}

// send posts a request to base; user signs it with that session (and its same-origin header).
func send(t *testing.T, base, method, path, user, body string, headers map[string]string) (int, string, http.Header) {
	t.Helper()
	r, err := http.NewRequestWithContext(t.Context(), method, base+path, strings.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	if user != "" {
		r.Header.Set("Cookie", "sipges_session="+tokens[user])
		r.Header.Set("Origin", base)
	}
	for k, v := range headers {
		r.Header.Set(k, v)
	}
	res, err := http.DefaultClient.Do(r)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = res.Body.Close() }()
	b, _ := io.ReadAll(res.Body)
	answer := strings.TrimSpace(string(b)) // the shared gates' errors end with a newline
	if strings.Contains(answer, leak) || strings.Contains(answer, hashOf(secretWrite)) {
		t.Fatalf("%s %s: answer exposes a key hash: %s", method, path, answer)
	}
	return res.StatusCode, answer, res.Header
}

func hook(key string) map[string]string {
	h := map[string]string{"Content-Type": "application/json"}
	if key != "" {
		h["Authorization"] = key
	}
	return h
}

func owner(t *testing.T) *pgxpool.Pool {
	t.Helper()
	pool, err := pgxpool.New(t.Context(), scratch.URL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	return pool
}

func scalar[T any](t *testing.T, pool *pgxpool.Pool, sql string, args ...any) T {
	t.Helper()
	var v T
	if err := pool.QueryRow(t.Context(), sql, args...).Scan(&v); err != nil {
		t.Fatalf("%s: %v", sql, err)
	}
	return v
}

func TestIngestCreatesAuditedRecordsInTheKeysProjectOnly(t *testing.T) {
	base := start(t)
	runtimeSeed(t)
	db := owner(t)
	body := `[{"ID_Narrativa":"ING-RT-1","Descripcion":"Uno"},{"ID_Narrativa":"ING-RT-2","Descripcion":"Dos","Proyecto_ID":"PRJ-SECHURA"}]`
	status, answer, _ := send(t, base, "POST", "/hooks/ingest/narrativas", "", body, hook(writeKey))
	expect(t, status, answer, http.StatusCreated, `{"ok":true,"module":"narrativas","ids":["ING-RT-1","ING-RT-2"]}`)
	if n := scalar[int64](t, db, `SELECT count(*) FROM module_records WHERE tenant_id='SIPGES/PRJ-SECHURA' AND module='Narrativas' AND id LIKE 'ING-RT-%' AND payload->>'Proyecto_ID'='PRJ-SECHURA'`); n != 2 {
		t.Fatalf("records stored in the key's project: %d, want 2", n)
	}
	if n := scalar[int64](t, db, `SELECT count(*) FROM audit WHERE tenant_id='SIPGES/PRJ-SECHURA' AND module='Narrativas' AND record_id LIKE 'ING-RT-%' AND action='CREATE'`); n != 2 {
		t.Fatalf("CREATE audit rows: %d, want 2", n)
	}
	if actor := scalar[string](t, db, `SELECT actor FROM record_versions WHERE record_id='ING-RT-1'`); actor != "api:hook-escritura" {
		t.Fatalf("history actor %q, want api:hook-escritura", actor)
	}
	if used := scalar[time.Time](t, db, `SELECT last_used_at FROM api_keys WHERE id=41`); !used.Equal(t0) {
		t.Fatalf("last_used_at %v, want %v", used, t0)
	}
	// Another tenant's key writes only in its own project, and may not name another one.
	status, answer, _ = send(t, base, "POST", "/hooks/ingest/narrativas", "", `{"ID_Narrativa":"ING-RT-N","Proyecto_ID":"PRJ-SECHURA"}`, hook(norteKey))
	expect(t, status, answer, http.StatusForbidden, `{"detail":"No se permite escribir en otro proyecto","index":0}`)
	status, answer, _ = send(t, base, "POST", "/hooks/ingest/narrativas", "", `{"ID_Narrativa":"ING-RT-N","Descripcion":"Norte"}`, hook(norteKey))
	expect(t, status, answer, http.StatusCreated, `{"ok":true,"module":"narrativas","ids":["ING-RT-N"]}`)
	if tenant := scalar[string](t, db, `SELECT tenant_id FROM module_records WHERE id='ING-RT-N'`); tenant != "ACME/NORTE" {
		t.Fatalf("Norte's record stored in %q", tenant)
	}
	status, answer = get(t, base, "/api/narrativas/ING-RT-N", "multi", sechuraScope)
	expect(t, status, answer, http.StatusNotFound, `{"detail":"Registro no encontrado"}`)
	// Nothing is written when one payload of the call is refused.
	status, answer, _ = send(t, base, "POST", "/hooks/ingest/narrativas", "", `[{"ID_Narrativa":"ING-RT-X"},{}]`, hook(writeKey))
	expect(t, status, answer, http.StatusUnprocessableEntity, `{"detail":"Registro vacío","index":1}`)
	if n := scalar[int64](t, db, `SELECT count(*) FROM module_records WHERE id='ING-RT-X'`); n != 0 {
		t.Fatal("a refused call wrote a record")
	}
	// A limited key writes with its clearance; last_used_at is not refreshed within a minute.
	status, _, _ = send(t, base, "POST", "/hooks/ingest/buzon", "", `{"Asunto":"Limitada"}`, hook(limitedKey))
	if status != http.StatusCreated {
		t.Fatalf("limited key: %d", status)
	}
	if used := scalar[time.Time](t, db, `SELECT last_used_at FROM api_keys WHERE id=42`); !used.Equal(time.Date(2026, 11, 3, 10, 59, 30, 0, time.UTC)) {
		t.Fatalf("last_used_at refreshed within the touch interval: %v", used)
	}
}

func TestIngestRefusesForgedRevokedReadOnlyAndMissingKeys(t *testing.T) {
	base := start(t)
	runtimeSeed(t)
	db := owner(t)
	const invalidKey = `{"detail":"Clave de API no válida o revocada"}`
	forged := bearer("c0ffee00a001", strings.Repeat("x", 43))
	for _, c := range []struct{ name, key string }{
		{"forged secret", forged},
		{"revoked key", revokedKey},
		{"unknown prefix", bearer("c0ffee00ffff", secretWrite)},
		{"another tenant's prefix with this secret", bearer("c0ffee00b001", secretWrite)},
		{"no credential", ""},
		{"basic scheme", strings.Replace(writeKey, "Bearer", "Basic", 1)},
		{"malformed token", writeKey + "="},
	} {
		t.Run(c.name, func(t *testing.T) {
			for _, path := range []string{"/hooks/ingest/narrativas", "/hooks/signals"} {
				status, answer, header := send(t, base, "POST", path, "", `{"Descripcion":"x"}`, hook(c.key))
				expect(t, status, answer, http.StatusUnauthorized, invalidKey)
				if got := header.Get("WWW-Authenticate"); got != `Bearer realm="sipges"` {
					t.Fatalf("WWW-Authenticate %q", got)
				}
			}
		})
	}
	status, answer, _ := send(t, base, "POST", "/hooks/ingest/narrativas", "", `{"Descripcion":"x"}`, hook(readKey))
	expect(t, status, answer, http.StatusForbidden, `{"detail":"La clave es de solo lectura"}`)
	if used := scalar[*time.Time](t, db, `SELECT last_used_at FROM api_keys WHERE id=44`); used != nil {
		t.Fatal("a revoked key was touched")
	}
	// A session cookie is no credential for a webhook.
	status, answer, _ = send(t, base, "POST", "/hooks/ingest/narrativas", "multi", `{"Descripcion":"x"}`, hook(""))
	expect(t, status, answer, http.StatusUnauthorized, invalidKey)
}

func TestIngestReplaysIdempotentCallsAndRefusesOversizeBodies(t *testing.T) {
	base := start(t)
	runtimeSeed(t)
	db := owner(t)
	headers := hook(writeKey)
	headers["Idempotency-Key"] = "rt-idem-1"
	first := `{"ok":true,"module":"narrativas","ids":["NAR-RT-IDEM"]}`
	status, answer, h := send(t, base, "POST", "/hooks/ingest/narrativas", "", `{"ID_Narrativa":"NAR-RT-IDEM","Descripcion":"Uno"}`, headers)
	expect(t, status, answer, http.StatusCreated, first)
	if h.Get("Idempotent-Replayed") != "" {
		t.Fatal("first call marked as replayed")
	}
	status, answer, h = send(t, base, "POST", "/hooks/ingest/narrativas", "", `{"ID_Narrativa":"NAR-RT-IDEM","Descripcion":"Otra vez"}`, headers)
	if status != http.StatusCreated || h.Get("Idempotent-Replayed") != "true" {
		t.Fatalf("replay: %d %s %q", status, answer, h.Get("Idempotent-Replayed"))
	}
	// The stored answer comes back with jsonb's key order, as postgres.js gives it to Node.
	expect(t, status, answer, http.StatusCreated, `{"ok":true,"ids":["NAR-RT-IDEM"],"module":"narrativas"}`)
	if n := scalar[int64](t, db, `SELECT count(*) FROM module_records WHERE id LIKE 'NAR-RT-IDEM%'`); n != 1 {
		t.Fatalf("records after a replay: %d", n)
	}
	// The same idempotency key of another tenant's key is another receipt.
	norte := hook(norteKey)
	norte["Idempotency-Key"] = "rt-idem-1"
	status, _, h = send(t, base, "POST", "/hooks/ingest/narrativas", "", `{"ID_Narrativa":"NAR-RT-IDEM","Descripcion":"Norte"}`, norte)
	if status != http.StatusCreated || h.Get("Idempotent-Replayed") != "" {
		t.Fatalf("another tenant's key replayed Sechura's receipt: %d", status)
	}
	// A call still running holds the key; a refused one releases it.
	if _, err := db.Exec(t.Context(), `INSERT INTO ingest_receipts (tenant_id, key_id, idem_key, created_at) VALUES ('SIPGES/PRJ-SECHURA', 41, 'rt-running', now())`); err != nil {
		t.Fatal(err)
	}
	headers["Idempotency-Key"] = "rt-running"
	status, answer, _ = send(t, base, "POST", "/hooks/ingest/buzon", "", `{"Asunto":"x"}`, headers)
	expect(t, status, answer, http.StatusConflict, `{"detail":"Una llamada con la misma Idempotency-Key está en curso"}`)
	headers["Idempotency-Key"] = "rt-refused"
	status, _, _ = send(t, base, "POST", "/hooks/ingest/no-existe", "", `{"Asunto":"x"}`, headers)
	if status != http.StatusNotFound {
		t.Fatalf("unknown module: %d", status)
	}
	if n := scalar[int64](t, db, `SELECT count(*) FROM ingest_receipts WHERE idem_key='rt-refused'`); n != 0 {
		t.Fatal("a refused call kept its receipt")
	}
	// Oversize bodies are refused before the key is even checked, and nothing is written.
	big := `{"Asunto":"` + strings.Repeat("x", 512*1024) + `"}`
	status, answer, _ = send(t, base, "POST", "/hooks/ingest/buzon", "", big, hook(""))
	expect(t, status, answer, http.StatusRequestEntityTooLarge, `{"detail":"Cuerpo demasiado grande"}`)
	status, answer, _ = send(t, base, "POST", "/hooks/signals", "", `{"text":"`+strings.Repeat("x", 64*1024)+`"}`, hook(writeKey))
	expect(t, status, answer, http.StatusRequestEntityTooLarge, `{"detail":"Cuerpo demasiado grande"}`)
}

func TestSignalsBecomeNarrativesOnce(t *testing.T) {
	base := start(t)
	runtimeSeed(t)
	db := owner(t)
	body := `{"source_name":"Fuente sintética","source_url":"https://fuente.example/rt","external_id":"rt-1","text":"Texto sintético","observed_at":"2026-11-01T10:00:00Z","territory":"Costa"}`
	status, answer, _ := send(t, base, "POST", "/hooks/signals", "", body, hook(writeKey))
	if status != http.StatusCreated || !strings.HasPrefix(answer, `{"ok":true,"module":"narrativas","ids":["NAR-`) {
		t.Fatalf("signal: %d %s", status, answer)
	}
	status, replay, h := send(t, base, "POST", "/hooks/signals", "", body, hook(writeKey))
	if status != http.StatusCreated || h.Get("Idempotent-Replayed") != "true" {
		t.Fatalf("same signal again: %d %s", status, replay)
	}
	if n := scalar[int64](t, db, `SELECT count(*) FROM module_records WHERE payload->>'Fuente_ID_Externo'='rt-1' AND payload->>'Fuente_Integracion'='structured-hook' AND tenant_id='SIPGES/PRJ-SECHURA'`); n != 1 {
		t.Fatalf("narratives for one signal: %d", n)
	}
}

func TestMediaFeedWritesAreAuditedAndStayInTheProject(t *testing.T) {
	base := start(t)
	runtimeSeed(t)
	db := owner(t)
	feed := `{"name":"Diario RT","url":"https://rt.example/rss","keywords":[" agua ","agua"],"authorization_note":"Nota RT"}`
	status, answer, _ := send(t, base, "POST", "/system/v4/media/feeds", "multi", feed, sechuraScope)
	if status != http.StatusCreated || !strings.Contains(answer, `"name":"Diario RT","url":"https://rt.example/rss","keywords":["agua"]`) ||
		!strings.Contains(answer, `"updated_by":"multi","updated_at":"2026-11-03T11:00:00.000Z"`) {
		t.Fatalf("create: %d %s", status, answer)
	}
	id := scalar[int32](t, db, `SELECT id FROM media_feeds WHERE url='https://rt.example/rss'`)
	if n := scalar[int64](t, db, `SELECT count(*) FROM audit WHERE module='Monitoreo de medios' AND action='CONFIG_UPDATE' AND detail='Fuente agregada: Diario RT (https://rt.example/rss)' AND tenant_id='SIPGES/PRJ-SECHURA'`); n != 1 {
		t.Fatal("no audit row for the new feed")
	}
	if n := scalar[int64](t, db, `SELECT count(*) FROM automation_cursors WHERE tenant_id='SIPGES/PRJ-SECHURA'`); n != 1 {
		t.Fatal("the new feed's tenant has no automation cursor")
	}
	_, media := get(t, base, "/system/v4/media", "multi", sechuraScope)
	if !strings.Contains(media, `"name":"Diario RT"`) {
		t.Fatalf("the created feed is not listed: %s", media)
	}
	status, answer, _ = send(t, base, "POST", "/system/v4/media/feeds", "multi", feed, sechuraScope)
	expect(t, status, answer, http.StatusUnprocessableEntity, `{"detail":"Esa fuente ya está registrada"}`)
	// Feed 1 exists in both projects: Sechura's update reaches only Sechura's row.
	paused := `{"name":"Diario A","url":"https://example.org/a.xml?x=1&y=2","authorization_note":"Autorizado","enabled":false}`
	status, answer, _ = send(t, base, "PUT", "/system/v4/media/feeds/1", "multi", paused, sechuraScope)
	if status != http.StatusOK || !strings.Contains(answer, `"enabled":false`) {
		t.Fatalf("update: %d %s", status, answer)
	}
	if name := scalar[string](t, db, `SELECT name FROM media_feeds WHERE tenant_id='ACME/NORTE' AND id=1`); name != "Norte secreto" {
		t.Fatalf("Norte's feed changed: %q", name)
	}
	status, answer, _ = send(t, base, "DELETE", "/system/v4/media/feeds/"+itoa(int(id)), "multi", "", norteScope)
	expect(t, status, answer, http.StatusNotFound, `{"detail":"Fuente no encontrada"}`)
	status, answer, _ = send(t, base, "DELETE", "/system/v4/media/feeds/"+itoa(int(id)), "multi", "", sechuraScope)
	expect(t, status, answer, http.StatusOK, `{"ok":true}`)
	status, answer, _ = send(t, base, "DELETE", "/system/v4/media/feeds/"+itoa(int(id)), "multi", "", sechuraScope)
	expect(t, status, answer, http.StatusNotFound, `{"detail":"Fuente no encontrada"}`)
	// Writes are admin only, need the Origin of a same-site page, and refuse oversize bodies.
	status, answer, _ = send(t, base, "POST", "/system/v4/media/feeds", "solo", feed, nil)
	expect(t, status, answer, http.StatusForbidden, adminOnly)
	status, answer, _ = send(t, base, "POST", "/system/v4/media/feeds", "multi", `{"name":"`+strings.Repeat("x", 9000)+`"}`, sechuraScope)
	expect(t, status, answer, http.StatusRequestEntityTooLarge, `{"detail":"Cuerpo demasiado grande"}`)
	// The project limit counts only the project's own feeds.
	for i := 0; i < domain.MaxFeeds; i++ {
		send(t, base, "POST", "/system/v4/media/feeds", "multi", `{"name":"F","url":"https://limite.example/`+itoa(i)+`","authorization_note":"N"}`, norteScope)
	}
	status, answer, _ = send(t, base, "POST", "/system/v4/media/feeds", "multi", `{"name":"F","url":"https://limite.example/x","authorization_note":"N"}`, norteScope)
	expect(t, status, answer, http.StatusUnprocessableEntity, `{"detail":"Máximo 20 fuentes por proyecto"}`)
	if _, err := db.Exec(t.Context(), `DELETE FROM media_feeds WHERE url LIKE 'https://limite.example/%'`); err != nil {
		t.Fatal(err)
	}
}

func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	s := ""
	for ; n > 0; n /= 10 {
		s = string(rune('0'+n%10)) + s
	}
	return s
}

func TestSourceConfigurationAndKeyRevocation(t *testing.T) {
	base := start(t)
	runtimeSeed(t)
	db := owner(t)
	config := `{"enabled":true,"query":" minería ","territory":"Norte","authorization_note":"Convenio RT"}`
	status, answer, _ := send(t, base, "PUT", "/system/intelligence/sources/defensoria/config", "multi", config, norteScope)
	expect(t, status, answer, http.StatusOK, `{"enabled":true,"query":"minería","territory":"Norte","authorization_note":"Convenio RT","revision":1,"updated_by":"multi","updated_at":"2026-11-03T11:00:00.000Z","last_poll_at":null,"last_poll_error":"","last_imported":0,"last_duplicates":0}`)
	status, answer, _ = send(t, base, "PUT", "/system/intelligence/sources/defensoria/config", "multi", config, norteScope)
	if status != http.StatusOK || !strings.Contains(answer, `"revision":2`) {
		t.Fatalf("second save: %d %s", status, answer)
	}
	if n := scalar[int64](t, db, `SELECT count(*) FROM automation_cursors WHERE tenant_id='ACME/NORTE'`); n != 1 {
		t.Fatal("enabling the connector did not register the tenant's cursor")
	}
	_, catalog := get(t, base, "/system/intelligence/sources", "multi", norteScope)
	if !strings.Contains(catalog, `"query":"minería","territory":"Norte"`) {
		t.Fatalf("the saved settings are not read back: %s", catalog)
	}
	_, catalog = get(t, base, "/system/intelligence/sources", "multi", sechuraScope)
	if catalog != sourcesSechura {
		t.Fatalf("Sechura's settings changed: %s", catalog)
	}
	status, answer, _ = send(t, base, "PUT", "/system/intelligence/sources/defensoria/config", "multi", `{"enabled":true}`, norteScope)
	expect(t, status, answer, http.StatusBadRequest, `{"detail":"Se requiere una nota de autorización explícita"}`)
	status, answer, _ = send(t, base, "PUT", "/system/intelligence/sources/defensoria/config", "reader", config, nil)
	expect(t, status, answer, http.StatusForbidden, `{"detail":"Rol de consulta: solo lectura"}`)

	// Revocation: only the active project's key, audited, and the key stops working at once.
	status, answer, _ = send(t, base, "DELETE", "/system/integrations/api-keys/51", "multi", "", sechuraScope)
	expect(t, status, answer, http.StatusNotFound, `{"detail":"Clave no encontrada"}`)
	if revoked := scalar[*time.Time](t, db, `SELECT revoked_at FROM api_keys WHERE id=51`); revoked != nil {
		t.Fatal("Sechura revoked Norte's key")
	}
	status, answer, _ = send(t, base, "DELETE", "/system/integrations/api-keys/45", "solo", "", nil)
	expect(t, status, answer, http.StatusForbidden, adminOnly)
	status, answer, _ = send(t, base, "DELETE", "/system/integrations/api-keys/45", "multi", "", sechuraScope)
	expect(t, status, answer, http.StatusOK, `{"ok":true}`)
	if detail := scalar[string](t, db, `SELECT detail FROM audit WHERE tenant_id='SIPGES/PRJ-SECHURA' AND module='Integraciones' AND record_id='clave-45' AND action='DELETE'`); detail != "Clave de API «hook-a-revocar» revocada" {
		t.Fatalf("revocation audit %q", detail)
	}
	status, _, _ = send(t, base, "POST", "/hooks/ingest/buzon", "", `{"Asunto":"x"}`, hook(revokeMe))
	if status != http.StatusUnauthorized {
		t.Fatalf("a revoked key still writes: %d", status)
	}
	status, answer, _ = send(t, base, "DELETE", "/system/integrations/api-keys/45", "multi", "", sechuraScope)
	expect(t, status, answer, http.StatusNotFound, `{"detail":"Clave no encontrada"}`)
}

// ---- Feeds and the Defensoría, with fake gateways ----

type stubFeeds struct{ xml string }

func (s stubFeeds) Read(_ context.Context, url string) ([]domain.FeedItem, error) {
	if strings.Contains(url, "caida") {
		return nil, &domain.FeedError{Code: domain.FeedTimeout}
	}
	return domain.ParseFeed(s.xml), nil
}

type stubOfficial struct{}

func (stubOfficial) Preview(context.Context, string) ([]domain.OfficialPost, error) {
	return posts, nil
}

func (stubOfficial) Get(ctx context.Context, id int) (domain.OfficialPost, error) {
	return fakeOfficial{}.Get(ctx, id)
}

// runtimeHandler is the composed pipeline (session, source body limit, project scope, role gate)
// with the runtime over the real SQL stores and fake gateways.
func runtimeHandler(t *testing.T) (string, application.Runtime) {
	t.Helper()
	pool := owner(t)
	now := func() time.Time { return t0 }
	clock := application.Clock(now)
	store := recordssql.Records{DB: pool}
	importer := application.Importer{Store: store, Clock: clock}
	xml := `<rss><item><title>Agua en la Costa</title><link>https://rt.example/1</link><guid>rt-1</guid><pubDate>Mon, 02 Nov 2026 23:30:00 -0500</pubDate></item><item><title>Otra cosa</title><link>https://rt.example/2</link></item></rss>`
	media := application.Media{Feeds: integrationsql.Feeds{DB: pool}, Gateway: stubFeeds{xml}, Importer: importer, Clock: clock}
	sources := application.Sources{Gateway: stubOfficial{}, Settings: integrationsql.Settings{DB: pool}, Importer: importer, Clock: clock}
	rt := integrationhttp.Runtime{
		Keys: application.Keys{Store: integrationsql.Keys{DB: pool}, Clock: clock},
		Ingest: application.Ingest{
			Records:  recordsapp.Writes{Store: store, Now: now, RandomHex: func(n int) string { return strings.Repeat("A", n) }},
			Receipts: integrationsql.Receipts{DB: pool}, Clock: clock,
		},
		Media: media, Sources: sources,
	}
	grants := tenancyapp.NewGrantCache(tenancysql.Grants{DB: pool}.List, now)
	h := httpx.NewHandler(httpx.Options{
		Logger: slog.New(slog.DiscardHandler),
		Auth: []httpx.Middleware{
			identityhttp.Session(identityhttp.SessionOptions{Sessions: identitysql.Sessions{DB: pool, Now: now}, RequireMFA: true}),
			integrationhttp.RequestLimit(),
			tenancyhttp.Middleware(grants, nil),
			identityhttp.RoleGate(),
		},
		Routes: func(mux *http.ServeMux) { integrationhttp.RegisterRuntime(mux, rt) },
	})
	srv := httptest.NewServer(h)
	t.Cleanup(srv.Close)
	return srv.URL, application.Runtime{Sources: sources, Media: media}
}

func TestPollsImportNarrativesOnceAndRecordTheOutcome(t *testing.T) {
	if scratch == nil {
		t.Skip(dbtestEnv)
	}
	base, runtime := runtimeHandler(t)
	db := owner(t)
	// A Norte feed matching "agua", one that fails, and the preview of a feed.
	for _, f := range []string{
		`{"name":"Poll RT","url":"https://poll.example/rss","keywords":["agua"],"territory":"Norte","authorization_note":"N"}`,
		`{"name":"Caída","url":"https://caida.example/rss","authorization_note":"N"}`,
	} {
		if status, answer, _ := send(t, base, "POST", "/system/v4/media/feeds", "multi", f, norteScope); status != http.StatusCreated {
			t.Fatalf("create: %d %s", status, answer)
		}
	}
	status, answer, _ := send(t, base, "POST", "/system/v4/media/preview", "multi", `{"url":"https://poll.example/rss","keywords":["costa"]}`, norteScope)
	if status != http.StatusOK || !strings.Contains(answer, `"total":2`) || !strings.Contains(answer, `"matched":["costa"]`) {
		t.Fatalf("preview: %d %s", status, answer)
	}
	status, answer, _ = send(t, base, "POST", "/system/v4/media/poll", "multi", "", norteScope)
	if status != http.StatusOK || !strings.HasPrefix(answer, `{"feeds":`) || !strings.Contains(answer, `"imported":1`) {
		t.Fatalf("poll: %d %s", status, answer)
	}
	payload := scalar[string](t, db, `SELECT payload::text FROM module_records WHERE tenant_id='ACME/NORTE' AND module='Narrativas' AND payload->>'Fuente_Integracion'='rss'`)
	for _, want := range []string{`"Tema": "agua"`, `"Territorio": "Norte"`, `"Fecha_Observacion": "2026-11-02"`, `"Fuente_Publicada_En": "2026-11-03T04:30:00.000Z"`} {
		if !strings.Contains(payload, want) {
			t.Fatalf("imported narrative lacks %s: %s", want, payload)
		}
	}
	if e := scalar[string](t, db, `SELECT last_poll_error FROM media_feeds WHERE url='https://caida.example/rss'`); e != "La fuente no respondió a tiempo." {
		t.Fatalf("failed feed records %q", e)
	}
	// Polling again finds the same item: a duplicate, not a second narrative.
	_, answer, _ = send(t, base, "POST", "/system/v4/media/poll", "multi", "", norteScope)
	if !strings.Contains(answer, `"imported":0,"duplicates":1`) {
		t.Fatalf("second poll: %s", answer)
	}
	// The Defensoría: import once, then the same post again is a duplicate.
	status, answer, _ = send(t, base, "POST", "/system/intelligence/sources/defensoria/import", "multi", `{"post_id":101,"territory":"Norte"}`, norteScope)
	expect(t, status, answer, http.StatusCreated, `{"id":"SRC-DEF-101-8b5a482686d9324b","created":true}`)
	status, answer, _ = send(t, base, "POST", "/system/intelligence/sources/defensoria/import", "multi", `{"post_id":101}`, norteScope)
	expect(t, status, answer, http.StatusOK, `{"id":"SRC-DEF-101-8b5a482686d9324b","created":false}`)
	if actor := scalar[string](t, db, `SELECT actor FROM record_versions WHERE record_id='SRC-DEF-101-8b5a482686d9324b'`); actor != "multi" {
		t.Fatalf("import actor %q", actor)
	}
	if n := scalar[int64](t, db, `SELECT count(*) FROM module_records WHERE id LIKE 'SRC-DEF-%' AND tenant_id<>'ACME/NORTE'`); n != 0 {
		t.Fatal("the import leaked into another project")
	}

	// The cron hook, as the automation actor: the enabled connector imports the other post
	// (101 is a duplicate); no feed is due, as both were polled just now.
	config := `{"enabled":true,"query":"agua","territory":"Norte","authorization_note":"Convenio RT"}`
	if status, answer, _ := send(t, base, "PUT", "/system/intelligence/sources/defensoria/config", "multi", config, norteScope); status != http.StatusOK {
		t.Fatalf("config: %d %s", status, answer)
	}
	if err := runtime.BeforeTick(t.Context(), "ACME/NORTE"); err != nil {
		t.Fatalf("before tick: %v", err)
	}
	if n := scalar[int64](t, db, `SELECT count(*) FROM module_records WHERE tenant_id='ACME/NORTE' AND payload->>'Fuente_Integracion'='rss'`); n != 1 {
		t.Fatalf("rss narratives: %d", n)
	}
	if actor := scalar[string](t, db, `SELECT actor FROM record_versions WHERE record_id LIKE 'SRC-DEF-2147483647-%'`); actor != "automation" {
		t.Fatalf("cron import actor %q", actor)
	}
	state := scalar[string](t, db, `SELECT last_imported || '/' || last_duplicates || '/' || last_poll_error FROM source_import_settings WHERE tenant_id='ACME/NORTE'`)
	if state != "1/1/" {
		t.Fatalf("connector outcome %q, want 1 imported, 1 duplicate, no error", state)
	}
	active, err := runtime.ActiveTenants(t.Context())
	if err != nil || !slices.Contains(active, "ACME/NORTE") {
		t.Fatalf("active tenants %v %v", active, err)
	}
	// A second tick inside 15 minutes is skipped.
	if err := runtime.BeforeTick(t.Context(), "ACME/NORTE"); err != nil {
		t.Fatalf("second tick: %v", err)
	}
	if n := scalar[int64](t, db, `SELECT count(*) FROM module_records WHERE tenant_id='ACME/NORTE' AND id LIKE 'SRC-DEF-%'`); n != 2 {
		t.Fatalf("defensoría narratives: %d", n)
	}
}

const dbtestEnv = "SIPGES_TEST_DATABASE_URL is not set"

var _ = database.ClearanceFull
