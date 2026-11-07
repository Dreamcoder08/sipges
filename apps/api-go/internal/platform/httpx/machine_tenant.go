package httpx

import "context"

type machineTenantKey struct{}

type machineTenant struct{ id string }

// WatchMachineTenant gives a middleware a way to hear which tenant a machine route wrote to. A
// machine route has no session or project scope, so only its handler knows the tenant, and only
// after it has verified the credential; read returns "" until the handler reports one.
func WatchMachineTenant(ctx context.Context) (watched context.Context, read func() string) {
	slot := &machineTenant{}
	return context.WithValue(ctx, machineTenantKey{}, slot), func() string { return slot.id }
}

// SetMachineTenant reports the tenant a machine route committed a write to. Its value must come
// from the verified credential, never from the request. Without a watcher it does nothing.
func SetMachineTenant(ctx context.Context, tenantID string) {
	if slot, ok := ctx.Value(machineTenantKey{}).(*machineTenant); ok {
		slot.id = tenantID
	}
}
