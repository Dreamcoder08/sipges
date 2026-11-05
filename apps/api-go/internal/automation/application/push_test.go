package application

import (
	"bytes"
	"encoding/json"
	"fmt"
	"log/slog"
	"strings"
	"testing"
)

func TestPushValuesStayOutOfLogsAndFormattedErrors(t *testing.T) {
	sub := PushSubscription{Endpoint: "https://push.example.test/capability", P256dh: "key-material", Auth: "auth-material"}
	payload := PushPayload{Title: "title-text", Body: "body-text", URL: "/url-text"}
	var logged bytes.Buffer
	slog.New(slog.NewJSONHandler(&logged, nil)).Info("x", "sub", sub, "payload", payload)
	logger := slog.New(slog.NewJSONHandler(&logged, nil))
	logger.Info("x", "subs", []PushSubscription{sub})
	encoded, err := json.Marshal(struct {
		Sub  PushSubscription
		List []PushSubscription
	}{sub, []PushSubscription{sub}})
	if err != nil {
		t.Fatal(err)
	}
	text := fmt.Sprintf("%v %+v %#v %s %v %+v %#v %s %s %s", sub, sub, sub, sub, payload, payload, payload, payload, logged.String(), encoded)
	for _, value := range []string{"capability", "key-material", "auth-material", "title-text", "body-text", "url-text"} {
		if strings.Contains(text, value) {
			t.Fatalf("%s leaked: %s", value, text)
		}
	}
}
