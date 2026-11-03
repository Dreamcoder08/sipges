package database

import "context"

// Clearance is the value of app.clearance read by RLS policies on classified records (ADR 0012).
type Clearance string

const (
	// ClearanceFull sees every classification; work outside a request (tools, bootstrap) has it.
	ClearanceFull Clearance = "full"
	// ClearanceLimited is what a request starts with until its role says otherwise.
	ClearanceLimited Clearance = "limited"
)

// Actor is the authenticated user of the current request, written to app.actor for the record
// history trigger (ADR 0011), with the clearance of their role.
type Actor struct {
	Name      string
	Clearance Clearance
}

type actorKey struct{}

// WithActor returns a context whose tenant transactions run as actor.
func WithActor(ctx context.Context, actor Actor) context.Context {
	return context.WithValue(ctx, actorKey{}, actor)
}

// ActorFrom returns the actor set by WithActor, if any.
func ActorFrom(ctx context.Context) (Actor, bool) {
	actor, ok := ctx.Value(actorKey{}).(Actor)
	return actor, ok
}
