package infrastructure

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha1" //nolint:gosec // RFC 6238 TOTP is HMAC-SHA-1, what authenticator apps compute
	"crypto/subtle"
	"encoding/base32"
	"encoding/binary"
	"errors"
	"fmt"
	"regexp"
	"strings"
	"time"

	"golang.org/x/text/cases"
	"golang.org/x/text/language"

	"github.com/Dreamcoder08/sipges/apps/api-go/internal/platform/httpx"
)

const totpAlphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"

// totpStepMillis is the 30 s step, in the milliseconds of a JavaScript date.
const totpStepMillis = 30_000

var totpCode = regexp.MustCompile(`^\d{6}$`)

// ErrInvalidSecret is a stored secret that is not base32; TypeScript throws, so the request
// answers 500 instead of reading as a wrong code.
var ErrInvalidSecret = errors.New("invalid base32 secret")

// TOTP is totp.ts: RFC 6238, SHA-1, 6 digits, 30 s, ±1 step plus a replay guard (ADR 0004).
type TOTP struct{}

// GenerateSecret returns an unpadded base32 secret of 20 random bytes.
func (TOTP) GenerateSecret() (string, error) {
	secret := make([]byte, 20)
	if _, err := rand.Read(secret); err != nil {
		return "", fmt.Errorf("totp secret: %w", err)
	}
	return base32.StdEncoding.WithPadding(base32.NoPadding).EncodeToString(secret), nil
}

// URI is the otpauth URI of app.py.
func (TOTP) URI(username, secret string) string {
	return "otpauth://totp/SIPGES:" + httpx.EncodeURIComponent(username) + "?secret=" + secret +
		"&issuer=SIPGES&algorithm=SHA1&digits=6&period=30"
}

// CodeAt is the code of the step holding at, for tests and enrolment tools.
func (TOTP) CodeAt(secret string, at time.Time) (string, error) {
	key, err := decodeBase32(secret)
	if err != nil {
		return "", err
	}
	return hotp(key, stepAt(at)), nil
}

// Verify checks code against the steps around at, oldest first, and returns the one that
// matched. A step at or before lastStep was already used and never matches (replay). As in
// TypeScript, a malformed code or an empty secret is a plain refusal, checked before the secret
// is decoded.
func (TOTP) Verify(secret, code string, at time.Time, lastStep *int64) (int64, bool, error) {
	if !totpCode.MatchString(code) || secret == "" {
		return 0, false, nil
	}
	key, err := decodeBase32(secret)
	if err != nil {
		return 0, false, err
	}
	current := stepAt(at)
	for _, step := range []int64{current - 1, current, current + 1} {
		if lastStep != nil && step <= *lastStep {
			continue
		}
		if subtle.ConstantTimeCompare([]byte(hotp(key, step)), []byte(code)) == 1 {
			return step, true, nil
		}
	}
	return 0, false, nil
}

func stepAt(at time.Time) int64 { return at.UnixMilli() / totpStepMillis }

// decodeBase32 is base32Decode: trailing '=' dropped, upper-cased, and the leftover bits of an
// incomplete last byte ignored, which encoding/base32 would refuse.
func decodeBase32(text string) ([]byte, error) {
	upper := cases.Upper(language.Und).String(strings.TrimRight(text, "="))
	var out []byte
	var value uint32
	bits := 0
	for _, char := range upper {
		index := strings.IndexRune(totpAlphabet, char)
		if index < 0 {
			return nil, ErrInvalidSecret
		}
		value = value<<5 | uint32(index) //nolint:gosec // index is below 32
		bits += 5
		if bits >= 8 {
			out = append(out, byte(value>>(bits-8))) //nolint:gosec // the low byte, as `& 255`
			bits -= 8
		}
	}
	return out, nil
}

// hotp is RFC 4226 truncated to 6 digits, as app.py totp_code.
func hotp(key []byte, counter int64) string {
	mac := hmac.New(sha1.New, key)
	_ = binary.Write(mac, binary.BigEndian, counter)
	digest := mac.Sum(nil)
	offset := digest[len(digest)-1] & 15
	binaryCode := binary.BigEndian.Uint32(digest[offset:]) & 0x7fffffff
	return fmt.Sprintf("%06d", binaryCode%1_000_000)
}
