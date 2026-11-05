package config

import (
	"encoding/base64"
	"errors"
	"regexp"
	"strings"
)

// ErrNoDataKey is SIPGES_DATA_KEY missing.
var ErrNoDataKey = errors.New("SIPGES_DATA_KEY is required (base64, 32 bytes)")

var dataKeyBase64 = regexp.MustCompile(`^[A-Za-z0-9+/]+={0,2}\z`)

const dataKeyLength = 32

// DataKey reads SIPGES_DATA_KEY as parseDataKey of apps/api/src/platform/config.ts does: base64
// with or without its padding, 32 bytes once decoded.
func DataKey(lookup Lookup) ([]byte, error) {
	value, ok := lookup("SIPGES_DATA_KEY")
	if !ok {
		return nil, ErrNoDataKey
	}
	invalid := errors.New("SIPGES_DATA_KEY must decode to 32 bytes")
	if !dataKeyBase64.MatchString(value) {
		return nil, invalid
	}
	key, err := base64.RawStdEncoding.DecodeString(strings.TrimRight(value, "="))
	if err != nil || len(key) != dataKeyLength {
		return nil, invalid
	}
	return key, nil
}
