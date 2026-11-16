package infrastructure_test

import (
	"testing"

	"github.com/Dreamcoder08/sipges/apps/api-go/internal/identity/infrastructure"
)

// The vector apps/api/test/identity/sessions.test.ts pins for session-tokens.ts publicId: both
// APIs show and end a session by the same opaque id.
func TestPublicSessionIDMatchesTypeScript(t *testing.T) {
	const token = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
	hash := infrastructure.HashToken(token)
	if hash != "a8ae6e6ee929abea3afcfc5258c8ccd6f85273e0d4626d26c7279f3250f77c8e" {
		t.Fatalf("hash = %s", hash)
	}
	if got := (infrastructure.Tokens{}).PublicID(hash); got != "d273ad4c4a81cbb4ee407c3c71beef51" {
		t.Fatalf("PublicID = %s", got)
	}
}
