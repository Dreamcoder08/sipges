package domain

import (
	"crypto/sha256"
	"encoding/hex"
	"regexp"
	"strings"
)

// TenantPrefix is tenantPrefix of evidence-service.ts: the first 24 hex characters of the
// SHA-256 of the tenant id, so tenants never share an object prefix even if a key were guessed.
func TenantPrefix(tenantID string) string {
	sum := sha256.Sum256([]byte(tenantID))
	return hex.EncodeToString(sum[:])[:24]
}

// StorageKey is the object key of a new upload: `<tenant prefix>/<32 random hex>_<safe name>`.
// The name comes from SafeUploadName, so the key holds only [0-9a-f/A-Za-z._-].
func StorageKey(tenantID, randomHex32, safeName string) string {
	return TenantPrefix(tenantID) + "/" + strings.ToLower(randomHex32) + "_" + safeName
}

// objectKey is KEY_PATTERN of local-object-storage.ts.
var objectKey = regexp.MustCompile(`^[0-9a-f]{24}/[A-Za-z0-9._-]+$`)

// ValidObjectKey reports whether key has the layout every adapter accepts; anything else is a
// bug or a tampered row, never a path to follow.
func ValidObjectKey(key string) bool { return objectKey.MatchString(key) }
