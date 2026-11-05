package main

import (
	"context"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/Dreamcoder08/sipges/apps/api-go/internal/platform/database/dbtest"
)

const syntheticAdminPassword = "synthetic-admin-password"

// started runs the API on env until the test ends.
type started struct {
	addr string
	out  *syncBuffer
	done chan error
	stop context.CancelFunc
}

func startAPI(t *testing.T, env map[string]string) *started {
	t.Helper()
	addrs := make(chan string, 1)
	listen := func(network, _ string) (net.Listener, error) {
		ln, err := net.Listen(network, "127.0.0.1:0")
		if err == nil {
			addrs <- ln.Addr().String()
		}
		return ln, err
	}
	ctx, cancel := context.WithCancel(context.Background())
	s := &started{out: &syncBuffer{}, done: make(chan error, 1), stop: cancel}
	go func() { s.done <- run(ctx, lookup(env), s.out, listen) }()
	t.Cleanup(cancel)
	select {
	case s.addr = <-addrs:
	case err := <-s.done:
		t.Fatalf("run ended before listening: %v", err)
	case <-time.After(30 * time.Second):
		t.Fatal("run did not listen")
	}
	return s
}

func (s *started) get(t *testing.T, path string) int {
	t.Helper()
	req, err := http.NewRequestWithContext(t.Context(), http.MethodGet, "http://"+s.addr+path, nil)
	if err != nil {
		t.Fatal(err)
	}
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = res.Body.Close() }()
	_, _ = io.Copy(io.Discard, res.Body)
	return res.StatusCode
}

func (s *started) eventually(t *testing.T, what string, ok func() bool) {
	t.Helper()
	deadline := time.Now().Add(20 * time.Second)
	for !ok() {
		if time.Now().After(deadline) {
			t.Fatalf("%s never happened; logs:\n%s", what, s.out.String())
		}
		time.Sleep(50 * time.Millisecond)
	}
}

func (s *started) stopped(t *testing.T) error {
	t.Helper()
	s.stop()
	select {
	case err := <-s.done:
		return err
	case <-time.After(20 * time.Second):
		t.Fatal("run did not stop")
		return nil
	}
}

func scratchDB(t *testing.T) *dbtest.Scratch {
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
	return s
}

func exec(t *testing.T, dsn, sql string) {
	t.Helper()
	conn, err := pgx.Connect(t.Context(), dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = conn.Close(context.Background()) }()
	if _, err := conn.Exec(t.Context(), sql); err != nil {
		t.Fatal(err)
	}
}

func scalar(t *testing.T, dsn, sql string) string {
	t.Helper()
	conn, err := pgx.Connect(t.Context(), dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = conn.Close(context.Background()) }()
	var out string
	if err := conn.QueryRow(t.Context(), sql).Scan(&out); err != nil {
		t.Fatal(err)
	}
	return out
}

func noCredential(t *testing.T, text string) {
	t.Helper()
	for _, secret := range []string{syntheticAdminPassword, "synthetic-secret", "$argon2id$"} {
		if strings.Contains(text, secret) {
			t.Fatalf("%q reached the output:\n%s", secret, text)
		}
	}
}

func TestStartCreatesTheFirstAdministratorThenReportsReady(t *testing.T) {
	s := scratchDB(t)
	exec(t, s.URL, `TRUNCATE users CASCADE`)
	api := startAPI(t, map[string]string{
		"SIPGES_DATABASE_URL": s.URL, "SIPGES_ADMIN_USERNAME": " Root.Admin ", "SIPGES_ADMIN_PASSWORD": syntheticAdminPassword,
		"SIPGES_ADMIN_FULL_NAME": " Synthetic Admin ", "SIPGES_GOOGLE_CLIENT_ID": "client", "SIPGES_GOOGLE_CLIENT_SECRET": "synthetic-secret",
		"SIPGES_GOOGLE_ADMIN_EMAIL": "Boot.Admin@Example.com",
	})
	api.eventually(t, "readiness", func() bool { return api.get(t, "/health/ready") == http.StatusOK })
	got := scalar(t, s.URL, `SELECT username || '|' || full_name || '|' || role || '|' || coalesce(google_email, '') FROM users`)
	if got != "root.admin|Synthetic Admin|admin|boot.admin@example.com" {
		t.Fatalf("stored %q", got)
	}
	if hash := scalar(t, s.URL, `SELECT password_hash FROM users`); !strings.HasPrefix(hash, "$argon2id$v=19$m=19456,t=2,p=1$") {
		t.Fatalf("hash %q", hash)
	}
	if err := api.stopped(t); err != nil {
		t.Fatal(err)
	}
	noCredential(t, api.out.String())
}

