package domain

import (
	"crypto/sha256"
	"crypto/subtle"
	"regexp"
	"strings"
)

// Machine credentials (domain/api-key.ts, docs/adr/0014 §6): token shape, the stored hash and
// the payload's project.

// Principal is ApiPrincipal: a key as the API knows it once authenticated.
type Principal struct {
	KeyID     int
	TenantID  string
	Name      string
	Access    string
	Clearance string
}

// ProjectID is the key's project: the second part of tenantId split at '/', or the empty string.
func (p Principal) ProjectID() string {
	parts := strings.Split(p.TenantID, "/")
	if len(parts) < 2 {
		return ""
	}
	return parts[1]
}

var token = regexp.MustCompile(`^mscli_([a-f0-9]{12})_([A-Za-z0-9_-]{43})$`)

// ParseToken is parseToken: `mscli_<prefix>_<secret>`, after JavaScript's trim.
func ParseToken(t string) (prefix, secret string, ok bool) {
	m := token.FindStringSubmatch(TrimJS(t))
	if m == nil {
		return "", "", false
	}
	return m[1], m[2], true
}

// BearerToken is bearerToken: what follows "Bearer " (case-sensitive), trimmed; ok is false
// without that scheme.
func BearerToken(header string, present bool) (string, bool) {
	if !present || !strings.HasPrefix(header, "Bearer ") {
		return "", false
	}
	return TrimJS(header[7:]), true
}

// KeyActor is keyActor: the audit actor of writes made with a key, never mistaken for a person.
func KeyActor(p Principal) string { return Slice16("api:"+p.Name, 120) }

// SecretMatches is keyCrypto.matches: the SHA-256 of the secret against the stored hash, in
// constant time. The stored hash is decoded as Node's Buffer.from(hash, 'hex') does: pairs of
// hexadecimal digits up to the first pair that is not one.
func SecretMatches(secret, storedHash string) bool {
	expected := nodeHex(storedHash)
	actual := sha256.Sum256([]byte(secret))
	return len(expected) == len(actual) && subtle.ConstantTimeCompare(expected, actual[:]) == 1
}

func nodeHex(s string) []byte {
	out := make([]byte, 0, len(s)/2)
	for i := 0; i+1 < len(s); i += 2 {
		hi, ok1 := hexNibble(s[i])
		lo, ok2 := hexNibble(s[i+1])
		if !ok1 || !ok2 {
			break
		}
		out = append(out, hi<<4|lo)
	}
	return out
}

func hexNibble(c byte) (byte, bool) {
	switch {
	case c >= '0' && c <= '9':
		return c - '0', true
	case c|0x20 >= 'a' && c|0x20 <= 'f':
		return c | 0x20 - 'a' + 10, true
	}
	return 0, false
}
