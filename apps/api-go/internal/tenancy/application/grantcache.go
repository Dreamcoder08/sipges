// Package application holds the per-request project resolution of
// apps/api/src/contexts/tenancy/application: the grant cache and the scope resolver.
package application

import (
	"container/list"
	"context"
	"slices"
	"sync"
	"time"

	"github.com/Dreamcoder08/sipges/apps/api-go/internal/tenancy/domain"
)

// GrantCacheTTL is GRANT_CACHE_TTL_MS: how long a user's grants answer the per-request project
// resolution in one process.
const GrantCacheTTL = 30 * time.Second

const maxCachedUsers = 1000

// LoadGrants reads one user's grants, ordered by company and project.
type LoadGrants func(ctx context.Context, username string) ([]domain.Grant, error)

type cached struct {
	username string
	at       time.Time
	grants   []domain.Grant
}

// GrantCache is grant-cache.ts: grants per user for the request path. Forget drops a copy at
// once, and a lookup that started before any Forget never stores what it read (one generation
// counter for all users). Other processes (the TypeScript isolates included) keep their copy
// for at most the TTL, so a revoked project can still resolve there for up to 30 s. Only
// settled values are kept; no request waits on another's lookup.
type GrantCache struct {
	load LoadGrants
	now  func() time.Time

	mu         sync.Mutex
	entries    map[string]*list.Element
	order      *list.List // insertion order, oldest first, as a JavaScript Map iterates
	generation uint64
}

// NewGrantCache builds a cache over load; now nil means time.Now.
func NewGrantCache(load LoadGrants, now func() time.Time) *GrantCache {
	if now == nil {
		now = time.Now
	}
	c := &GrantCache{load: load, now: now, entries: map[string]*list.Element{}, order: list.New()}
	track(c)
	return c
}

// Get returns a copy of the user's grants, so no caller can change the cached ones.
func (c *GrantCache) Get(ctx context.Context, username string) ([]domain.Grant, error) {
	now := c.now()
	c.mu.Lock()
	if el, ok := c.entries[username]; ok {
		entry := el.Value.(*cached)
		if now.Sub(entry.at) < GrantCacheTTL {
			c.mu.Unlock()
			return slices.Clone(entry.grants), nil
		}
	}
	started := c.generation
	c.mu.Unlock()

	grants, err := c.load(ctx, username)
	if err != nil {
		return nil, err
	}
	grants = slices.Clone(grants)

	c.mu.Lock()
	defer c.mu.Unlock()
	if c.generation == started {
		if el, ok := c.entries[username]; ok {
			// A JavaScript Map keeps a key's first insertion position when it is set again.
			el.Value = &cached{username: username, at: now, grants: grants}
		} else {
			if len(c.entries) >= maxCachedUsers {
				oldest := c.order.Front()
				c.order.Remove(oldest)
				delete(c.entries, oldest.Value.(*cached).username)
			}
			c.entries[username] = c.order.PushBack(&cached{username: username, at: now, grants: grants})
		}
	}
	return slices.Clone(grants), nil
}

// Forget drops the user's copy after a grant change in this process.
func (c *GrantCache) Forget(username string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if el, ok := c.entries[username]; ok {
		c.order.Remove(el)
		delete(c.entries, username)
	}
	c.generation++
}
