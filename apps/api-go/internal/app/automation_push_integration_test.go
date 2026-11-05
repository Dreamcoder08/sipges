package app_test

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/Dreamcoder08/sipges/apps/api-go/internal/app"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/identity/infrastructure"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/platform/database/dbtest"
)

// The /system/notifications/push routes through the composed handler, on a scratch database,
// with the real sender and a transport double: no request reaches a push service.

const (
	pushPublic  = "BHS-uwl3nFpzgNoW0kjmSZB4-vUfabJkKg8ysBCV9GIZIzv22PTxzM0uQcgahdjwpxOaPcnfVtaILHUT6mAyu8o"
	pushPrivate = "Hxm3lKNdyp0lyYD4wbrlQmxH0T0mWnqeVdhx3-OrMEQ"
	pushP256dh  = "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4"
	pushAuth    = "BTBZMqHH6r4Tts7J_aSIgg"
)

func pushEndpoint(device string) string {
	return "https://fcm.googleapis.com/fcm/send/synthetic-" + device
}

func subscription(device string) string {
	return `{"endpoint":"` + pushEndpoint(device) + `","keys":{"p256dh":"` + pushP256dh + `","auth":"` + pushAuth + `"}}`
}

type pushService struct {
	mu     sync.Mutex
	seen   []string
	status map[string]int
	broken map[string]bool
}

func (p *pushService) RoundTrip(r *http.Request) (*http.Response, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.seen = append(p.seen, r.URL.String())
	if p.broken[r.URL.String()] {
		return nil, errors.New("synthetic dial failure")
	}
	status, ok := p.status[r.URL.String()]
	if !ok {
		status = http.StatusCreated
	}
	return &http.Response{StatusCode: status, Body: io.NopCloser(strings.NewReader("")), Header: http.Header{}, Request: r}, nil
}

func (p *pushService) requests() []string {
	p.mu.Lock()
	defer p.mu.Unlock()
	return append([]string(nil), p.seen...)
}

type pushEnv struct {
	base    string
	pool    *pgxpool.Pool
	tokens  map[string]string
	service *pushService
	logs    *syncBuffer
}

type syncBuffer struct {
	mu sync.Mutex
	b  bytes.Buffer
}

func (s *syncBuffer) Write(p []byte) (int, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.b.Write(p)
}

func (s *syncBuffer) String() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.b.String()
}

func startPush(t *testing.T, configured bool) pushEnv {
	t.Helper()
	adminURL := os.Getenv(dbtest.EnvAdminURL)
	if adminURL == "" {
		t.Skip(dbtest.EnvAdminURL + " is not set")
	}
	s, err := dbtest.NewScratch(t.Context(), adminURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = s.Drop(context.Background()) })
	conn, err := pgx.Connect(t.Context(), s.URL)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = conn.Close(context.Background()) }()
	if _, err := conn.Exec(t.Context(), `
		INSERT INTO tenants (company_id, project_id, label) VALUES ('SIPGES','PRJ-SECHURA','Sechura'), ('ACME','NORTE','Norte');
		INSERT INTO users (username, full_name, password_hash, role, active, totp_enabled) VALUES
		  ('boss', 'Admin', 'x', 'admin', true, true), ('reader', 'Lector', 'x', 'consulta', true, true);
		INSERT INTO grants (username, tenant_id) VALUES ('boss','SIPGES/PRJ-SECHURA'), ('reader','SIPGES/PRJ-SECHURA');`); err != nil {
		t.Fatal(err)
	}
	env := pushEnv{tokens: map[string]string{}, service: &pushService{status: map[string]int{}, broken: map[string]bool{}}, logs: &syncBuffer{}}
	for _, user := range []string{"boss", "reader"} {
		var b [32]byte
		_, _ = rand.Read(b[:])
		env.tokens[user] = hex.EncodeToString(b[:])
		if _, err := conn.Exec(t.Context(), `INSERT INTO sessions (token_hash, username, expires_at) VALUES ($1, $2, $3)`,
			infrastructure.HashToken(env.tokens[user]), user, time.Now().Add(8*time.Hour)); err != nil {
			t.Fatal(err)
		}
	}
	if configured {
		t.Setenv("SIPGES_VAPID_PUBLIC_KEY", pushPublic)
		t.Setenv("SIPGES_VAPID_PRIVATE_KEY", pushPrivate)
		t.Setenv("SIPGES_VAPID_SUBJECT", "mailto:ops@example.org")
	}
	t.Cleanup(app.SetPushTransport(env.service))
	env.pool, err = pgxpool.New(t.Context(), s.URL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(env.pool.Close)
	h, err := app.NewHandler(env.pool, app.Options{Logger: slog.New(slog.NewJSONHandler(env.logs, nil))})
	if err != nil {
		t.Fatal(err)
	}
	srv := httptest.NewServer(h)
	t.Cleanup(srv.Close)
	env.base = srv.URL
	return env
}

