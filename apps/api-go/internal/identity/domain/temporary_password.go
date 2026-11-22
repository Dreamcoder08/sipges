package domain

import (
	"crypto/rand"
	"fmt"
)

// TemporaryPasswordLength is the length of the password an administrator's reset hands over:
// 20 characters of a 29-letter alphabet hold about 97 bits.
const TemporaryPasswordLength = 20

// TemporaryPasswordAlphabet has capitals and digits a person can read aloud or copy by hand: no
// 0/O, 1/I/L or 8/B.
const TemporaryPasswordAlphabet = "ACDEFGHJKMNPQRSTUVWXYZ2345679"

// unbiasedLimit is the largest multiple of the alphabet's size a byte can hold: bytes at or above
// it are drawn again, so every letter is equally likely.
const unbiasedLimit = 256 - 256%len(TemporaryPasswordAlphabet)

// NewTemporaryPassword draws a password from crypto/rand that the change policy accepts for
// username, so the person it is handed to can sign in with it.
func NewTemporaryPassword(username string) (string, error) {
	for {
		password, err := drawTemporaryPassword()
		if err != nil {
			return "", err
		}
		if CheckNewPassword(username, "", password) == "" {
			return password, nil
		}
	}
}

func drawTemporaryPassword() (string, error) {
	out := make([]byte, 0, TemporaryPasswordLength)
	buf := make([]byte, TemporaryPasswordLength*2)
	for len(out) < TemporaryPasswordLength {
		if _, err := rand.Read(buf); err != nil {
			return "", fmt.Errorf("draw a temporary password: %w", err)
		}
		for _, b := range buf {
			if int(b) < unbiasedLimit && len(out) < TemporaryPasswordLength {
				out = append(out, TemporaryPasswordAlphabet[int(b)%len(TemporaryPasswordAlphabet)])
			}
		}
	}
	return string(out), nil
}
