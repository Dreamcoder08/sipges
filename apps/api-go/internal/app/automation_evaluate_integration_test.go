package app_test

import (
	"strings"
	"testing"
	"time"
)

const narrativesPath = "/api/narrativas" //nolint:misspell // the Spanish module slug

//nolint:misspell // the Spanish module name
const evaluateRule = `{"name":"Evaluar narrativas","module":"Narrativas","actions":["CREATE","UPDATE"],"steps":[{"kind":"evaluate","title":"Evaluar","minimum_level":"Media"}]}`

const heardNarrative = `{"payload":{"Descripcion":"Exigimos agua limpia: habrá paro y bloqueo este lunes. Convocatoria a asamblea.","URL_Publicacion":"https://example.org/sintetica","Territorio":"Territorio sintético"}}`

func (e pushEnv) until(t *testing.T, what string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(15 * time.Second)
	for !cond() {
		if time.Now().After(deadline) {
			t.Fatalf("timed out waiting for %s", what)
		}
		time.Sleep(20 * time.Millisecond) //nolint:forbidigo // waiting for the wakeup's tick
	}
}

func TestANarrativeBecomesOneAlertThroughItsRule(t *testing.T) {
	e := startPush(t, false)
	if status, body := e.do(t, "POST", "/system/automations/rules", "boss", evaluateRule); status != 200 {
		t.Fatalf("rule: %d %s", status, body)
	}
	if status, body := e.do(t, "POST", narrativesPath, "boss", heardNarrative); status != 200 && status != 201 {
		t.Fatalf("narrative: %d %s", status, body)
	}
	e.until(t, "the alert", func() bool {
		return e.count(t, `SELECT count(*) FROM automation_runs WHERE status = 'done'`) == 1
	})
	if n := e.count(t, `SELECT count(*) FROM digital_alert_reviews WHERE source_record ->> 'module' = 'Narrativas' AND semantic_active = false AND territory = 'Territorio sintético' AND source_url = 'https://example.org/sintetica' AND status = 'Pendiente de verificación'`); n != 1 {
		t.Fatalf("%d alerts", n)
	}
	if n := e.count(t, `SELECT count(*) FROM audit WHERE module = 'InteligenciaDigital' AND action = 'CREATE' AND event_payload -> 'source_record' ->> 'module' = 'Narrativas'`); n != 1 {
		t.Fatalf("%d audit rows", n)
	}

	// The same narrative saved again evaluates to the same signal: the run finishes, no second alert.
	var id string
	if err := e.pool.QueryRow(t.Context(), `SELECT id FROM module_records WHERE module = 'Narrativas'`).Scan(&id); err != nil {
		t.Fatal(err)
	}
	if status, body := e.do(t, "PUT", narrativesPath+"/"+id, "boss", heardNarrative); status != 200 {
		t.Fatalf("update: %d %s", status, body)
	}
	e.until(t, "the second evaluation", func() bool {
		return e.count(t, `SELECT count(*) FROM automation_runs WHERE status = 'done'`) == 2
	})
	if n := e.count(t, `SELECT count(*) FROM digital_alert_reviews`); n != 1 {
		t.Fatalf("%d alerts after saving the same narrative again", n)
	}
}

func TestARestrictedNarrativeNeverReachesTheInbox(t *testing.T) {
	e := startPush(t, false)
	onUpdate := strings.Replace(evaluateRule, `["CREATE","UPDATE"]`, `["UPDATE"]`, 1)
	if status, body := e.do(t, "POST", "/system/automations/rules", "boss", onUpdate); status != 200 {
		t.Fatalf("rule: %d %s", status, body)
	}
	if status, body := e.do(t, "POST", narrativesPath, "boss", heardNarrative); status != 200 && status != 201 {
		t.Fatalf("narrative: %d %s", status, body)
	}
	var id string
	if err := e.pool.QueryRow(t.Context(), `UPDATE module_records SET marking = 'restringido' RETURNING id`).Scan(&id); err != nil {
		t.Fatal(err)
	}
	if status, body := e.do(t, "PUT", narrativesPath+"/"+id, "boss", heardNarrative); status != 200 {
		t.Fatalf("update: %d %s", status, body)
	}
	e.until(t, "the run", func() bool {
		return e.count(t, `SELECT count(*) FROM automation_runs WHERE status = 'done'`) == 1
	})
	if n := e.count(t, `SELECT count(*) FROM module_records WHERE marking = 'restringido'`); n != 1 {
		t.Fatalf("%d restricted records: the event was not about one", n)
	}
	if n := e.count(t, `SELECT count(*) FROM digital_alert_reviews`); n != 0 {
		t.Fatalf("%d alerts from a restricted narrative", n)
	}
}
