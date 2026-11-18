package main

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

// apiStopGrace covers the API's own shutdown (10 s for requests, 20 s for background work) before
// the process is killed.
const apiStopGrace = 45 * time.Second

// apiEnv is the inherited environment with the settings the desktop owns replaced, so a stray
// SIPGES_DATABASE_URL cannot point the API elsewhere. Anything else the launcher sets passes on.
func apiEnv(base []string, s settings, sec secrets, databaseURL string) []string {
	owned := [][2]string{
		{"SIPGES_DATABASE_URL", databaseURL},
		{"SIPGES_DATA_KEY", sec.dataKey},
		{"SIPGES_ADMIN_PASSWORD", sec.adminPassword},
		{"SIPGES_HOST", "127.0.0.1"},
		{"SIPGES_PORT", strconv.Itoa(s.port)},
		{"SIPGES_COOKIE_SECURE", "0"},
		{"SIPGES_UPLOAD_DIR", filepath.Join(s.state, "uploads")},
		{"SIPGES_MIGRATIONS_DIR", s.migrations},
	}
	env := make([]string, 0, len(base)+len(owned)+1)
	for _, kv := range base {
		key, _, _ := strings.Cut(kv, "=")
		mine := false
		for _, o := range owned {
			mine = mine || sameKey(key, o[0])
		}
		if !mine {
			env = append(env, kv)
		}
	}
	// Only these names reach the API: a page on another name that resolves to 127.0.0.1 (DNS
	// rebinding) gets 400.
	if _, set := lookupIn(base)("SIPGES_ALLOWED_HOSTS"); !set {
		env = append(env, "SIPGES_ALLOWED_HOSTS=localhost,127.0.0.1")
	}
	for _, o := range owned {
		env = append(env, o[0]+"="+o[1])
	}
	return env
}

// migrateAPI runs `api migrate`, which applies the migrations as the login the API serves with.
func migrateAPI(ctx context.Context, apiBin string, env []string, stdout, stderr io.Writer) error {
	cmd := exec.CommandContext(ctx, apiBin, "migrate")
	cmd.Env, cmd.Stdout, cmd.Stderr = env, stdout, stderr
	if err := cmd.Run(); err != nil {
		return fmt.Errorf("api migrate: %w", err)
	}
	return nil
}

// serveAPI runs the API until ctx ends, then asks it to stop as SIGTERM would and waits for it.
// An API that exits by itself is an error: the desktop has nothing left to serve.
func serveAPI(ctx context.Context, apiBin string, env []string, stdout, stderr io.Writer) error {
	cmd := exec.CommandContext(ctx, apiBin)
	cmd.Env, cmd.Stdout, cmd.Stderr = env, stdout, stderr
	ownProcessGroup(cmd)
	cmd.Cancel = func() error { return interrupt(cmd.Process) }
	cmd.WaitDelay = apiStopGrace
	err := cmd.Run()
	if ctx.Err() != nil {
		if err != nil && !errors.Is(err, ctx.Err()) {
			_, _ = fmt.Fprintln(stderr, "sipges-desktop: api stopped:", err)
		}
		return nil
	}
	if err == nil {
		err = errors.New("exited")
	}
	return &userError{msg: "El servidor de SIPGES se detuvo. Revise el registro de SIPGES.", err: fmt.Errorf("api: %w", err)}
}
