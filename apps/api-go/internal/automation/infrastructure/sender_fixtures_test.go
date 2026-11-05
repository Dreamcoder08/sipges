package infrastructure

import (
	"encoding/json"
	"os"
	"testing"
	"time"

	"github.com/Dreamcoder08/sipges/apps/api-go/internal/automation/application"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/automation/domain"
	records "github.com/Dreamcoder08/sipges/apps/api-go/internal/records/domain"
)

// The requests the TypeScript sender built for every channel kind, recorded by
// ../testdata/generate.mjs with a fetch that captures instead of sending.
type senderFixture struct {
	Message struct {
		ID       string          `json:"id"`
		Title    string          `json:"title"`
		Text     string          `json:"text"`
		TenantID string          `json:"tenantId"`
		At       string          `json:"at"`
		Event    json.RawMessage `json:"event"`
	} `json:"message"`
	LongMessage struct {
		Title string `json:"title"`
		Text  string `json:"text"`
	} `json:"long_message"`
	Configs  []domain.ChannelConfig `json:"configs"`
	Requests []struct {
		Config  int               `json:"config"`
		Long    bool              `json:"long"`
		URL     string            `json:"url"`
		Headers map[string]string `json:"headers"`
		Body    string            `json:"body"`
	} `json:"requests"`
}

func TestRequestsMatchTheTypeScriptSender(t *testing.T) {
	raw, err := os.ReadFile("../testdata/fixtures.json")
	if err != nil {
		t.Fatal(err)
	}
	var f senderFixture
	if err := json.Unmarshal(raw, &f); err != nil {
		t.Fatal(err)
	}
	at, _ := time.Parse(time.RFC3339Nano, f.Message.At)
	event, err := records.ParseObject(f.Message.Event)
	if err != nil {
		t.Fatal(err)
	}
	base := application.Message{ID: f.Message.ID, Title: f.Message.Title, Text: f.Message.Text,
		TenantID: f.Message.TenantID, At: at, Event: event}
	if len(f.Requests) != len(f.Configs)+2 {
		t.Fatalf("%d requests recorded", len(f.Requests))
	}
	for i, want := range f.Requests {
		m := base
		if want.Long {
			m.Title, m.Text = f.LongMessage.Title, f.LongMessage.Text
		}
		got := RequestFor(f.Configs[want.Config], m)
		if got.URL != want.URL {
			t.Errorf("%d: url %q, want %q", i, got.URL, want.URL)
		}
		// encoding/json read the recorded body as text; JSON.stringify never leaves a lone
		// surrogate unescaped, so the bytes compare directly.
		if string(got.Body) != want.Body {
			t.Errorf("%d %s: body\n got %s\nwant %s", i, f.Configs[want.Config].Kind, got.Body, want.Body)
		}
		headers := map[string]string{"content-type": "application/json", "user-agent": "SIPGES-Automation/1"}
		for _, h := range got.Headers {
			headers[h[0]] = h[1]
		}
		if len(headers) != len(want.Headers) {
			t.Errorf("%d: headers %v, want %v", i, headers, want.Headers)
		}
		for k, v := range want.Headers {
			if headers[k] != v {
				t.Errorf("%d: header %s = %q, want %q", i, k, headers[k], v)
			}
		}
	}
}
