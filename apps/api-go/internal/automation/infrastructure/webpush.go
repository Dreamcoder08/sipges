package infrastructure

import (
	"bytes"
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/ecdh"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"regexp"
	"strconv"
	"time"

	"github.com/Dreamcoder08/sipges/apps/api-go/internal/automation/application"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/automation/domain"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/platform/secrets"
	situations "github.com/Dreamcoder08/sipges/apps/api-go/internal/situations/domain"
)

// web-push.ts: Web Push message encryption (RFC 8291) and VAPID authorization (RFC 8292). Every
// error here is a fixed text: the endpoint is a capability URL, the keys are credentials and the
// payload holds personal data, so none may reach last_error or a log.

// recordSize is RECORD_SIZE: advertised in the aes128gcm header; one record carries the message.
const recordSize = 4096

// vapidLifetime is how long a VAPID token is valid.
const vapidLifetime = 12 * time.Hour

//nolint:staticcheck // ST1005: the TypeScript texts, stored as last_error and shown to administrators
var (
	errPushOffline = errors.New("Servicio de push sin conexión")
	errPushKeys    = errors.New("Servicio de push: suscripción no válida")
	errPushBuild   = errors.New("Servicio de push: mensaje no válido")
)

// jsSpace is JavaScript's \s, wider than RE2's.
const jsSpace = `\s\x0B\x{00A0}\x{1680}\x{2000}-\x{200A}\x{2028}\x{2029}\x{202F}\x{205F}\x{3000}\x{FEFF}`

var (
	vapidPublicPattern  = regexp.MustCompile(`^[A-Za-z0-9_-]{87}$`)
	vapidPrivatePattern = regexp.MustCompile(`^[A-Za-z0-9_-]{43}$`)
	vapidSubjectPattern = regexp.MustCompile(`^(mailto:[^@` + jsSpace + `]+@[^@` + jsSpace + `]+|https://[^` + jsSpace + `]+)$`)
)

// VapidKeys is VapidKeys: the raw base64url key pair and the contact subject.
type VapidKeys struct {
	PublicKey  string
	PrivateKey string
	Subject    string
}

const redactedKeys = "[redacted]"

// String keeps the private key out of formatted text.
func (VapidKeys) String() string { return redactedKeys }

// GoString keeps the private key out of %#v.
func (VapidKeys) GoString() string { return redactedKeys }

// LogValue keeps the private key out of structured logs.
func (VapidKeys) LogValue() slog.Value { return slog.StringValue(redactedKeys) }

// MarshalJSON keeps the private key out of encoded logs.
func (VapidKeys) MarshalJSON() ([]byte, error) { return json.Marshal(redactedKeys) }

// LoadVapid is parseVapid of apps/api/src/platform/config.ts: nil when neither key is set, which
// leaves device notifications off.
func LoadVapid(lookup secrets.Lookup) (*VapidKeys, error) {
	read := func(name string) string {
		value, _ := lookup(name)
		return situations.TrimJS(value)
	}
	publicKey, privateKey, subject := read("SIPGES_VAPID_PUBLIC_KEY"), read("SIPGES_VAPID_PRIVATE_KEY"), read("SIPGES_VAPID_SUBJECT")
	if publicKey == "" && privateKey == "" {
		return nil, nil //nolint:nilnil // unset is a valid configuration: push stays off
	}
	if !vapidPublicPattern.MatchString(publicKey) || !vapidPrivatePattern.MatchString(privateKey) {
		return nil, errors.New("SIPGES_VAPID_PUBLIC_KEY and SIPGES_VAPID_PRIVATE_KEY must be base64url P-256 keys (pnpm --filter @sipges/api vapid:keys)")
	}
	if !vapidSubjectPattern.MatchString(subject) {
		return nil, errors.New("SIPGES_VAPID_SUBJECT must be a mailto: address or an https URL")
	}
	return &VapidKeys{PublicKey: publicKey, PrivateKey: privateKey, Subject: subject}, nil
}

// WebPushSender is createWebPushSender. It keeps the parsed signing key only.
type WebPushSender struct {
	publicKey string
	subject   string
	key       *ecdsa.PrivateKey
	client    *http.Client
}

