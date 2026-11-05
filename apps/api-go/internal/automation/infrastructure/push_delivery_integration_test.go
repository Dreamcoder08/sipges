package infrastructure_test

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"os"
	"regexp"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/Dreamcoder08/sipges/apps/api-go/internal/automation/application"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/automation/infrastructure"
)

// Browser push delivery on PostgreSQL, with a double for the push service.

const typeScriptPushStore = "../../../../api/src/contexts/automation/infrastructure/sql-push-store.ts"

var typeScriptPushClaim = regexp.MustCompile("(?s)`(WITH due AS\\(.*?)`")

// claimingPushLikeTypeScript claims with the statement apps/api runs, read from its source.
type claimingPushLikeTypeScript struct {
	infrastructure.PushOutbox
	sql string
}

func (c claimingPushLikeTypeScript) Claim(ctx context.Context, tenantID string, at, leaseUntil time.Time) ([]application.PushDelivery, error) {
	return infrastructure.ClaimPushWith(ctx, c.DB, c.sql, tenantID, at, leaseUntil)
}

type sentPush struct {
	endpoint string
	payload  application.PushPayload
}

// pushDouble stands for FCM, Mozilla, Apple and WNS: none of them deduplicates.
type pushDouble struct {
	mu   sync.Mutex
	sent []sentPush
	gone map[string]bool
	err  error
}

func (*pushDouble) PublicKey() string { return "synthetic" }

