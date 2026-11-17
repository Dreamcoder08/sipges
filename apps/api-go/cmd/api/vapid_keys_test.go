package main

import (
	"bytes"
	"strings"
	"testing"
)

func TestVapidKeysPrintsTheTwoEnvLines(t *testing.T) {
	t.Parallel()
	var out bytes.Buffer
	if err := dispatch(t.Context(), []string{"vapid-keys"}, noEnvironment, &out, nil); err != nil {
		t.Fatal(err)
	}
	lines := strings.Split(strings.TrimSpace(out.String()), "\n")
	if len(lines) != 2 || !strings.HasPrefix(lines[0], "SIPGES_VAPID_PUBLIC_KEY=") ||
		!strings.HasPrefix(lines[1], "SIPGES_VAPID_PRIVATE_KEY=") || len(lines[0]) < 80 || len(lines[1]) < 60 {
		t.Fatalf("output = %q", out.String())
	}
}
