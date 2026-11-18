package main

import (
	"bytes"
	"errors"
	"net"
	"testing"
)

// A malformed call is refused with exit code 2 before any database is opened, like runAdminCommand
// of apps/api/src/admin-cli.ts.
func TestResetMFAUsage(t *testing.T) {
	t.Parallel()
	for _, args := range [][]string{{"reset-mfa"}, {"reset-mfa", ""}, {"reset-mfa", "a", "b"}} {
		var out bytes.Buffer
		err := dispatch(t.Context(), args, lookup(map[string]string{}), &out, net.Listen)
		var exit *exitError
		if !errors.As(err, &exit) || exit.code != 2 || exit.message != "Uso: sipges-api-go reset-mfa <usuario>" {
			t.Fatalf("%q: err = %v", args, err)
		}
		if out.Len() != 0 {
			t.Fatalf("%q: stdout = %q", args, out.String())
		}
	}
}

func TestResetMFANeedsADatabase(t *testing.T) {
	t.Parallel()
	var out bytes.Buffer
	err := dispatch(t.Context(), []string{"reset-mfa", "admin"}, lookup(map[string]string{}), &out, net.Listen)
	if err == nil || err.Error() != "SIPGES_DATABASE_URL is required" {
		t.Fatalf("err = %v", err)
	}
}
