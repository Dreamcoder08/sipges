package infrastructure

import (
	"encoding/json"
	"os"
	"regexp"
	"strings"
	"testing"
	"time"
)

// passwordRow is one row of testdata/passwords.json: a hash TypeScript wrote or refuses, and what
// portablePasswordHasher answered for it.
type passwordRow struct {
	Name     string `json:"name"`
	Password string `json:"password"`
	Stored   string `json:"stored"`
	OK       bool   `json:"ok"`
	Rehash   bool   `json:"rehash"`
}

func TestPasswordsVerifyWhatTypeScriptDecided(t *testing.T) {
	raw, err := os.ReadFile("testdata/passwords.json")
	if err != nil {
		t.Fatal(err)
	}
	var rows []passwordRow
	if err := json.Unmarshal(raw, &rows); err != nil {
		t.Fatal(err)
	}
	accepted := 0
	for _, row := range rows {
		if row.OK {
			accepted++
		}
		if got := (Passwords{}).Verify(row.Password, row.Stored); got != row.OK {
			t.Errorf("%s: Verify = %v, TypeScript %v", row.Name, got, row.OK)
		}
		if got := (Passwords{}).NeedsRehash(row.Stored); got != row.Rehash {
			t.Errorf("%s: NeedsRehash = %v, TypeScript %v", row.Name, got, row.Rehash)
		}
	}
	if len(rows) < 80 || accepted < 20 {
		t.Fatalf("%d rows, %d accepted: the fixture lost its cases", len(rows), accepted)
	}
}

func TestHashWritesTheFormatTypeScriptWrites(t *testing.T) {
	stored, err := Passwords{}.Hash("synthetic-password-01")
	if err != nil {
		t.Fatal(err)
	}
	if !regexp.MustCompile(`^\$argon2id\$v=19\$m=19456,t=2,p=1\$[A-Za-z0-9+/]{22}\$[A-Za-z0-9+/]{43}$`).MatchString(stored) {
		t.Fatalf("stored = %q", stored)
	}
	if !(Passwords{}).Verify("synthetic-password-01", stored) || (Passwords{}).Verify("synthetic-password-02", stored) {
		t.Fatal("a new hash must verify its own password only")
	}
	if (Passwords{}).NeedsRehash(stored) {
		t.Fatal("a new hash needs no rehash")
	}
	again, _ := Passwords{}.Hash("synthetic-password-01")
	if strings.Split(again, "$")[4] == strings.Split(stored, "$")[4] {
		t.Fatal("two hashes shared a salt")
	}
}

func TestArgon2RunsAtMostTwoAtOnce(t *testing.T) {
	// Both slots taken: a hash, which takes far less than the wait below, must block until one
	// frees. Slowness can only make this pass by accident, never fail by accident.
	argon2Slots <- struct{}{}
	argon2Slots <- struct{}{}
	done := make(chan struct{})
	go func() {
		_, _ = Passwords{}.Hash("synthetic-password-01")
		close(done)
	}()
	select {
	case <-done:
		t.Fatal("a hash ran with no free slot")
	case <-time.After(500 * time.Millisecond):
	}
	<-argon2Slots
	<-done
	<-argon2Slots
}