func (e pushEnv) do(t *testing.T, method, path, user, body string) (int, string) {
	t.Helper()
	r, err := http.NewRequestWithContext(t.Context(), method, e.base+path, strings.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	if user != "" {
		r.Header.Set("Cookie", "sipges_session="+e.tokens[user])
	}
	r.Header.Set("Origin", e.base)
	r.Header.Set("Content-Type", "application/json")
	res, err := http.DefaultClient.Do(r)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = res.Body.Close() }()
	b, _ := io.ReadAll(res.Body)
	return res.StatusCode, string(b)
}

func (e pushEnv) count(t *testing.T, sql string) int64 {
	t.Helper()
	var n int64
	if err := e.pool.QueryRow(t.Context(), sql).Scan(&n); err != nil {
		t.Fatal(err)
	}
	return n
}

func pushExpect(t *testing.T, gotStatus int, gotBody string, wantStatus int, wantBody string) {
	t.Helper()
	if gotStatus != wantStatus || gotBody != wantBody {
		t.Fatalf("got %d %s\nwant %d %s", gotStatus, gotBody, wantStatus, wantBody)
	}
}

const (
	pushPath      = "/system/notifications/push"
	pushTestPath  = "/system/notifications/push/test"
	pushStatePath = "/system/notifications/push/state"
	pushDropPath  = "/system/notifications/push/unsubscribe"
)

func TestPushStaysOffWithoutVapidKeys(t *testing.T) {
	e := startPush(t, false)
	status, body := e.do(t, "GET", pushPath, "boss", "")
	pushExpect(t, status, body, 200, `{"enabled":false,"public_key":null}`)
	status, body = e.do(t, "GET", pushStatePath, "boss", "")
	pushExpect(t, status, body, 200, `{"configured":false,"subscriptions":0,"receipt_confirmed":false}`)
	status, body = e.do(t, "POST", pushPath, "boss", subscription("a"))
	pushExpect(t, status, body, 409, `{"detail":"Las notificaciones en dispositivos no están configuradas"}`)
	status, body = e.do(t, "POST", pushTestPath, "boss", "")
	pushExpect(t, status, body, 502, `{"status":"failed","accepted":0,"detail":"Push no configurado"}`)
	status, body = e.do(t, "POST", pushDropPath, "boss", `{"endpoint":"`+pushEndpoint("a")+`"}`)
	pushExpect(t, status, body, 200, `{"ok":true}`)
	if n := e.count(t, `SELECT count(*) FROM push_subscriptions`); n != 0 {
		t.Fatalf("%d subscriptions saved", n)
	}
	if len(e.service.requests()) != 0 {
		t.Fatal("a push was sent with push off")
	}
}

func TestPushSubscriptionsBelongToTheirUser(t *testing.T) {
	e := startPush(t, true)
	status, body := e.do(t, "GET", pushPath, "reader", "")
	pushExpect(t, status, body, 200, `{"enabled":true,"public_key":"`+pushPublic+`"}`)
	status, body = e.do(t, "POST", pushPath, "reader", subscription("a"))
	pushExpect(t, status, body, 200, `{"ok":true}`)
	status, body = e.do(t, "POST", pushPath, "boss", subscription("b"))
	pushExpect(t, status, body, 200, `{"ok":true}`)
	status, body = e.do(t, "GET", pushStatePath, "reader", "")
	pushExpect(t, status, body, 200, `{"configured":true,"subscriptions":1,"receipt_confirmed":false}`)

	// Unsubscribing someone else's device removes nothing.
	status, body = e.do(t, "POST", pushDropPath, "reader", `{"endpoint":"`+pushEndpoint("b")+`"}`)
	pushExpect(t, status, body, 200, `{"ok":true}`)
	if n := e.count(t, `SELECT count(*) FROM push_subscriptions WHERE username = 'boss'`); n != 1 {
		t.Fatalf("%d subscriptions of boss", n)
	}
	status, body = e.do(t, "POST", pushDropPath, "reader", `{"endpoint":"`+pushEndpoint("a")+`"}`)
	pushExpect(t, status, body, 200, `{"ok":true}`)
	if n := e.count(t, `SELECT count(*) FROM push_subscriptions WHERE username = 'reader'`); n != 0 {
		t.Fatalf("%d subscriptions of reader", n)
	}

	// The device changes hands: the latest session's user owns the endpoint.
	status, body = e.do(t, "POST", pushPath, "reader", subscription("b"))
	pushExpect(t, status, body, 200, `{"ok":true}`)
	if n := e.count(t, `SELECT count(*) FROM push_subscriptions WHERE username = 'reader' AND endpoint LIKE '%-b'`); n != 1 {
		t.Fatalf("%d subscriptions moved", n)
	}
}

