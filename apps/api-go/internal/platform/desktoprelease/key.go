package desktoprelease

import (
	"crypto/ed25519"
	"crypto/sha256"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/asn1"
	"encoding/hex"
	"encoding/pem"
)

// LoadPublicKey reads the trusted update key: a PEM "PUBLIC KEY" (SPKI) block holding an Ed25519
// key, as release.mjs writes update-public-key.pem. Any other key type is refused as not Ed25519;
// anything that is not a public key is refused as invalid. (Node would also derive a public key
// from a private key PEM; the updater never writes one there, so Go refuses it.)
func LoadPublicKey(data []byte) (ed25519.PublicKey, error) {
	invalid := refuse(KindKey, "The update key is not a valid public key")
	block, _ := pem.Decode(data)
	if block == nil {
		return nil, invalid
	}
	switch block.Type {
	case "PUBLIC KEY":
		key, err := x509.ParsePKIXPublicKey(block.Bytes)
		if err != nil {
			if isSPKI(block.Bytes) {
				// A well-formed key of an algorithm Go does not parse (Ed448, X25519, ...).
				return nil, refuse(KindKey, "The update key is not an Ed25519 key")
			}
			return nil, invalid
		}
		if ed, ok := key.(ed25519.PublicKey); ok {
			return ed, nil
		}
		return nil, refuse(KindKey, "The update key is not an Ed25519 key")
	case "RSA PUBLIC KEY":
		if _, err := x509.ParsePKCS1PublicKey(block.Bytes); err == nil {
			return nil, refuse(KindKey, "The update key is not an Ed25519 key")
		}
	}
	return nil, invalid
}

// isSPKI reports whether der is a SubjectPublicKeyInfo structure, whatever its algorithm.
func isSPKI(der []byte) bool {
	var spki struct {
		Algorithm pkix.AlgorithmIdentifier
		PublicKey asn1.BitString
	}
	rest, err := asn1.Unmarshal(der, &spki)
	return err == nil && len(rest) == 0 && len(spki.PublicKey.Bytes) > 0
}

// KeyFingerprint is the SHA-256 of the key's SPKI DER, in hex: what release.mjs keyFingerprint
// returns, update.mjs --trust-release-key prints and the visit kit writes to fingerprint.txt.
func KeyFingerprint(key ed25519.PublicKey) string {
	der, err := x509.MarshalPKIXPublicKey(key)
	if err != nil {
		return ""
	}
	sum := sha256.Sum256(der)
	return hex.EncodeToString(sum[:])
}