func TestStartIsIdempotentAndKeepsAnExistingInstallation(t *testing.T) {
	s := scratchDB(t)
	exec(t, s.URL, `TRUNCATE users CASCADE`)
	exec(t, s.URL, `INSERT INTO users (username, full_name, password_hash, role, google_email) VALUES ('owner', 'Owner', 'x', 'admin', 'kept@example.com')`)
	// No password is needed once users exist, and neither the account nor its link change.
	for range 2 {
		api := startAPI(t, map[string]string{"SIPGES_DATABASE_URL": s.URL, "SIPGES_ADMIN_USERNAME": "owner",
			"SIPGES_GOOGLE_CLIENT_ID": "client", "SIPGES_GOOGLE_CLIENT_SECRET": "synthetic-secret", "SIPGES_GOOGLE_ADMIN_EMAIL": "other@example.com"})
		api.eventually(t, "readiness", func() bool { return api.get(t, "/health/ready") == http.StatusOK })
		if err := api.stopped(t); err != nil {
			t.Fatal(err)
		}
	}
	if got := scalar(t, s.URL, `SELECT count(*)::text || '|' || min(google_email) FROM users`); got != "1|kept@example.com" {
		t.Fatalf("stored %q", got)
	}
}

func TestStartStopsOnAnEmptyInstallationWithoutAUsablePassword(t *testing.T) {
	s := scratchDB(t)
	exec(t, s.URL, `TRUNCATE users CASCADE`)
	for _, env := range []map[string]string{
		{"SIPGES_DATABASE_URL": s.URL},
		{"SIPGES_DATABASE_URL": s.URL, "SIPGES_ADMIN_PASSWORD": "short-one"},
	} {
		var out syncBuffer
		listen := func(network, _ string) (net.Listener, error) { return net.Listen(network, "127.0.0.1:0") }
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		err := run(ctx, lookup(env), &out, listen)
		cancel()
		if err == nil || err.Error() != "Configure SIPGES_ADMIN_PASSWORD (mínimo 12 caracteres)" {
			t.Fatalf("err = %v", err)
		}
		if strings.Contains(out.String(), "short-one") {
			t.Fatalf("the password was logged: %s", out.String())
		}
	}
	if got := scalar(t, s.URL, `SELECT count(*)::text FROM users`); got != "0" {
		t.Fatalf("%s users", got)
	}
}

func TestStartStopsOnAUsernameTheUsersTableCannotHold(t *testing.T) {
	s := scratchDB(t)
	exec(t, s.URL, `TRUNCATE users CASCADE`)
	const refused = "SIPGES_ADMIN_USERNAME must have between 1 and 120 characters"
	impossible := strings.Repeat("impossible-name-", 8) + "x"
	for _, username := range []string{"", " \t ", impossible} {
		var out syncBuffer
		listen := func(network, _ string) (net.Listener, error) { return net.Listen(network, "127.0.0.1:0") }
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		err := run(ctx, lookup(map[string]string{"SIPGES_DATABASE_URL": s.URL, "SIPGES_ADMIN_USERNAME": username, "SIPGES_ADMIN_PASSWORD": syntheticAdminPassword}), &out, listen)
		cancel()
		if err == nil || err.Error() != refused {
			t.Fatalf("%q: err = %v", username, err)
		}
		noCredential(t, out.String()+err.Error())
		if strings.Contains(out.String(), "impossible-name") {
			t.Fatalf("the value was logged: %s", out.String())
		}
	}
	if got := scalar(t, s.URL, `SELECT count(*)::text FROM users`); got != "0" {
		t.Fatalf("%s users", got)
	}
}

func TestStartIgnoresAnImpossibleUsernameOnceUsersExist(t *testing.T) {
	s := scratchDB(t)
	exec(t, s.URL, `TRUNCATE users CASCADE`)
	exec(t, s.URL, `INSERT INTO users (username, full_name, password_hash, role) VALUES ('owner', 'Owner', 'x', 'admin')`)
	api := startAPI(t, map[string]string{"SIPGES_DATABASE_URL": s.URL, "SIPGES_ADMIN_USERNAME": ""})
	api.eventually(t, "readiness", func() bool { return api.get(t, "/health/ready") == http.StatusOK })
	if err := api.stopped(t); err != nil {
		t.Fatal(err)
	}
}

func TestStartAcceptsTheLongestUsername(t *testing.T) {
	s := scratchDB(t)
	exec(t, s.URL, `TRUNCATE users CASCADE`)
	username := strings.Repeat("a", 120)
	api := startAPI(t, map[string]string{"SIPGES_DATABASE_URL": s.URL, "SIPGES_ADMIN_USERNAME": username, "SIPGES_ADMIN_PASSWORD": syntheticAdminPassword})
	api.eventually(t, "readiness", func() bool { return api.get(t, "/health/ready") == http.StatusOK })
	if got := scalar(t, s.URL, `SELECT username FROM users`); got != username {
		t.Fatalf("stored %q", got)
	}
	if err := api.stopped(t); err != nil {
		t.Fatal(err)
	}
}

