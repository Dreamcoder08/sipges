package application

import (
	"encoding/json"
	"testing"
	"time"
)

var at = time.Date(2026, 11, 3, 10, 0, 0, 123_456_000, time.UTC)

func encode(t *testing.T, v any) string {
	t.Helper()
	b, err := Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

func TestRuleOutMapsStepsAsStepOut(t *testing.T) {
	rule := Rule{
		ID: 7, Name: "Alertas <altas>", Enabled: true, Module: "*", Actions: []string{"CREATE", "UPDATE"},
		Conditions: []json.RawMessage{json.RawMessage(`{"op": "eq", "field": "Nivel", "value": "Alto"}`)},
		Steps: []json.RawMessage{
			json.RawMessage(`{"kind": "evaluate", "title": "Evaluar", "minimumLevel": "Alta"}`),
			json.RawMessage(`{"kind": "notify", "title": "Aviso {{module}}"}`),
			json.RawMessage(`{"kind": "channel", "title": "Canal", "channelId": 3}`),
			// Fields the step lacks stay out, as undefined does in JSON.stringify.
			json.RawMessage(`{"kind": "evaluate"}`),
		},
		CreatedBy: "admin", UpdatedAt: at,
	}
	got := encode(t, RuleOut(rule))
	want := `{"id":7,"name":"Alertas <altas>","enabled":true,"module":"*","actions":["CREATE","UPDATE"],` +
		`"conditions":[{"op":"eq","field":"Nivel","value":"Alto"}],` +
		`"steps":[{"kind":"evaluate","title":"Evaluar","minimum_level":"Alta"},{"kind":"notify","title":"Aviso {{module}}"},` +
		`{"kind":"channel","channel_id":3,"title":"Canal"},{"kind":"evaluate"}],` +
		`"created_by":"admin","updated_at":"2026-11-03T10:00:00Z"}`
	if got != want {
		t.Fatalf("got  %s\nwant %s", got, want)
	}
}

func TestRuleOutOfARuleWithoutConditionsOrSteps(t *testing.T) {
	got := encode(t, RuleOut(Rule{ID: 1, Name: "r", Module: "Eventos", Actions: []string{"CREATE"}, UpdatedAt: at}))
	want := `{"id":1,"name":"r","enabled":false,"module":"Eventos","actions":["CREATE"],"conditions":[],"steps":[],"created_by":"","updated_at":"2026-11-03T10:00:00Z"}`
	if got != want {
		t.Fatalf("got  %s\nwant %s", got, want)
	}
}

func TestRunOutHidesTheDetailOfRestrictedRecords(t *testing.T) {
	finished := at.Add(time.Minute)
	run := Run{
		ID: 4, RuleID: 7, RuleName: "Regla", Kind: "notify", Status: "done", Attempts: 1,
		Event: json.RawMessage(`{"at": "2026-11-03T09:59:59.999Z", "action": "UPDATE", "detail": "Nombre secreto",
			"module": "Actores", "record": {"payload": {"x": 1}, "marking": "restringido"}, "auditId": 41, "recordId": "A-1"}`),
		CreatedAt: at, FinishedAt: &finished, NextAttemptAt: at,
	}
	got, err := RunOut(run)
	if err != nil {
		t.Fatal(err)
	}
	want := `{"id":4,"rule_id":7,"rule_name":"Regla","kind":"notify","status":"done","attempts":1,"last_error":"",` +
		`"event":{"audit_id":41,"at":"2026-11-03T09:59:59Z","module":"Actores","record_id":"A-1","action":"UPDATE","detail":""},` +
		`"created_at":"2026-11-03T10:00:00Z","finished_at":"2026-11-03T10:01:00Z","next_attempt_at":"2026-11-03T10:00:00Z"}`
	if s := encode(t, got); s != want {
		t.Fatalf("got  %s\nwant %s", s, want)
	}

	// Other markings and events without a record keep the detail; a pending run has no finish.
	run.Event = json.RawMessage(`{"at": "2026-11-03T09:00:00Z", "action": "CREATE", "detail": "Visible", "module": "Eventos", "record": null, "auditId": 42, "recordId": null}`)
	run.FinishedAt, run.Status, run.LastError = nil, "pending", "HTTP 500"
	got, err = RunOut(run)
	if err != nil {
		t.Fatal(err)
	}
	want = `{"id":4,"rule_id":7,"rule_name":"Regla","kind":"notify","status":"pending","attempts":1,"last_error":"HTTP 500",` +
		`"event":{"audit_id":42,"at":"2026-11-03T09:00:00Z","module":"Eventos","record_id":null,"action":"CREATE","detail":"Visible"},` +
		`"created_at":"2026-11-03T10:00:00Z","finished_at":null,"next_attempt_at":"2026-11-03T10:00:00Z"}`
	if s := encode(t, got); s != want {
		t.Fatalf("got  %s\nwant %s", s, want)
	}
}

func TestRunOutFailsOnAnEventWithoutADate(t *testing.T) {
	// isoSeconds(new Date(undefined)) throws in TypeScript: the route answers 500.
	for _, event := range []string{`{"auditId": 1}`, `{"at": "mañana"}`, `[]`} {
		if _, err := RunOut(Run{Event: json.RawMessage(event)}); err == nil {
			t.Errorf("%s: no error", event)
		}
	}
}

func TestInboxOutLinksRecordsAndDigitalAlerts(t *testing.T) {
	s := func(v string) *string { return &v }
	inbox := Inbox{Unread: 2, Items: []Notification{
		{ID: 3, Title: "Alerta", Body: "b", Module: s("InteligenciaDigital"), RecordID: s("AL 1/2"), CreatedAt: at},
		{ID: 2, Title: "Evento", Body: "", Module: s("Eventos"), RecordID: s("EV-1"), CreatedAt: at, Read: true},
		{ID: 1, Title: "Sin registro", Module: s("Eventos"), RecordID: s(""), CreatedAt: at},
		{ID: 0, Title: "Sistema", Module: nil, RecordID: nil, CreatedAt: at},
	}}
	got := encode(t, InboxOut(inbox))
	want := `{"unread":2,"items":[` +
		`{"id":3,"title":"Alerta","body":"b","module":"InteligenciaDigital","record_id":"AL 1/2","href":"/inteligencia-redes?alert=AL%201%2F2","link":null,"created_at":"2026-11-03T10:00:00Z","read":false},` +
		`{"id":2,"title":"Evento","body":"","module":"Eventos","record_id":"EV-1","link":{"module":"eventos","id":"EV-1"},"created_at":"2026-11-03T10:00:00Z","read":true},` +
		`{"id":1,"title":"Sin registro","body":"","module":"Eventos","record_id":"","link":null,"created_at":"2026-11-03T10:00:00Z","read":false},` +
		`{"id":0,"title":"Sistema","body":"","module":null,"record_id":null,"link":null,"created_at":"2026-11-03T10:00:00Z","read":false}]}`
	if got != want {
		t.Fatalf("got  %s\nwant %s", got, want)
	}
	if got := encode(t, InboxOut(Inbox{})); got != `{"unread":0,"items":[]}` {
		t.Fatalf("empty inbox: %s", got)
	}
}