func TestPushRefusesWhatItCannotDeliverTo(t *testing.T) {
	e := startPush(t, true)
	const invalid = `{"detail":"Suscripción de notificaciones no válida"}`
	for name, body := range map[string]string{
		"not a push service": `{"endpoint":"https://evil.example/x","keys":{"p256dh":"` + pushP256dh + `","auth":"` + pushAuth + `"}}`,
		"metadata address":   `{"endpoint":"https://169.254.169.254/latest","keys":{"p256dh":"` + pushP256dh + `","auth":"` + pushAuth + `"}}`,
		"short key":          `{"endpoint":"` + pushEndpoint("a") + `","keys":{"p256dh":"abc","auth":"` + pushAuth + `"}}`,
		"short auth":         `{"endpoint":"` + pushEndpoint("a") + `","keys":{"p256dh":"` + pushP256dh + `","auth":"abc"}}`,
		"padded auth":        `{"endpoint":"` + pushEndpoint("a") + `","keys":{"p256dh":"` + pushP256dh + `","auth":"BTBZMqHH6r4Tts7J_aSIgg=="}}`,
	} {
		t.Run(name, func(t *testing.T) {
			status, got := e.do(t, "POST", pushPath, "boss", body)
			pushExpect(t, status, got, 422, invalid)
		})
	}
	status, body := e.do(t, "POST", pushPath, "boss", `{}`)
	if status != 422 || !strings.Contains(body, `"loc":["body","endpoint"]`) {
		t.Fatalf("got %d %s", status, body)
	}
	if n := e.count(t, `SELECT count(*) FROM push_subscriptions`); n != 0 {
		t.Fatalf("%d subscriptions saved", n)
	}
}

func TestPushTestReachesOnlyTheCallersDevices(t *testing.T) {
	e := startPush(t, true)
	status, body := e.do(t, "POST", pushTestPath, "reader", "")
	pushExpect(t, status, body, 200, `{"status":"no_subscription","accepted":0,"detail":"No hay dispositivos suscritos para tu usuario"}`)
	if n := e.count(t, `SELECT count(*) FROM audit WHERE action = 'PUSH_SEND'`); n != 0 {
		t.Fatalf("%d audit rows without a device", n)
	}
	e.do(t, "POST", pushPath, "reader", subscription("a"))
	e.do(t, "POST", pushPath, "boss", subscription("b"))
	status, body = e.do(t, "POST", pushTestPath, "reader", "")
	pushExpect(t, status, body, 200, `{"status":"accepted","accepted":1,"detail":"El proveedor aceptó la prueba. La recepción en el dispositivo aún debe confirmarse."}`)
	if got := e.service.requests(); len(got) != 1 || got[0] != pushEndpoint("a") {
		t.Fatalf("sent to %v", got)
	}
	if n := e.count(t, `SELECT count(*) FROM audit WHERE module = 'Automatizaciones' AND action = 'PUSH_SEND' AND record_id IS NULL AND detail = 'Prueba de push · 1 aceptados · 0 fallidos' AND tenant_id = 'SIPGES/PRJ-SECHURA'`); n != 1 {
		t.Fatalf("%d audit rows", n)
	}
}

func TestPushTestForgetsDevicesTheServiceDropped(t *testing.T) {
	e := startPush(t, true)
	e.do(t, "POST", pushPath, "boss", subscription("kept"))
	e.do(t, "POST", pushPath, "boss", subscription("gone"))
	e.service.status[pushEndpoint("gone")] = http.StatusGone
	status, body := e.do(t, "POST", pushTestPath, "boss", "")
	pushExpect(t, status, body, 502, `{"status":"failed","accepted":1,"detail":"Uno o más proveedores rechazaron la prueba; revisa tu suscripción"}`)
	if n := e.count(t, `SELECT count(*) FROM push_subscriptions WHERE endpoint LIKE '%-gone'`); n != 0 {
		t.Fatal("the dropped device stayed subscribed")
	}
	if n := e.count(t, `SELECT count(*) FROM push_subscriptions WHERE endpoint LIKE '%-kept'`); n != 1 {
		t.Fatal("the working device was forgotten")
	}
	if n := e.count(t, `SELECT count(*) FROM audit WHERE detail = 'Prueba de push · 1 aceptados · 1 fallidos'`); n != 1 {
		t.Fatalf("%d audit rows", n)
	}
}