func TestStartReportsTheEmptyPasswordBeforeTheUsername(t *testing.T) {
	s := scratchDB(t)
	exec(t, s.URL, `TRUNCATE users CASCADE`)
	var out syncBuffer
	listen := func(network, _ string) (net.Listener, error) { return net.Listen(network, "127.0.0.1:0") }
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	err := run(ctx, lookup(map[string]string{"SIPGES_DATABASE_URL": s.URL, "SIPGES_ADMIN_USERNAME": ""}), &out, listen)
	if err == nil || err.Error() != "Configure SIPGES_ADMIN_PASSWORD (mínimo 12 caracteres)" {
		t.Fatalf("err = %v", err)
	}
}

func TestStartStopsOnAnInvalidGoogleAdminAddress(t *testing.T) {
	s := scratchDB(t)
	var out syncBuffer
	listen := func(network, _ string) (net.Listener, error) { return net.Listen(network, "127.0.0.1:0") }
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	err := run(ctx, lookup(map[string]string{"SIPGES_DATABASE_URL": s.URL, "SIPGES_ADMIN_PASSWORD": syntheticAdminPassword,
		"SIPGES_GOOGLE_CLIENT_ID": "client", "SIPGES_GOOGLE_CLIENT_SECRET": "synthetic-secret", "SIPGES_GOOGLE_ADMIN_EMAIL": "no-es-correo"}), &out, listen)
	if err == nil || err.Error() != "SIPGES_GOOGLE_ADMIN_EMAIL is not a valid address" {
		t.Fatalf("err = %v", err)
	}
}

func TestStartWaitsForMigrationsThenBootstraps(t *testing.T) {
	adminURL := os.Getenv(dbtest.EnvAdminURL)
	if adminURL == "" {
		t.Skip(dbtest.EnvAdminURL + " is not set")
	}
	name := fmt.Sprintf("sipges_go_bare_%d", time.Now().UnixNano())
	exec(t, adminURL, "CREATE DATABASE "+name)
	t.Cleanup(func() {
		conn, err := pgx.Connect(context.Background(), adminURL)
		if err == nil {
			_, _ = conn.Exec(context.Background(), "DROP DATABASE IF EXISTS "+name+" WITH (FORCE)")
			_ = conn.Close(context.Background())
		}
	})
	u, err := url.Parse(adminURL)
	if err != nil {
		t.Fatal(err)
	}
	u.Path = "/" + name
	dsn := u.String()

	api := startAPI(t, map[string]string{"SIPGES_DATABASE_URL": dsn, "SIPGES_ADMIN_PASSWORD": syntheticAdminPassword})
	const unmigrated = "identity bootstrap is waiting for migrations"
	api.eventually(t, "two unmigrated messages", func() bool { return strings.Count(api.out.String(), unmigrated) >= 2 })
	if got := api.get(t, "/health"); got != http.StatusOK {
		t.Fatalf("/health = %d", got)
	}
	if got := api.get(t, "/health/ready"); got != http.StatusServiceUnavailable {
		t.Fatalf("/health/ready = %d", got)
	}
	noCredential(t, api.out.String())

	conn, err := pgx.Connect(t.Context(), dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = conn.Close(context.Background()) }()
	migrations, err := dbtest.LoadMigrations(os.DirFS(dbtest.MigrationsDir()))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := dbtest.Migrate(t.Context(), conn, migrations); err != nil {
		t.Fatal(err)
	}
	api.eventually(t, "readiness after migrating", func() bool { return api.get(t, "/health/ready") == http.StatusOK })
	if got := scalar(t, dsn, `SELECT username FROM users`); got != "admin" {
		t.Fatalf("stored %q", got)
	}
	if err := api.stopped(t); err != nil {
		t.Fatal(err)
	}
	noCredential(t, api.out.String())
}

func TestShutdownStopsTheRetriesWhileTheDatabaseIsMissing(t *testing.T) {
	adminURL := os.Getenv(dbtest.EnvAdminURL)
	if adminURL == "" {
		t.Skip(dbtest.EnvAdminURL + " is not set")
	}
	name := fmt.Sprintf("sipges_go_bare_%d", time.Now().UnixNano())
	exec(t, adminURL, "CREATE DATABASE "+name)
	t.Cleanup(func() {
		conn, err := pgx.Connect(context.Background(), adminURL)
		if err == nil {
			_, _ = conn.Exec(context.Background(), "DROP DATABASE IF EXISTS "+name+" WITH (FORCE)")
			_ = conn.Close(context.Background())
		}
	})
	u, err := url.Parse(adminURL)
	if err != nil {
		t.Fatal(err)
	}
	u.Path = "/" + name
	api := startAPI(t, map[string]string{"SIPGES_DATABASE_URL": u.String()})
	api.eventually(t, "the first attempt", func() bool { return strings.Contains(api.out.String(), "waiting for migrations") })
	if err := api.stopped(t); err != nil {
		t.Fatalf("a shutdown while waiting must exit cleanly: %v", err)
	}
	if !strings.Contains(api.out.String(), `"msg":"stopped"`) {
		t.Fatalf("logs: %s", api.out.String())
	}
}
