package http

import (
	"context"
	"testing"

	"github.com/Dreamcoder08/sipges/apps/api-go/internal/platform/database"
)

func TestARequestTickOutlivesTheClientButKeepsTheActor(t *testing.T) {
	parent, cancel := context.WithCancel(database.WithActor(context.Background(), database.Actor{Name: "boss", Clearance: database.ClearanceFull}))
	ctx, stop := detached(parent)
	defer stop()
	cancel() // the client disconnects mid-tick
	if ctx.Err() != nil {
		t.Fatal("the client's cancellation reached the tick")
	}
	if actor, ok := database.ActorFrom(ctx); !ok || actor.Name != "boss" {
		t.Fatal("the tick lost the request's actor")
	}
	if _, ok := ctx.Deadline(); !ok {
		t.Fatal("the tick has no bound")
	}
}
