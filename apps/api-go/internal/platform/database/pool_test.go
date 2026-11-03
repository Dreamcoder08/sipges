package database_test

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/Dreamcoder08/sipges/apps/api-go/internal/platform/database"
)

func TestOpenRejectsAnInvalidURLWithoutEchoingIt(t *testing.T) {
	t.Parallel()
	_, err := database.Open(context.Background(), "postgres://u:synthetic-secret@h:notaport/db")
	if err == nil || strings.Contains(err.Error(), "synthetic-secret") {
		t.Fatalf("err = %v", err)
	}
}

func TestOpenForcesUTF8AndPings(t *testing.T) {
	requireDB(t)
	ctx := context.Background()
	pool, err := database.Open(ctx, scratch.URL+"?client_encoding=LATIN1")
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	if err := database.Ping(pool)(ctx); err != nil {
		t.Fatal(err)
	}
	var encoding, app string
	if err := pool.QueryRow(ctx, "SELECT current_setting('client_encoding'), current_setting('application_name')").Scan(&encoding, &app); err != nil {
		t.Fatal(err)
	}
	if encoding != "UTF8" || app != "sipges-api-go" {
		t.Fatalf("client_encoding=%q application_name=%q", encoding, app)
	}
}

// Nothing listens on port 1, so the background warm-up fails fast and harmlessly.
const unreachable = "postgres://synthetic@127.0.0.1:1/synthetic?connect_timeout=1"

func TestOpenKeepsTwoConnectionsWarmByDefault(t *testing.T) {
	t.Parallel()
	pool, err := database.Open(context.Background(), unreachable)
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	if got := pool.Config().MinConns; got != 2 {
		t.Fatalf("MinConns = %d", got)
	}
}

func TestOpenLetsTheURLSetTheWarmPoolSize(t *testing.T) {
	t.Parallel()
	pool, err := database.Open(context.Background(), unreachable+"&pool_min_conns=0")
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	if got := pool.Config().MinConns; got != 0 {
		t.Fatalf("MinConns = %d", got)
	}
}

func TestOpenWarmsConnectionsBeforeTheFirstQuery(t *testing.T) {
	requireDB(t)
	pool, err := database.Open(context.Background(), scratch.URL)
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	deadline := time.Now().Add(10 * time.Second)
	for pool.Stat().IdleConns() < database.DefaultMinConns {
		if time.Now().After(deadline) {
			t.Fatalf("idle connections = %d, want %d", pool.Stat().IdleConns(), database.DefaultMinConns)
		}
		time.Sleep(20 * time.Millisecond)
	}
}
