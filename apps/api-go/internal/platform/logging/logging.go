// Package logging builds the structured JSON logger (log/slog) of the API.
package logging

import (
	"io"
	"log/slog"
	"strings"
)

// Redacted replaces the value of any attribute whose key names a secret.
const Redacted = "[redacted]"

// secretKeys are matched case-insensitively as substrings of attribute keys: a defence in depth,
// since callers must not log secrets, tokens or record payloads in the first place (ADR 0007).
var secretKeys = []string{"password", "secret", "token", "authorization", "cookie", "database_url", "dsn", "key"}

// New returns a JSON logger writing to w at level.
func New(w io.Writer, level slog.Leveler) *slog.Logger {
	return slog.New(slog.NewJSONHandler(w, &slog.HandlerOptions{
		Level: level,
		ReplaceAttr: func(_ []string, a slog.Attr) slog.Attr {
			if a.Value.Kind() != slog.KindGroup && isSecret(a.Key) {
				return slog.String(a.Key, Redacted)
			}
			return a
		},
	}))
}

func isSecret(key string) bool {
	key = strings.ToLower(key)
	for _, s := range secretKeys {
		if strings.Contains(key, s) {
			return true
		}
	}
	return false
}