var _ application.PushSender = (*WebPushSender)(nil)

// NewWebPushSender builds the sender; client overrides the HTTP client, nil means one with
// SendTimeout and no redirects. It refuses a pair whose private key is not the public key's.
func NewWebPushSender(keys *VapidKeys, client *http.Client) (*WebPushSender, error) {
	public, err := base64.RawURLEncoding.DecodeString(keys.PublicKey)
	if err != nil || len(public) != 65 || public[0] != 4 {
		return nil, errors.New("SIPGES_VAPID_PUBLIC_KEY must be an uncompressed P-256 key")
	}
	scalar, err := base64.RawURLEncoding.DecodeString(keys.PrivateKey)
	if err != nil {
		return nil, errVapidPair
	}
	key, err := ecdsa.ParseRawPrivateKey(elliptic.P256(), scalar)
	if err != nil {
		return nil, errVapidPair
	}
	derived, err := key.PublicKey.Bytes()
	if err != nil || !bytes.Equal(derived, public) {
		return nil, errVapidPair
	}
	if client == nil {
		client = defaultClient
	}
	return &WebPushSender{publicKey: keys.PublicKey, subject: keys.Subject, key: key, client: client}, nil
}

var errVapidPair = errors.New("SIPGES_VAPID_PRIVATE_KEY must be the private key of SIPGES_VAPID_PUBLIC_KEY")

// NewPushClient is the sender's client over a transport: the same timeout and redirect refusal.
func NewPushClient(transport http.RoundTripper) *http.Client {
	return &http.Client{Timeout: SendTimeout, CheckRedirect: defaultClient.CheckRedirect, Transport: transport}
}

// PublicKey is the key browsers subscribe with.
func (s *WebPushSender) PublicKey() string { return s.publicKey }

// compactJSON is JSON.stringify: no HTML escaping and no trailing newline.
func compactJSON(value any) ([]byte, error) {
	var out bytes.Buffer
	enc := json.NewEncoder(&out)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(value); err != nil {
		return nil, err
	}
	return bytes.TrimSuffix(out.Bytes(), []byte("\n")), nil
}

func hmacSHA256(key, data []byte) []byte {
	mac := hmac.New(sha256.New, key)
	mac.Write(data)
	return mac.Sum(nil)
}

// pushKeys derives the content encryption key and nonce (RFC 8291 §3.4, RFC 8188 §2.2).
func pushKeys(secret, auth, uaPublic, asPublic, salt []byte) (cek, nonce []byte) {
	keyInfo := bytes.Join([][]byte{[]byte("WebPush: info\x00"), uaPublic, asPublic, {1}}, nil)
	ikm := hmacSHA256(hmacSHA256(auth, secret), keyInfo)
	prk := hmacSHA256(salt, ikm)
	return hmacSHA256(prk, []byte("Content-Encoding: aes128gcm\x00\x01"))[:16],
		hmacSHA256(prk, []byte("Content-Encoding: nonce\x00\x01"))[:12]
}

// encryptPush is encryptPush. ephemeral and salt exist so tests can reproduce the RFC example;
// nil means fresh ones.
func encryptPush(plaintext []byte, subscription application.PushSubscription, ephemeral *ecdh.PrivateKey, salt []byte) ([]byte, error) {
	uaBytes, err := base64.RawURLEncoding.DecodeString(subscription.P256dh)
	if err != nil {
		return nil, errPushKeys
	}
	uaPublic, err := ecdh.P256().NewPublicKey(uaBytes)
	if err != nil {
		return nil, errPushKeys
	}
	auth, err := base64.RawURLEncoding.DecodeString(subscription.Auth)
	if err != nil {
		return nil, errPushKeys
	}
	if ephemeral == nil {
		if ephemeral, err = ecdh.P256().GenerateKey(rand.Reader); err != nil {
			return nil, errPushBuild
		}
	}
	if salt == nil {
		salt = make([]byte, 16)
		if _, err := rand.Read(salt); err != nil {
			return nil, errPushBuild
		}
	}
	secret, err := ephemeral.ECDH(uaPublic)
	if err != nil {
		return nil, errPushKeys
	}
	asPublic := ephemeral.PublicKey().Bytes()
	cek, nonce := pushKeys(secret, auth, uaBytes, asPublic, salt)
	block, err := aes.NewCipher(cek)
	if err != nil {
		return nil, errPushBuild
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return nil, errPushBuild
	}
	// 0x02 marks the last (and only) record; no padding.
	record := append(append(make([]byte, 0, len(plaintext)+1), plaintext...), 2)
	out := make([]byte, 0, 21+len(asPublic)+len(record)+gcm.Overhead())
	out = append(out, salt...)
	out = binary.BigEndian.AppendUint32(out, recordSize)
	out = append(out, byte(len(asPublic))) //nolint:gosec // an uncompressed P-256 point: 65 bytes
	out = append(out, asPublic...)
	return gcm.Seal(out, nonce, record, nil), nil
}

