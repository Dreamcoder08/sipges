package infrastructure

import (
	"crypto/ecdh"
	"crypto/rand"
	"encoding/base64"
)

// GenerateVapidKeys is generateVapidKeys: a fresh P-256 pair as base64url without padding, the
// uncompressed public point and the private scalar, as SIPGES_VAPID_PUBLIC_KEY and
// SIPGES_VAPID_PRIVATE_KEY expect them. Rotating the pair invalidates every device subscription.
func GenerateVapidKeys() (publicKey, privateKey string, err error) {
	key, err := ecdh.P256().GenerateKey(rand.Reader)
	if err != nil {
		return "", "", err
	}
	encode := base64.RawURLEncoding.EncodeToString
	return encode(key.PublicKey().Bytes()), encode(key.Bytes()), nil
}
