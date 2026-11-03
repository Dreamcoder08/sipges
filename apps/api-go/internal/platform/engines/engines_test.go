package engines_test

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/Dreamcoder08/sipges/engines/go/wasmengine"

	"github.com/Dreamcoder08/sipges/apps/api-go/internal/platform/engines"
)

func TestSharedRunsBothEmbeddedModules(t *testing.T) {
	ctx := context.Background()
	set, err := engines.Shared(ctx)
	if err != nil {
		t.Fatalf("shared: %v", err)
	}
	defaults, err := set.Indicators.Call(ctx, []byte(`{"op":"defaults"}`))
	if err != nil {
		t.Fatalf("indicators defaults: %v", err)
	}
	if !strings.HasPrefix(string(defaults), `{"indicator_config":`) {
		t.Fatalf("indicators defaults: %.60s", defaults)
	}
	links, err := set.Analytics.Call(ctx, []byte(`{"op":"candidate_links","records":{}}`))
	if err != nil {
		t.Fatalf("analytics candidate_links: %v", err)
	}
	if string(links) != `[]` {
		t.Fatalf("analytics candidate_links on no records: %s", links)
	}
	_, err = set.Analytics.Call(ctx, []byte(`{"op":"unknown"}`))
	var engineErr *wasmengine.Error
	if !errors.As(err, &engineErr) || engineErr.Code != "invalid_request" {
		t.Fatalf("unknown op: want invalid_request, got %v", err)
	}
	again, err := engines.Shared(ctx)
	if err != nil || again != set {
		t.Fatalf("Shared must return the same set: %p %p %v", again, set, err)
	}
}
