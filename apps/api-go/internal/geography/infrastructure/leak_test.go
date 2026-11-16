package infrastructure

import (
	"os"
	"testing"

	"github.com/Dreamcoder08/sipges/apps/api-go/internal/platform/leakcheck"
)

// TestMain fails the package when its tests leave a goroutine that can never wake up.
func TestMain(m *testing.M) { os.Exit(leakcheck.After(m.Run())) }