func TestPushFailuresShowNoEndpointKeyOrPayload(t *testing.T) {
	e := startPush(t, true)
	e.do(t, "POST", pushPath, "boss", subscription("offline"))
	e.do(t, "POST", pushPath, "boss", subscription("rejected"))
	e.service.broken[pushEndpoint("offline")] = true
	e.service.status[pushEndpoint("rejected")] = http.StatusInternalServerError
	status, body := e.do(t, "POST", pushTestPath, "boss", "")
	pushExpect(t, status, body, 502, `{"status":"failed","accepted":0,"detail":"Uno o más proveedores rechazaron la prueba; revisa tu suscripción"}`)
	if n := e.count(t, `SELECT count(*) FROM push_subscriptions`); n != 2 {
		t.Fatalf("a failed send forgot a device: %d left", n)
	}
	logged := e.logs.String()
	for _, value := range []string{"synthetic-offline", "synthetic-rejected", pushP256dh, pushAuth, pushPrivate, "Prueba de SIPGES"} {
		if strings.Contains(body, value) || strings.Contains(logged, value) {
			t.Fatalf("%s leaked", value)
		}
	}
}

func TestPushRoutesKeepTheGates(t *testing.T) {
	e := startPush(t, true)
	for _, c := range []struct{ method, path string }{
		{"GET", pushPath}, {"GET", pushStatePath}, {"POST", pushPath}, {"POST", pushTestPath}, {"POST", pushDropPath},
	} {
		if status, _ := e.do(t, c.method, c.path, "", subscription("a")); status != 401 {
			t.Fatalf("%s %s without a session: %d", c.method, c.path, status)
		}
	}
	if n := e.count(t, `SELECT count(*) FROM push_subscriptions`); n != 0 {
		t.Fatalf("%d subscriptions saved without a session", n)
	}
}

func (e pushEnv) queueDelivery(t *testing.T, device string) {
	t.Helper()
	if status, body := e.do(t, "POST", pushPath, "boss", subscription(device)); status != 200 && status != 409 {
		t.Fatalf("subscribe: %d %s", status, body)
	}
	if _, err := e.pool.Exec(t.Context(), `INSERT INTO push_subscriptions (endpoint, username, p256dh, auth, created_at)
		VALUES ($1, 'boss', $2, $3, now()) ON CONFLICT (endpoint) DO NOTHING`, pushEndpoint(device), pushP256dh, pushAuth); err != nil {
		t.Fatal(err)
	}
	if _, err := e.pool.Exec(t.Context(), `WITH n AS (INSERT INTO notifications (tenant_id, title, body, marking, created_at)
		VALUES ('SIPGES/PRJ-SECHURA', 'Aviso', '', 'interno', now()) RETURNING id)
		INSERT INTO push_deliveries (tenant_id, notification_id, endpoint, username, restricted, payload, next_attempt_at)
		SELECT 'SIPGES/PRJ-SECHURA', n.id, $1, 'boss', false, '{"title":"Aviso","body":"","url":"/"}', now() FROM n`, pushEndpoint(device)); err != nil {
		t.Fatal(err)
	}
}

func TestTheComposedTickDeliversWithVapidKeys(t *testing.T) {
	e := startPush(t, true)
	e.queueDelivery(t, "a")
	if status, body := e.do(t, "POST", "/system/automations/tick", "boss", ""); status != 200 {
		t.Fatalf("tick: %d %s", status, body)
	}
	if got := e.service.requests(); len(got) != 1 || got[0] != pushEndpoint("a") {
		t.Fatalf("sent to %v", got)
	}
	if n := e.count(t, `SELECT count(*) FROM push_deliveries WHERE status = 'accepted'`); n != 1 {
		t.Fatalf("%d accepted", n)
	}
}

func TestTheComposedTickLeavesPushesForTypeScriptWithoutKeys(t *testing.T) {
	e := startPush(t, false)
	e.queueDelivery(t, "a")
	if status, body := e.do(t, "POST", "/system/automations/tick", "boss", ""); status != 200 {
		t.Fatalf("tick: %d %s", status, body)
	}
	if len(e.service.requests()) != 0 {
		t.Fatal("a push went out without keys")
	}
	if n := e.count(t, `SELECT count(*) FROM push_deliveries WHERE status = 'pending' AND attempts = 0`); n != 1 {
		t.Fatalf("%d untouched deliveries", n)
	}
}
