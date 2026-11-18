package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"net"
	"strings"
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

// A failure still leaves the log line, and neither it nor the error quotes the connection URL.
func TestResetMFALogsAFailureWithoutTheURL(t *testing.T) {
	t.Parallel()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	addr := ln.Addr().String()
	_ = ln.Close()
	url := "postgres://synthetic_user:synthetic-pass@" + addr + "/synthetic_db?connect_timeout=2"
	var out, logs bytes.Buffer
	err = resetMFA(t.Context(), []string{"reset-mfa", " Ana "}, lookup(map[string]string{"SIPGES_DATABASE_URL": url}), &out, &logs)
	if err == nil || strings.Contains(err.Error(), "synthetic-pass") {
		t.Fatalf("err = %v", err)
	}
	if out.Len() != 0 {
		t.Fatalf("stdout = %q", out.String())
	}
	if strings.Count(logs.String(), "\n") != 1 || strings.Contains(logs.String(), "synthetic") {
		t.Fatalf("log = %q", logs.String())
	}
	var line map[string]any
	if err := json.Unmarshal(logs.Bytes(), &line); err != nil {
		t.Fatal(err)
	}
	if line["msg"] != "operator_command" || line["command"] != "reset-mfa" || line["username"] != "ana" ||
		line["outcome"] != "failed" || line["time"] == nil {
		t.Fatalf("log = %q", logs.String())
	}
}

// A refused call names no user, so it logs nothing: the usage text is the whole answer.
func TestResetMFAUsageLogsNothing(t *testing.T) {
	t.Parallel()
	var out, logs bytes.Buffer
	err := resetMFA(t.Context(), []string{"reset-mfa"}, lookup(map[string]string{}), &out, &logs)
	var exit *exitError
	if !errors.As(err, &exit) || exit.code != 2 || logs.Len() != 0 {
		t.Fatalf("err = %v, log = %q", err, logs.String())
	}
}
