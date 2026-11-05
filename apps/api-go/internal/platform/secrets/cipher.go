// Package secrets seals secrets at rest exactly as
// apps/api/src/contexts/identity/infrastructure/secret-cipher.ts does (ADR 0004): AES-256-GCM,
// `v1.<base64url(nonce | ciphertext | tag)>`, sealed with the current key and opened with it or
// with the key being rotated out. Values sealed by either API open in the other.
package secrets

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"encoding/base64"
	"errors"
	"strings"
)

const (
	version    = "v1"
	nonceBytes = 12
	tagBytes   = 16
)

var (
	// ErrKeySize rejects a key that is not 32 bytes.
	ErrKeySize = errors.New("SIPGES_DATA_KEY must decode to 32 bytes")
	// ErrUnsupported is a value that is not `v1.<payload>`.
	ErrUnsupported = errors.New("unsupported sealed secret")
	// ErrMalformed is a payload too short to hold a nonce and a tag.
	ErrMalformed = errors.New("malformed sealed secret")
)

// Cipher seals with its first key and opens with any of them.
type Cipher struct {
	aeads []cipher.AEAD
}

// NewCipher is createSecretCipher(key, previousKeys).
func NewCipher(key []byte, previous ...[]byte) (*Cipher, error) {
	c := &Cipher{}
	for _, k := range append([][]byte{key}, previous...) {
		if len(k) != 32 {
			return nil, ErrKeySize
		}
		block, err := aes.NewCipher(k)
		if err != nil {
			return nil, err
		}
		aead, err := cipher.NewGCM(block)
		if err != nil {
			return nil, err
		}
		c.aeads = append(c.aeads, aead)
	}
	return c, nil
}

// Seal encrypts plaintext with the current key and a random nonce.
func (c *Cipher) Seal(plaintext string) (string, error) {
	nonce := make([]byte, nonceBytes, nonceBytes+len(plaintext)+tagBytes)
	if _, err := rand.Read(nonce); err != nil {
		return "", err
	}
	sealed := c.aeads[0].Seal(nonce, nonce, []byte(plaintext), nil)
	return version + "." + base64.RawURLEncoding.EncodeToString(sealed), nil
}

// Open decrypts a sealed value with each key in turn; the GCM tag rejects a wrong key.
func (c *Cipher) Open(sealed string) (string, error) {
	parts := strings.Split(sealed, ".")
	if parts[0] != version || len(parts) < 2 || parts[1] == "" {
		return "", ErrUnsupported
	}
	raw, err := base64.RawURLEncoding.DecodeString(strings.TrimRight(parts[1], "="))
	if err != nil {
		return "", ErrMalformed
	}
	if len(raw) < nonceBytes+tagBytes {
		return "", ErrMalformed
	}
	var failure error
	for _, aead := range c.aeads {
		plain, err := aead.Open(nil, raw[:nonceBytes], raw[nonceBytes:], nil)
		if err == nil {
			return string(plain), nil
		}
		if failure == nil {
			failure = err
		}
	}
	return "", failure
}