func (p *pushDouble) Send(ctx context.Context, s application.PushSubscription, payload application.PushPayload, _ time.Time) (application.PushResult, error) {
	select {
	case <-time.After(time.Millisecond): // long enough for another runner to try the same row
	case <-ctx.Done():
		return 0, ctx.Err()
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.err != nil {
		return 0, p.err
	}
	p.sent = append(p.sent, sentPush{s.Endpoint, payload})
	if p.gone[s.Endpoint] {
		return application.PushGone, nil
	}
	return application.PushSent, nil
}

func pushing(pool *pgxpool.Pool, c *clock, double *pushDouble) application.Service {
	s := service(pool, c)
	s.Push = infrastructure.PushOutbox{DB: pool}
	s.Deliveries = infrastructure.PushOutbox{DB: pool}
	s.Subscriptions = infrastructure.Subscriptions{DB: pool}
	s.PushSender = double
	return s
}

func subscribe(t *testing.T, pool *pgxpool.Pool, username, role, device string) string {
	t.Helper()
	endpoint := "https://fcm.googleapis.com/fcm/send/synthetic-" + device
	const key = "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4"
	if _, err := pool.Exec(t.Context(), `INSERT INTO users (username, full_name, password_hash, role, active, totp_enabled)
		VALUES ($1, $1, 'x', $2, true, true) ON CONFLICT (username) DO NOTHING`, username, role); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(t.Context(), `INSERT INTO grants (username, tenant_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`, username, tenant); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(t.Context(), `INSERT INTO push_subscriptions (endpoint, username, p256dh, auth, created_at)
		VALUES ($1, $2, $3, 'BTBZMqHH6r4Tts7J_aSIgg', now())`, endpoint, username, key); err != nil {
		t.Fatal(err)
	}
	return endpoint
}

func TestTickDeliversEachQueuedPush(t *testing.T) {
	pool := scratchPool(t, tenant)
	c := &clock{now: time.Date(2026, 11, 5, 12, 0, 0, 0, time.UTC)}
	double := &pushDouble{}
	s := pushing(pool, c, double)
	endpoint := subscribe(t, pool, "persona", "analista", "a")
	saveRule(t, s, tenant, notifyRule("Aviso interno", "Eventos"))
	audit(t, pool, tenant, c.now.Add(-5*time.Minute), "Eventos", "EV-1", "CREATE")
	if _, err := s.Tick(t.Context(), tenant); err != nil {
		t.Fatal(err)
	}
	if len(double.sent) != 1 || double.sent[0].endpoint != endpoint || double.sent[0].payload.Title == "" {
		t.Fatalf("sent %d pushes", len(double.sent))
	}
	if n := scalar(t, pool, tenant, `SELECT count(*) FROM push_deliveries WHERE status = 'accepted' AND attempts = 1 AND last_error = ''`); n != 1 {
		t.Fatalf("%d accepted deliveries", n)
	}
	if n := scalar(t, pool, tenant, `SELECT count(*) FROM audit WHERE module = 'Automatizaciones' AND action = 'PUSH_SEND' AND detail LIKE 'Envío push · entrega % · aceptado'`); n != 1 {
		t.Fatalf("%d push audits", n)
	}
	// A later tick sends nothing again.
	c.Add(10 * time.Minute)
	if _, err := s.Tick(t.Context(), tenant); err != nil {
		t.Fatal(err)
	}
	if len(double.sent) != 1 {
		t.Fatalf("sent %d pushes after a second tick", len(double.sent))
	}
}

func TestTickSkipsWhoCanNoLongerReceiveThePush(t *testing.T) {
	pool := scratchPool(t, tenant)
	c := &clock{now: time.Date(2026, 11, 5, 12, 0, 0, 0, time.UTC)}
	double := &pushDouble{}
	s := pushing(pool, c, double)
	reader := subscribe(t, pool, "lector", "consulta", "reader")
	former := subscribe(t, pool, "exagente", "analista", "former")
	demoted := subscribe(t, pool, "degradada", "analista", "demoted")
	kept := subscribe(t, pool, "persona", "analista", "kept")
	payload := application.PushPayload{Title: "Reservado", Body: "Sintético", URL: "/"}
	for id, marking := range map[int64]string{1: "restringido", 2: "interno"} {
		notification := scalar(t, pool, tenant, fmt.Sprintf(`INSERT INTO notifications (tenant_id, title, body, marking, created_at) VALUES ('%s', 'N%d', '', '%s', now()) RETURNING id`, tenant, id, marking))
		if err := s.Push.Enqueue(t.Context(), tenant, notification, marking == "restringido", payload, c.now); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := pool.Exec(t.Context(), `UPDATE users SET active = false WHERE username = 'exagente'`); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(t.Context(), `UPDATE users SET role = 'consulta' WHERE username = 'degradada'`); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Tick(t.Context(), tenant); err != nil {
		t.Fatal(err)
	}
	counts := map[string]int{}
	for _, push := range double.sent {
		counts[push.endpoint]++
	}
	if counts[kept] != 2 || counts[reader] != 1 || counts[former] != 0 || counts[demoted] != 1 {
		t.Fatalf("kept %d, reader %d, former %d, demoted %d", counts[kept], counts[reader], counts[former], counts[demoted])
	}
	if n := scalar(t, pool, tenant, `SELECT count(*) FROM push_deliveries WHERE username = 'lector' AND restricted`); n != 0 {
		t.Fatalf("%d restricted deliveries for consulta", n)
	}
}

// failingTransport fails as a network does; the HTTP client quotes the URL in its error.
type failingTransport struct{}

func (failingTransport) RoundTrip(*http.Request) (*http.Response, error) {
	return nil, errors.New("dial failed")
}

func realSender(t *testing.T) *infrastructure.WebPushSender {
	t.Helper()
	settings := map[string]string{
		"SIPGES_VAPID_PUBLIC_KEY":  "BHS-uwl3nFpzgNoW0kjmSZB4-vUfabJkKg8ysBCV9GIZIzv22PTxzM0uQcgahdjwpxOaPcnfVtaILHUT6mAyu8o",
		"SIPGES_VAPID_PRIVATE_KEY": "Hxm3lKNdyp0lyYD4wbrlQmxH0T0mWnqeVdhx3-OrMEQ",
		"SIPGES_VAPID_SUBJECT":     "mailto:ops@example.org",
	}
	keys, err := infrastructure.LoadVapid(func(key string) (string, bool) { v, ok := settings[key]; return v, ok })
	if err != nil {
		t.Fatal(err)
	}
	sender, err := infrastructure.NewWebPushSender(keys, infrastructure.NewPushClient(failingTransport{}))
	if err != nil {
		t.Fatal(err)
	}
	return sender
}

func TestFailedPushKeepsNoEndpointOrPayloadInItsError(t *testing.T) {
	pool := scratchPool(t, tenant)
	c := &clock{now: time.Date(2026, 11, 5, 12, 0, 0, 0, time.UTC)}
	s := pushing(pool, c, &pushDouble{})
	s.PushSender = realSender(t)
	subscribe(t, pool, "persona", "analista", "secreta")
	saveRule(t, s, tenant, notifyRule("Aviso interno", "Eventos"))
	audit(t, pool, tenant, c.now.Add(-5*time.Minute), "Eventos", "EV-PERSONA", "CREATE")
	if _, err := s.Tick(t.Context(), tenant); err != nil {
		t.Fatal(err)
	}
	if n := scalar(t, pool, tenant, `SELECT count(*) FROM push_deliveries WHERE status = 'pending' AND attempts = 1 AND last_error = 'Servicio de push sin conexión'`); n != 1 {
		t.Fatalf("%d retrying deliveries", n)
	}
	for _, sql := range []string{
		`SELECT count(*) FROM push_deliveries WHERE last_error LIKE '%secreta%' OR last_error LIKE '%EV-PERSONA%'`,
		`SELECT count(*) FROM audit WHERE action = 'PUSH_SEND' AND detail LIKE '%secreta%'`,
	} {
		if n := scalar(t, pool, tenant, sql); n != 0 {
			t.Fatalf("%d rows leak: %s", n, sql)
		}
	}
}

func TestFailedPushRetriesOnceItIsDue(t *testing.T) {
	pool := scratchPool(t, tenant)
	c := &clock{now: time.Date(2026, 11, 5, 12, 0, 0, 0, time.UTC)}
	double := &pushDouble{err: errors.New("Servicio de push sin conexión")}
	s := pushing(pool, c, double)
	subscribe(t, pool, "persona", "analista", "a")
	saveRule(t, s, tenant, notifyRule("Aviso interno", "Eventos"))
	audit(t, pool, tenant, c.now.Add(-5*time.Minute), "Eventos", "EV-1", "CREATE")
	if _, err := s.Tick(t.Context(), tenant); err != nil {
		t.Fatal(err)
	}
	due := scalar(t, pool, tenant, fmt.Sprintf(`SELECT count(*) FROM push_deliveries WHERE next_attempt_at = '%s'`, c.now.Add(time.Minute).Format(time.RFC3339)))
	if due != 1 {
		t.Fatalf("%d deliveries due in a minute", due)
	}
	double.mu.Lock()
	double.err = nil
	double.mu.Unlock()
	if _, err := s.Tick(t.Context(), tenant); err != nil {
		t.Fatal(err)
	}
	if len(double.sent) != 0 {
		t.Fatal("retried before it was due")
	}
	c.Add(time.Minute)
	if _, err := s.Tick(t.Context(), tenant); err != nil {
		t.Fatal(err)
	}
	if len(double.sent) != 1 {
		t.Fatalf("sent %d pushes after the delay", len(double.sent))
	}
}

func TestACorruptPayloadStopsNoOtherPush(t *testing.T) {
	pool := scratchPool(t, tenant)
	c := &clock{now: time.Date(2026, 11, 5, 12, 0, 0, 0, time.UTC)}
	double := &pushDouble{}
	s := pushing(pool, c, double)
	endpoint := subscribe(t, pool, "persona", "analista", "a")
	notification := scalar(t, pool, tenant, fmt.Sprintf(`INSERT INTO notifications (tenant_id, title, body, marking, created_at) VALUES ('%s', 'N', '', 'interno', now()) RETURNING id`, tenant))
	if _, err := pool.Exec(t.Context(), `INSERT INTO push_deliveries (tenant_id, notification_id, endpoint, username, restricted, payload, next_attempt_at)
		VALUES ($1, $2, $3, 'persona', false, '{"title":5}', $4)`, tenant, notification, endpoint, c.now); err != nil {
		t.Fatal(err)
	}
	saveRule(t, s, tenant, notifyRule("Aviso interno", "Eventos"))
	audit(t, pool, tenant, c.now.Add(-5*time.Minute), "Eventos", "EV-1", "CREATE")
	if _, err := s.Tick(t.Context(), tenant); err != nil {
		t.Fatalf("the corrupt row failed the tick: %v", err)
	}
	if len(double.sent) != 1 {
		t.Fatalf("sent %d pushes", len(double.sent))
	}
	if n := scalar(t, pool, tenant, `SELECT count(*) FROM push_deliveries WHERE status = 'failed' AND attempts = 1 AND last_error = 'Contenido push no válido'`); n != 1 {
		t.Fatalf("%d settled corrupt rows", n)
	}
}

func TestDroppedDeviceIsForgotten(t *testing.T) {
	pool := scratchPool(t, tenant)
	c := &clock{now: time.Date(2026, 11, 5, 12, 0, 0, 0, time.UTC)}
	double := &pushDouble{gone: map[string]bool{}}
	s := pushing(pool, c, double)
	double.gone[subscribe(t, pool, "persona", "analista", "gone")] = true
	saveRule(t, s, tenant, notifyRule("Aviso interno", "Eventos"))
	audit(t, pool, tenant, c.now.Add(-5*time.Minute), "Eventos", "EV-1", "CREATE")
	if _, err := s.Tick(t.Context(), tenant); err != nil {
		t.Fatal(err)
	}
	var left int64
	if err := pool.QueryRow(t.Context(), `SELECT count(*) FROM push_subscriptions`).Scan(&left); err != nil || left != 0 {
		t.Fatalf("%d subscriptions left (%v)", left, err)
	}
	if n := scalar(t, pool, tenant, `SELECT count(*) FROM push_deliveries WHERE status = 'failed' AND last_error = 'Suscripción expirada'`); n != 1 {
		t.Fatalf("%d failed deliveries", n)
	}
}

func TestBothAPIsRunningSendEachPushOnce(t *testing.T) {
	source, err := os.ReadFile(typeScriptPushStore)
	if err != nil {
		t.Fatal(err)
	}
	found := typeScriptPushClaim.FindSubmatch(source)
	if found == nil {
		t.Fatal("TypeScript's push claim was not found")
	}
	if !strings.Contains(string(found[1]), "SKIP LOCKED") {
		t.Fatal("the claim read is not the locking statement")
	}
	pool := scratchPool(t, tenant)
	c := &clock{now: time.Date(2026, 11, 5, 12, 0, 0, 0, time.UTC)}
	double := &pushDouble{}
	goService := pushing(pool, c, double)
	typeScript := goService
	typeScript.Deliveries = claimingPushLikeTypeScript{infrastructure.PushOutbox{DB: pool}, string(found[1])}

	const devices, events = 3, 30
	for i := range devices {
		subscribe(t, pool, fmt.Sprintf("persona%d", i), "analista", fmt.Sprintf("%d", i))
	}
	saveRule(t, goService, tenant, notifyRule("Aviso interno", "Eventos"))
	for i := range events {
		audit(t, pool, tenant, c.now.Add(-5*time.Minute), "Eventos", fmt.Sprintf("EV-%d", i), "CREATE")
	}

	stop, cancel := context.WithCancel(context.Background())
	defer cancel()
	runners := make([]*application.Runtime, 0, 3)
	for _, s := range []application.Service{goService, goService, typeScript} {
		rt := &application.Runtime{Store: infrastructure.RuntimeStore{DB: pool}, Tick: s.Tick, Now: c.Now,
			Background: func() context.Context { return application.WorkerContext(context.Background()) }}
		rt.StartSchedule(stop, application.Schedule{Interval: 2 * time.Millisecond,
			OnError: func(err error) { t.Errorf("tick: %v", err) }})
		runners = append(runners, rt)
	}
	const deliveries = devices * events
	deadline := time.Now().Add(30 * time.Second)
	for scalar(t, pool, tenant, `SELECT count(*) FROM push_deliveries WHERE status = 'accepted'`) != deliveries {
		if time.Now().After(deadline) {
			t.Fatalf("%d of %d deliveries accepted", scalar(t, pool, tenant, `SELECT count(*) FROM push_deliveries WHERE status = 'accepted'`), deliveries)
		}
		time.Sleep(20 * time.Millisecond) //nolint:forbidigo // waiting for the schedules
	}
	cancel()
	for _, rt := range runners {
		if err := rt.Drain(t.Context()); err != nil {
			t.Fatal(err)
		}
	}
	double.mu.Lock()
	defer double.mu.Unlock()
	seen := map[sentPush]int{}
	for _, push := range double.sent {
		seen[push]++
	}
	if len(double.sent) != deliveries {
		t.Fatalf("%d pushes sent, want %d", len(double.sent), deliveries)
	}
	for push, n := range seen {
		if n != 1 {
			t.Fatalf("a push went out %d times to one device (%.20q)", n, push.payload.Title)
		}
	}
	if n := scalar(t, pool, tenant, `SELECT count(*) FROM push_deliveries WHERE attempts <> 1`); n != 0 {
		t.Fatalf("%d deliveries claimed more than once", n)
	}
	if n := scalar(t, pool, tenant, `SELECT count(*) FROM audit WHERE action = 'PUSH_SEND'`); n != deliveries {
		t.Fatalf("%d push audits, want %d", n, deliveries)
	}
}
