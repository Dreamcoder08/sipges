package application

import (
	"sync"
	"weak"
)

// processCaches are the grant caches alive in this process. The composition root builds the
// request path's cache (internal/app) and the tenancy write routes are mounted apart from it,
// so a grant change reaches that cache through ForgetEverywhere instead of a shared field.
var processCaches = struct {
	sync.Mutex
	caches []weak.Pointer[GrantCache]
}{}

// track registers c for ForgetEverywhere without keeping it alive.
func track(c *GrantCache) {
	processCaches.Lock()
	defer processCaches.Unlock()
	live := processCaches.caches[:0]
	for _, p := range processCaches.caches {
		if p.Value() != nil {
			live = append(live, p)
		}
	}
	live = append(live, weak.Make(c))
	processCaches.caches = live
}

// ForgetEverywhere is requestGrants.forget for every grant cache of this process: the user's
// copy is dropped and every cache's generation moves on, so a lookup already in flight never
// stores what it read. A cache of another test handler only takes an extra miss.
//
// Other processes, the TypeScript isolates included, are not reached: while both runtimes
// serve, a change made by one is seen by the other within GrantCacheTTL (30 s), the same bound
// the TypeScript API already has between its own isolates.
func ForgetEverywhere(username string) {
	processCaches.Lock()
	caches := make([]*GrantCache, 0, len(processCaches.caches))
	for _, p := range processCaches.caches {
		if c := p.Value(); c != nil {
			caches = append(caches, c)
		}
	}
	processCaches.Unlock()
	for _, c := range caches {
		c.Forget(username)
	}
}
