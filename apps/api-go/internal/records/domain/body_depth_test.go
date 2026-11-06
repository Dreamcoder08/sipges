package domain_test

import (
	"errors"
	"strings"
	"testing"

	"github.com/Dreamcoder08/sipges/apps/api-go/internal/records/domain"
)

func nested(open, closing string, depth int) []byte {
	return []byte(strings.Repeat(open, depth) + strings.Repeat(closing, depth))
}

func TestBodiesNestedPastTheLimitAreRefused(t *testing.T) {
	for name, deep := range map[string]func(int) []byte{
		"arrays":  func(n int) []byte { return nested("[", "]", n) },
		"objects": func(n int) []byte { return []byte(strings.Repeat(`{"a":`, n) + "1" + strings.Repeat("}", n)) },
	} {
		t.Run(name, func(t *testing.T) {
			if _, err := domain.ParseBody(deep(domain.MaxBodyDepth)); err != nil {
				t.Fatalf("depth at the limit: %v", err)
			}
			if _, err := domain.ParseBody(deep(domain.MaxBodyDepth + 1)); !errors.Is(err, domain.ErrJSONSyntax) {
				t.Fatalf("depth past the limit: %v", err)
			}
		})
	}
}

// Sixteen million brackets, the most the global body limit lets through, must not exhaust the stack.
func TestAnUnclosedNestingAtTheBodyLimitIsRefusedEarly(t *testing.T) {
	if _, err := domain.ParseBody([]byte(strings.Repeat("[", 16<<20))); !errors.Is(err, domain.ErrJSONSyntax) {
		t.Fatalf("err = %v", err)
	}
}
