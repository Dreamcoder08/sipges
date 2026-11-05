package app

import (
	"errors"
	"testing"

	"github.com/Dreamcoder08/sipges/apps/api-go/internal/platform/httpx"
)

func TestRegisteringAMiddlewareTwicePanics(t *testing.T) {
	defer func() {
		if recover() == nil {
			t.Fatal("registering automation's middleware twice did not panic")
		}
	}()
	registerMiddleware("automation", func(Deps) (httpx.Middleware, error) { return nil, nil })
}

func TestContextMiddlewareNamesTheContextThatFailed(t *testing.T) {
	const name = "zz-failing-for-test"
	registerMiddleware(name, func(Deps) (httpx.Middleware, error) { return nil, errors.New("broken") })
	defer delete(middlewares, name)
	if _, err := contextMiddleware(Deps{}); err == nil || err.Error() != name+" middleware: broken" {
		t.Fatalf("err = %v", err)
	}
}

func TestAutomationSettingsFollowTheTypeScriptConfig(t *testing.T) {
	env := func(values map[string]string) func(string) (string, bool) {
		return func(k string) (string, bool) { v, ok := values[k]; return v, ok }
	}
	if s, err := cronSecret(env(map[string]string{"CRON_SECRET": "  " + "x234567890123456789012345" + " "})); err != nil || s != "x234567890123456789012345" {
		t.Fatalf("CRON_SECRET fallback: %q %v", s, err)
	}
	if s, _ := cronSecret(env(map[string]string{"SIPGES_CRON_SECRET": "a23456789012345678901234", "CRON_SECRET": "b23456789012345678901234"})); s[0] != 'a' {
		t.Fatal("SIPGES_CRON_SECRET must win")
	}
	if _, err := cronSecret(env(map[string]string{"SIPGES_CRON_SECRET": "short"})); err == nil {
		t.Fatal("a short cron secret was accepted")
	}
	if s, err := cronSecret(env(nil)); err != nil || s != "" {
		t.Fatal("no secret must be allowed (the cron then refuses every call)")
	}
}
