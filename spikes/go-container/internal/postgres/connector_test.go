package postgres_test

import (
	"context"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/dreamcoder08/sipges/spikes/go-container/internal/postgres"
)

// SPIKE_TEST_DATABASE_URL points at a synthetic local PostgreSQL, e.g.
// postgres://sipges_test@127.0.0.1:55439/sipges_test?sslmode=disable
func testDSN(t *testing.T) string {
	t.Helper()
	dsn := os.Getenv("SPIKE_TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("SPIKE_TEST_DATABASE_URL not set")
	}
	return dsn
}

func TestConnectAndPing(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	session, timings, err := postgres.NewConnector(testDSN(t)).Connect(ctx)
	if err != nil {
		t.Fatalf("Connect() error = %v", err)
	}
	defer func() {
		if err := session.Close(ctx); err != nil {
			t.Errorf("Close() error = %v", err)
		}
	}()
	if timings.TCP <= 0 || timings.Total < timings.TCP {
		t.Errorf("timings = %+v, want TCP > 0 and Total >= TCP", timings)
	}
	if session.Encrypted() || timings.TLS != 0 {
		t.Errorf("plain local connection reported TLS: encrypted=%v tls=%v", session.Encrypted(), timings.TLS)
	}
	if err := session.Ping(ctx); err != nil {
		t.Fatalf("Ping() error = %v", err)
	}
}

func TestConnectRejectsInvalidDSN(t *testing.T) {
	_, _, err := postgres.NewConnector("postgres://%zz").Connect(context.Background())
	if err == nil {
		t.Fatal("Connect() error = nil, want parse error")
	}
}

func TestConnectErrorDoesNotLeakPassword(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	// Port 1 on loopback refuses connections; the error must not echo the secret.
	_, _, err := postgres.NewConnector("postgres://u:s3cret-value@127.0.0.1:1/db?sslmode=disable&connect_timeout=2").Connect(ctx)
	if err == nil {
		t.Fatal("Connect() error = nil, want dial error")
	}
	if got := err.Error(); strings.Contains(got, "s3cret-value") {
		t.Fatalf("error leaks the password: %q", got)
	}
}
