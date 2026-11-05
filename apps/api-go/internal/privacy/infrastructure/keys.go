// Package infrastructure holds the adapters of the egress guard: pseudonym keys, the name directory
// and the access log.
package infrastructure

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"slices"

	"github.com/Dreamcoder08/sipges/apps/api-go/internal/privacy/domain"
)

// Keys gives one key per project, derived from SIPGES_DATA_KEY (docs/adr/0030): HMAC-SHA256 of a
// purpose label and the project, so the data key itself never keys a hash and another project's
// pseudonyms cannot be computed from this one's.
type Keys struct {
	dataKey []byte
}

// NewKeys holds a copy of the data key.
func NewKeys(dataKey []byte) Keys { return Keys{dataKey: slices.Clone(dataKey)} }

// MacFor is the keyed hash of tenantID.
func (k Keys) MacFor(tenantID string) domain.Mac {
	derive := hmac.New(sha256.New, k.dataKey)
	derive.Write([]byte("sipges:pseudonym:v1:" + tenantID))
	key := derive.Sum(nil)
	return func(message string) string {
		mac := hmac.New(sha256.New, key)
		mac.Write([]byte(message))
		return hex.EncodeToString(mac.Sum(nil))
	}
}
