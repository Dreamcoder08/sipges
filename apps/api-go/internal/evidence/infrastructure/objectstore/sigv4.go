package objectstore

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"sort"
	"strings"
	"time"

	js "github.com/Dreamcoder08/sipges/apps/api-go/internal/situations/domain"
)

// AWS Signature Version 4 for S3-compatible APIs (Cloudflare R2, AWS S3, MinIO), ported from
// apps/api/src/contexts/evidence/infrastructure/s3-signature.ts so both APIs sign the same way
// without an SDK. Verified against the "GET Object" example of the AWS SigV4 documentation.

// Credentials are the access key pair; they come from configuration only.
type Credentials struct {
	AccessKeyID     string
	SecretAccessKey string
}

func sha256Hex(b []byte) string {
	sum := sha256.Sum256(b)
	return hex.EncodeToString(sum[:])
}

func hmacSHA256(key []byte, data string) []byte {
	m := hmac.New(sha256.New, key)
	m.Write([]byte(data))
	return m.Sum(nil)
}

// encodeSegment is encodeSegment: encodeURIComponent plus ! ' ( ) *, RFC 3986 as S3 expects it
// for each path segment.
func encodeSegment(segment string) string {
	const hexDigits = "0123456789ABCDEF"
	var b strings.Builder
	for i := 0; i < len(segment); i++ {
		c := segment[i]
		if 'A' <= c && c <= 'Z' || 'a' <= c && c <= 'z' || '0' <= c && c <= '9' || c == '-' || c == '_' || c == '.' || c == '~' {
			b.WriteByte(c)
			continue
		}
		b.WriteByte('%')
		b.WriteByte(hexDigits[c>>4])
		b.WriteByte(hexDigits[c&0x0f])
	}
	return b.String()
}

// amzDate is amzDate: the ISO instant without separators or milliseconds, e.g. 20130524T000000Z.
func amzDate(at time.Time) string { return at.UTC().Format("20060102T150405Z") }

// signInput is SignInput: Path is the already-encoded absolute path, Headers every header to sign.
type signInput struct {
	Method, Path, Host, Region string
	Headers                    map[string]string
	PayloadHash                string
	At                         time.Time
	Credentials                Credentials
}

// collapse is `value.trim().replace(/\s+/g, ' ')`.
func collapse(v string) string {
	var b strings.Builder
	space := false
	for _, r := range js.TrimJS(v) {
		if js.IsJSSpace(r) {
			space = true
			continue
		}
		if space {
			b.WriteByte(' ')
			space = false
		}
		b.WriteRune(r)
	}
	return b.String()
}

// sign is signRequest: the Authorization header value.
func sign(in signInput) string {
	date := amzDate(in.At)
	day := date[:8]
	scope := day + "/" + in.Region + "/s3/aws4_request"
	type header struct{ name, value string }
	merged := map[string]string{}
	for k, v := range in.Headers {
		merged[k] = v
	}
	merged["host"] = in.Host
	headers := make([]header, 0, len(merged))
	for k, v := range merged {
		headers = append(headers, header{strings.ToLower(k), collapse(v)})
	}
	sort.Slice(headers, func(i, j int) bool { return headers[i].name < headers[j].name })
	names := make([]string, len(headers))
	lines := make([]string, len(headers))
	for i, h := range headers {
		names[i] = h.name
		lines[i] = h.name + ":" + h.value
	}
	signed := strings.Join(names, ";")
	canonical := strings.Join(append(append([]string{in.Method, in.Path, ""}, lines...), "", signed, in.PayloadHash), "\n")
	toSign := strings.Join([]string{"AWS4-HMAC-SHA256", date, scope, sha256Hex([]byte(canonical))}, "\n")
	key := hmacSHA256([]byte("AWS4"+in.Credentials.SecretAccessKey), day)
	for _, part := range []string{in.Region, "s3", "aws4_request"} {
		key = hmacSHA256(key, part)
	}
	signature := hex.EncodeToString(hmacSHA256(key, toSign))
	return "AWS4-HMAC-SHA256 Credential=" + in.Credentials.AccessKeyID + "/" + scope +
		", SignedHeaders=" + signed + ", Signature=" + signature
}
