package infrastructure

import (
	"crypto/pbkdf2"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
	"fmt"
	"regexp"
	"strconv"
	"strings"

	"golang.org/x/crypto/argon2"
)

// OWASP Password Storage Cheat Sheet minimum for Argon2id: m=19 MiB, t=2, p=1; 16 bytes of salt
// and 32 of digest, the same as both TypeScript hashers.
const (
	argon2Memory  = 19456
	argon2Time    = 2
	argon2Threads = 1
	argon2Salt    = 16
	argon2Digest  = 32
)

// The most a stored hash may ask for (portable-password-hasher.ts LIMIT): a crafted or corrupted
// hash fails fast instead of allocating gigabytes or burning the CPU.
const (
	limitMemory = 65536
	limitTime   = 10
	limitThread = 4
	limitPBKDF2 = 1_000_000
)

const (
	legacyPrefix = "pbkdf2_sha256$"
	argon2Prefix = "$argon2id$"
)

var (
	// phc is PHC of portable-password-hasher.ts, for Argon2 version 1.3 only.
	phc       = regexp.MustCompile(`^\$argon2id\$v=19\$m=(\d{1,7}),t=(\d{1,4}),p=(\d{1,3})\$([^$]+)\$([^$]+)$`)
	base64Set = regexp.MustCompile(`^[A-Za-z0-9+/]+$`)
	// legacyHex is HEX of legacy-hash.ts: lower case, whole bytes.
	legacyHex  = regexp.MustCompile(`^(?:[0-9a-f]{2})+$`)
	legacyIter = regexp.MustCompile(`^\d{1,7}$`)
)

// argon2Slots bounds the Argon2id computations running at once (MAX_CONCURRENT_ARGON2): each one
// allocates up to 64 MiB, so an unbounded burst of logins could exhaust the container. Blocked
// senders queue in arrival order.
var argon2Slots = make(chan struct{}, 2)

func runArgon2(password string, salt []byte, m, t uint32, p uint8, length uint32) []byte {
	argon2Slots <- struct{}{}
	defer func() { <-argon2Slots }()
	return argon2.IDKey([]byte(password), salt, t, m, p, length)
}

// Passwords is portablePasswordHasher, the hasher production runs: the same parameters, PHC
// encoding and limits, so a hash either runtime writes verifies in the other. Passwords reach it
// as the UTF-8 bytes of the decoded form, as they do in TypeScript.
type Passwords struct{}

// Hash returns a new `$argon2id$v=19$m=19456,t=2,p=1$<salt>$<digest>` string.
func (Passwords) Hash(password string) (string, error) {
	salt := make([]byte, argon2Salt)
	if _, err := rand.Read(salt); err != nil {
		return "", fmt.Errorf("password salt: %w", err)
	}
	digest := runArgon2(password, salt, argon2Memory, argon2Time, argon2Threads, argon2Digest)
	return fmt.Sprintf("$argon2id$v=19$m=%d,t=%d,p=%d$%s$%s", argon2Memory, argon2Time, argon2Threads,
		base64.RawStdEncoding.EncodeToString(salt), base64.RawStdEncoding.EncodeToString(digest)), nil
}

// Verify checks password against an Argon2id or legacy PBKDF2 hash in constant time. Anything
// else, or a hash outside the limits, is false.
func (Passwords) Verify(password, stored string) bool {
	if strings.HasPrefix(stored, legacyPrefix) {
		return verifyLegacy(password, stored)
	}
	return verifyArgon2(password, stored)
}

// NeedsRehash is true for every hash that is not Argon2id: a legacy hash is replaced on login.
func (Passwords) NeedsRehash(stored string) bool { return !strings.HasPrefix(stored, argon2Prefix) }

func verifyArgon2(password, stored string) bool {
	match := phc.FindStringSubmatch(stored)
	if match == nil {
		return false
	}
	m, _ := strconv.Atoi(match[1]) // up to 7 digits
	t, _ := strconv.Atoi(match[2])
	p, _ := strconv.Atoi(match[3])
	if p < 1 || p > limitThread || t < 1 || t > limitTime || m < 8*p || m > limitMemory {
		return false
	}
	salt, ok := fromBase64(match[4])
	if !ok || len(salt) < 8 {
		return false
	}
	digest, ok := fromBase64(match[5])
	if !ok || len(digest) < 16 || len(digest) > 64 {
		return false
	}
	candidate := runArgon2(password, salt, uint32(m), uint32(t), uint8(p), uint32(len(digest))) //nolint:gosec // bounded above
	return subtle.ConstantTimeCompare(candidate, digest) == 1
}

// fromBase64 is fromBase64 of portable-password-hasher.ts: atob over the standard alphabet with
// no padding, so stray bits after the last byte are ignored. The set check also keeps out the
// line breaks Go's decoder would skip.
func fromBase64(text string) ([]byte, bool) {
	if !base64Set.MatchString(text) {
		return nil, false
	}
	out, err := base64.RawStdEncoding.DecodeString(text)
	return out, err == nil
}

// legacyHash is a parsed `pbkdf2_sha256$<iterations>$<saltHex>$<digestHex>` from app.py.
type legacyHash struct {
	iterations int
	salt       []byte
	digest     []byte
}

// parseLegacyHash is parseLegacyHash of legacy-hash.ts; ok=false for anything else.
func parseLegacyHash(stored string) (legacyHash, bool) {
	parts := strings.Split(stored, "$")
	if len(parts) != 4 || parts[0] != "pbkdf2_sha256" {
		return legacyHash{}, false
	}
	if !legacyIter.MatchString(parts[1]) || !legacyHex.MatchString(parts[2]) || !legacyHex.MatchString(parts[3]) {
		return legacyHash{}, false
	}
	iterations, _ := strconv.Atoi(parts[1]) // up to 7 digits
	if iterations < 1 {
		return legacyHash{}, false // zero iterations is not a hash
	}
	salt, _ := hex.DecodeString(parts[2])
	digest, _ := hex.DecodeString(parts[3])
	return legacyHash{iterations, salt, digest}, true
}

func verifyLegacy(password, stored string) bool {
	legacy, ok := parseLegacyHash(stored)
	if !ok || legacy.iterations > limitPBKDF2 {
		return false
	}
	candidate, err := pbkdf2.Key(sha256.New, password, legacy.salt, legacy.iterations, len(legacy.digest))
	if err != nil {
		return false
	}
	return subtle.ConstantTimeCompare(candidate, legacy.digest) == 1
}
