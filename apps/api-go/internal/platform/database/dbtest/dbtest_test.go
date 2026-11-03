package dbtest_test

import (
	"context"
	"os"
	"sync"
	"testing"
	"time"

	"github.com/Dreamcoder08/sipges/apps/api-go/internal/platform/database/dbtest"
)

// go test runs packages in parallel, each creating its own scratch database. The migrations
// create and later rename a cluster-wide role (0003 creates mascli_tenant, 0030 renames it), so
// two scratch databases migrating at once must not interleave: one renaming the role while the
// other still grants it failed with `role "mascli_tenant" does not exist` in CI.
func TestConcurrentScratchDatabasesMigrate(t *testing.T) {
	adminURL := os.Getenv("SIPGES_TEST_DATABASE_URL")
	if adminURL == "" {
		t.Skip("SIPGES_TEST_DATABASE_URL not set")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()

	const n = 4
	var wg sync.WaitGroup
	errs := make([]error, n)
	for i := range n {
		wg.Add(1)
		go func() {
			defer wg.Done()
			scratch, err := dbtest.NewScratch(ctx, adminURL)
			if err != nil {
				errs[i] = err
				return
			}
			errs[i] = scratch.Drop(ctx)
		}()
	}
	wg.Wait()
	for i, err := range errs {
		if err != nil {
			t.Errorf("scratch %d: %v", i, err)
		}
	}
}
