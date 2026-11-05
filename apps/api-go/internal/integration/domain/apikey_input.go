package domain

import (
	"crypto/sha256"
	"encoding/hex"
	"strings"
)

// keyNameMax is ApiKeyIn's bound on a key's name, in code points, as Zod 4 counts.
const keyNameMax = 80

// KeyInput is ApiKeyIn after parsing.
type KeyInput struct {
	Name      string
	Access    string
	Clearance string
}

// NewKey is a key ready to store: the secret itself is never kept.
type NewKey struct {
	KeyInput
	Prefix     string
	SecretHash string
}

// keyOption is z.enum(values).default(values[0]), with its Zod message.
func keyOption(v any, first, second string) (string, issues) {
	if isUndefined(v) {
		return first, nil
	}
	if s, ok := v.(string); ok && (s == first || s == second) {
		return s, nil
	}
	var p issues
	p.add("invalid_value", `Invalid option: expected one of "`+first+`"|"`+second+`"`, flowContinue)
	return "", p
}

// ParseKeyInput is ApiKeyIn.safeParse.
func ParseKeyInput(body any) (KeyInput, []Issue) {
	var p issues
	o, ok := object(body, &p)
	if !ok {
		return KeyInput{}, toLoc(p, body)
	}
	var in KeyInput
	name, child := trimmed(field(o, "name"), keyNameMax)
	if !child.aborted() && strings.ContainsRune(name, 0) {
		child.add("custom", "Text must not contain NUL characters", flowContinue)
	}
	in.Name = name
	p.merge("name", child)
	in.Access, child = keyOption(field(o, "access"), "read", "write")
	p.merge("access", child)
	in.Clearance, child = keyOption(field(o, "clearance"), "limited", "full")
	p.merge("clearance", child)
	if len(p) > 0 {
		return KeyInput{}, toLoc(p, body)
	}
	return in, nil
}

// FormatToken is formatToken: `mscli_<prefix>_<secret>`. The prefix finds the row, the secret is
// compared by hash.
func FormatToken(prefix, secret string) string { return "mscli_" + prefix + "_" + secret }

// HashSecret is keyCrypto.hash: random 256-bit secrets need no slow hash.
func HashSecret(secret string) string {
	sum := sha256.Sum256([]byte(secret))
	return hex.EncodeToString(sum[:])
}
