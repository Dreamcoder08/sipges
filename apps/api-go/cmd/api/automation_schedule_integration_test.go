package main

import (
	"encoding/base64"
	"net/http"
	"strings"
	"testing"
)

const scheduleStarted = "automation_schedule_started"

// cronEnv is the variables the run reads; the data key comes from the process environment, as
// the automation context reads it.
func cronEnv(t *testing.T, url string) map[string]string {
	t.Helper()
	t.Setenv("SIPGES_DATA_KEY", base64.StdEncoding.EncodeToString(make([]byte, 32)))
	return map[string]string{"SIPGES_DATABASE_URL": url, "SIPGES_ADMIN_PASSWORD": syntheticAdminPassword}
}

func seedCursor(t *testing.T, url string) {
	t.Helper()
	exec(t, url, `INSERT INTO tenants (company_id, project_id, label) VALUES ('SIPGES', 'PRJ-CRON', 'Cron')
		ON CONFLICT DO NOTHING;
		INSERT INTO automation_cursors (tenant_id, last_audit_id) VALUES ('SIPGES/PRJ-CRON', 0);`)
}

func TestTheFlagMakesTheAPITickAndDrainOnStop(t *testing.T) {
	s := scratchDB(t)
	seedCursor(t, s.URL)
	env := cronEnv(t, s.URL)
	env["SIPGES_GO_AUTOMATION_CRON"] = "1"
	env["SIPGES_AUTOMATION_INTERVAL"] = "5"
	api := startAPI(t, env)
	api.eventually(t, "a cron tick", func() bool {
		return scalar(t, s.URL, `SELECT coalesce(last_tick_source, '') || ':' || coalesce(last_tick_status, '') FROM automation_cursors`) == "cron:completed"
	})
	if err := api.stopped(t); err != nil {
		t.Fatal(err)
	}
	out := api.out.String()
	if !strings.Contains(out, scheduleStarted) || !strings.Contains(out, `"interval_seconds":5`) || !strings.Contains(out, `"stopped"`) ||
		strings.Contains(out, "automation_drain_incomplete") {
		t.Fatalf("logs:\n%s", out)
	}
}

func TestByDefaultTheAPINeverTicksEvenWithTheTypeScriptInterval(t *testing.T) {
	s := scratchDB(t)
	seedCursor(t, s.URL)
	env := cronEnv(t, s.URL)
	env["SIPGES_AUTOMATION_INTERVAL"] = "5"
	api := startAPI(t, env)
	api.eventually(t, "readiness", func() bool { return api.get(t, "/health/ready") == http.StatusOK })
	if err := api.stopped(t); err != nil {
		t.Fatal(err)
	}
	if out := api.out.String(); strings.Contains(out, scheduleStarted) {
		t.Fatalf("logs:\n%s", out)
	}
	if got := scalar(t, s.URL, `SELECT coalesce(last_tick_source, 'none') FROM automation_cursors`); got != "none" {
		t.Fatalf("a %s tick ran with the flag off", got)
	}
}
