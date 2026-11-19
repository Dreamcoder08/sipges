package application

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"testing"

	"github.com/Dreamcoder08/sipges/apps/api-go/internal/indicators/domain"
)

// capturingEngine keeps a copy of each request and answers {}.
type capturingEngine struct{ requests [][]byte }

func (e *capturingEngine) Call(_ context.Context, request []byte) (json.RawMessage, error) {
	e.requests = append(e.requests, bytes.Clone(request))
	return json.RawMessage(`{}`), nil
}

// previousRequest is how the service wrote an engine request before callWithRecords:
// request(op, "config", config, "records", records.JSON()) with the JSON encoder quoting every
// module name and record id, and AppendMember adding the id.
func previousRequest(t *testing.T, op string, config json.RawMessage, records domain.Records) []byte {
	t.Helper()
	quote := func(s string) []byte {
		b, err := domain.Encode(s)
		if err != nil {
			t.Fatal(err)
		}
		return b
	}
	var r bytes.Buffer
	r.WriteByte('{')
	for i, module := range domain.Modules {
		if i > 0 {
			r.WriteByte(',')
		}
		r.Write(quote(module))
		r.WriteString(":[")
		for j, rec := range records[module] {
			if j > 0 {
				r.WriteByte(',')
			}
			obj, err := domain.AppendMember(rec.Payload, "_id", quote(rec.ID))
			if err != nil {
				t.Fatal(err)
			}
			r.Write(obj)
		}
		r.WriteByte(']')
	}
	r.WriteByte('}')
	var b bytes.Buffer
	fmt.Fprintf(&b, `{"op":%q`, op)
	if config != nil {
		b.WriteString(`,"config":`)
		b.Write(config)
	}
	b.WriteString(`,"records":`)
	b.Write(r.Bytes())
	b.WriteByte('}')
	return b.Bytes()
}

func TestRecordsRequestIsThePreviousEncoding(t *testing.T) {
	t.Parallel()
	edge := domain.Records{
		"Eventos": {
			{ID: "EVE-1", Payload: json.RawMessage(`{"a": 1, "b": "x"}`)},
			{ID: `quote"back\slash`, Payload: json.RawMessage(` { "_id": "old", "n": null } `)},
			{ID: "ñandú 💡", Payload: json.RawMessage(`{}`)},
			{ID: "ctl\x01\ttab", Payload: json.RawMessage("{\n\t\"k\": [1, 2]\n}")},
			{ID: "<html>&amp;", Payload: json.RawMessage(`{"h": "<b>&"}`)},
			{ID: "del\x7f", Payload: json.RawMessage(`{"z": true}`)},
			{ID: "line sep", Payload: json.RawMessage(`{"y": 1.5e3}`)},
		},
		"Alertas": {{ID: "", Payload: json.RawMessage(`{"empty id": ""}`)}},
	}
	config := json.RawMessage(`{"weights": {"G": 0.5}, "version": "v1"}`)
	for name, tc := range map[string]struct {
		records domain.Records
		config  json.RawMessage
	}{
		"synthetic":            {benchRecords(), nil},
		"synthetic and config": {benchRecords(), config},
		"edge cases":           {edge, config},
		"no records":           {domain.Records{}, nil},
	} {
		engine := &capturingEngine{}
		s := &Service{Engine: engine}
		for _, op := range []string{"irsa", "indicators"} {
			if _, err := s.callWithRecords(context.Background(), op, tc.config, tc.records); err != nil {
				t.Fatalf("%s %s: %v", name, op, err)
			}
			got := engine.requests[len(engine.requests)-1]
			if want := previousRequest(t, op, tc.config, tc.records); !bytes.Equal(got, want) {
				t.Errorf("%s %s: request differs from the previous encoding\n got %.300s\nwant %.300s", name, op, got, want)
			}
		}
		// The pooled buffer is reused: a second request must not carry bytes of the first.
		if _, err := s.callWithRecords(context.Background(), "irsa", nil, domain.Records{}); err != nil {
			t.Fatal(err)
		}
		if got, want := engine.requests[len(engine.requests)-1], previousRequest(t, "irsa", nil, domain.Records{}); !bytes.Equal(got, want) {
			t.Errorf("%s: reused buffer gave %s", name, got)
		}
	}
}

func TestRecordsRequestRefusesAPayloadThatIsNotAnObject(t *testing.T) {
	t.Parallel()
	engine := &capturingEngine{}
	s := &Service{Engine: engine}
	_, err := s.callWithRecords(context.Background(), "irsa", nil, domain.Records{"Eventos": {{ID: "X", Payload: json.RawMessage(`[1]`)}}})
	if err == nil || len(engine.requests) != 0 {
		t.Fatalf("err = %v, %d requests sent", err, len(engine.requests))
	}
}
