package localpg

import (
	"os"
	"testing"
	"time"
)

// lockHolderEnv makes this test binary act as another SIPGES instance: it takes the lock file
// named by the variable, reports it with a ".held" file and keeps it until it is killed.
const lockHolderEnv = "SIPGES_LOCALPG_TEST_LOCK_HOLDER"

func TestMain(m *testing.M) {
	if path := os.Getenv(lockHolderEnv); path != "" {
		holdLock(path)
		return
	}
	os.Exit(m.Run())
}

func holdLock(path string) {
	f, err := os.OpenFile(path, os.O_CREATE|os.O_RDWR, 0o600)
	if err != nil || lockFile(f) != nil {
		os.Exit(2)
	}
	_ = os.WriteFile(path+".held", nil, 0o600)
	time.Sleep(time.Minute)
	os.Exit(0)
}
