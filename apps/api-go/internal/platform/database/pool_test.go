package database_test

import (
	"context"
	"strings"
	"testing"

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