// authorization is vapidAuthorization: `vapid t=<jwt>, k=<public key>` for one push service
// origin, valid for 12 hours.
func (s *WebPushSender) authorization(endpoint string, now time.Time) (string, error) {
	origin, ok := domain.PushOrigin(endpoint)
	if !ok {
		return "", errPushKeys
	}
	claims, err := compactJSON(struct {
		Aud string `json:"aud"`
		Exp int64  `json:"exp"`
		Sub string `json:"sub"`
	}{origin, now.Add(vapidLifetime).Unix(), s.subject})
	if err != nil {
		return "", errPushBuild
	}
	encode := base64.RawURLEncoding.EncodeToString
	signed := encode([]byte(`{"typ":"JWT","alg":"ES256"}`)) + "." + encode(claims)
	digest := sha256.Sum256([]byte(signed))
	r, q, err := ecdsa.Sign(rand.Reader, s.key, digest[:])
	if err != nil {
		return "", errPushBuild
	}
	signature := make([]byte, 64) // ieee-p1363: r and s, 32 bytes each
	r.FillBytes(signature[:32])
	q.FillBytes(signature[32:])
	return "vapid t=" + signed + "." + encode(signature) + ", k=" + s.publicKey, nil
}

func isRedirect(status int) bool {
	switch status {
	case http.StatusMovedPermanently, http.StatusFound, http.StatusSeeOther, http.StatusTemporaryRedirect, http.StatusPermanentRedirect:
		return true
	}
	return false
}

// Send encrypts and posts one message; 404 and 410 report a subscription the browser dropped.
func (s *WebPushSender) Send(ctx context.Context, subscription application.PushSubscription, payload application.PushPayload, now time.Time) (application.PushResult, error) {
	plaintext, err := compactJSON(payload)
	if err != nil {
		return 0, errPushBuild
	}
	body, err := encryptPush(plaintext, subscription, nil, nil)
	if err != nil {
		return 0, err
	}
	authorization, err := s.authorization(subscription.Endpoint, now)
	if err != nil {
		return 0, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, subscription.Endpoint, bytes.NewReader(body))
	if err != nil {
		return 0, errPushKeys
	}
	req.Header.Set("authorization", authorization)
	req.Header.Set("content-encoding", "aes128gcm")
	req.Header.Set("content-type", "application/octet-stream")
	req.Header.Set("ttl", "86400")
	req.Header.Set("urgency", "normal")
	resp, err := s.client.Do(req)
	if err != nil {
		return 0, errPushOffline // err quotes the endpoint
	}
	_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 64<<10))
	_ = resp.Body.Close()
	switch {
	case resp.StatusCode == http.StatusNotFound || resp.StatusCode == http.StatusGone:
		return application.PushGone, nil
	case isRedirect(resp.StatusCode):
		return 0, errPushOffline // fetch's redirect: 'error', even without a Location
	case resp.StatusCode < 200 || resp.StatusCode > 299:
		return 0, errors.New("Servicio de push: respuesta HTTP " + strconv.Itoa(resp.StatusCode))
	}
	return application.PushSent, nil
}
