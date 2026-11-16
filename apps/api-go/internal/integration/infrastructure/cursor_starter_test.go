package infrastructure

import (
	"context"
	"errors"
	"testing"

	"github.com/Dreamcoder08/sipges/apps/api-go/internal/platform/database"
)

func TestAnUnwiredCursorStarterFailsInsteadOfSkippingTheCursor(t *testing.T) {
	var start CursorStarter
	if err := start.run(context.Background(), nil); !errors.Is(err, errNoCursorStarter) {
		t.Fatalf("got %v, want errNoCursorStarter", err)
	}
}

func TestTheCursorStarterRunsInTheCallersTransaction(t *testing.T) {
	var got database.Querier
	start := CursorStarter(func(_ context.Context, q database.Querier) error { got = q; return nil })
	var q database.Querier = fakeQuerier{}
	if err := start.run(context.Background(), q); err != nil || got != q {
		t.Fatalf("starter got %v (err %v), want the caller's querier", got, err)
	}
}

// fakeQuerier only stands for "the caller's transaction"; the starter never calls it here.
type fakeQuerier struct{ database.Querier }
