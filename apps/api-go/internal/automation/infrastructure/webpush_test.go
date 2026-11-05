package infrastructure

import (
	"bytes"
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/ecdh"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"math/big"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/Dreamcoder08/sipges/apps/api-go/internal/automation/application"
)

// A synthetic key pair and subscription; the endpoint never leaves the test transport.
const (
	testVapidPublic  = "BHS-uwl3nFpzgNoW0kjmSZB4-vUfabJkKg8ysBCV9GIZIzv22PTxzM0uQcgahdjwpxOaPcnfVtaILHUT6mAyu8o"
	testVapidPrivate = "Hxm3lKNdyp0lyYD4wbrlQmxH0T0mWnqeVdhx3-OrMEQ"
	testEndpoint     = "https://fcm.googleapis.com/fcm/send/synthetic-capability-token"
	testP256dh       = "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4"
	testAuth         = "BTBZMqHH6r4Tts7J_aSIgg"
	testUAPrivate    = "q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94"
)

type lookupMap map[string]string

func (m lookupMap) get(key string) (string, bool) { v, ok := m[key]; return v, ok }

func testKeys(t *testing.T) *VapidKeys {
	t.Helper()
	keys, err := LoadVapid(lookupMap{
		"SIPGES_VAPID_PUBLIC_KEY":  testVapidPublic,
		"SIPGES_VAPID_PRIVATE_KEY": testVapidPrivate,
		"SIPGES_VAPID_SUBJECT":     "mailto:ops@example.org",
	}.get)
	if err != nil || keys == nil {
		t.Fatalf("LoadVapid = %v, %v", keys, err)
	}
	return keys
}

func b64u(t *testing.T, text string) []byte {
	t.Helper()
	b, err := base64.RawURLEncoding.DecodeString(text)
	if err != nil {
		t.Fatal(err)
	}
	return b
}

func TestEncryptsExactlyLikeTheRFC8291Example(t *testing.T) {
	ephemeral, err := ecdh.P256().NewPrivateKey(b64u(t, "yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw"))
	if err != nil {
		t.Fatal(err)
	}
	body, err := encryptPush([]byte("When I grow up, I want to be a watermelon"),
		application.PushSubscription{P256dh: testP256dh, Auth: testAuth},
		ephemeral, b64u(t, "DGv6ra1nlYgDCS1FRnbzlw"))
	if err != nil {
		t.Fatal(err)
	}
	want := "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN"
	if got := base64.RawURLEncoding.EncodeToString(body); got != want {
		t.Fatalf("got %s", got)
	}
}

func TestInvalidSubscriptionKeysFailWithoutTheirValue(t *testing.T) {
	bad := application.PushSubscription{P256dh: strings.Repeat("A", 87), Auth: testAuth}
	_, err := encryptPush([]byte("x"), bad, nil, nil)
	if err == nil {
		t.Fatal("expected an error")
	}
	if strings.Contains(err.Error(), bad.P256dh) {
		t.Fatalf("error echoes the key: %v", err)
	}
}

func TestVapidTokenVerifiesForThePushServiceOrigin(t *testing.T) {
	keys := testKeys(t)
	sender, err := NewWebPushSender(keys, nil)
	if err != nil {
		t.Fatal(err)
	}
	now := time.Date(2026, 10, 14, 10, 0, 0, 0, time.UTC)
	header, err := sender.authorization(testEndpoint, now)
	if err != nil {
		t.Fatal(err)
	}
	token, k, ok := strings.Cut(strings.TrimPrefix(header, "vapid t="), ", k=")
	if !ok || k != testVapidPublic {
		t.Fatalf("header %q", header)
	}
	parts := strings.Split(token, ".")
	if len(parts) != 3 {
		t.Fatalf("token %q", token)
	}
	if got := string(b64u(t, parts[0])); got != `{"typ":"JWT","alg":"ES256"}` {
		t.Fatalf("header %s", got)
	}
	want := fmt.Sprintf(`{"aud":"https://fcm.googleapis.com","exp":%d,"sub":"mailto:ops@example.org"}`,
		time.Date(2026, 10, 14, 22, 0, 0, 0, time.UTC).Unix())
	if got := string(b64u(t, parts[1])); got != want {
		t.Fatalf("claims %s", got)
	}
	key, err := ecdsa.ParseUncompressedPublicKey(elliptic.P256(), b64u(t, testVapidPublic))
	if err != nil {
		t.Fatal(err)
	}
	signature := b64u(t, parts[2])
	if len(signature) != 64 {
		t.Fatalf("signature is %d bytes, not the ieee-p1363 64", len(signature))
	}
	digest := sha256.Sum256([]byte(parts[0] + "." + parts[1]))
	if !ecdsa.Verify(key, digest[:], new(big.Int).SetBytes(signature[:32]), new(big.Int).SetBytes(signature[32:])) {
		t.Fatal("signature does not verify")
	}
}

func TestVapidConfiguration(t *testing.T) {
	full := func(over map[string]string) lookupMap {
		m := lookupMap{
			"SIPGES_VAPID_PUBLIC_KEY":  testVapidPublic,
			"SIPGES_VAPID_PRIVATE_KEY": testVapidPrivate,
			"SIPGES_VAPID_SUBJECT":     "mailto:ops@example.org",
		}
		for k, v := range over {
			m[k] = v
		}
		return m
	}
	const keysError = "SIPGES_VAPID_PUBLIC_KEY and SIPGES_VAPID_PRIVATE_KEY must be base64url P-256 keys (pnpm --filter @sipges/api vapid:keys)"
	const subjectError = "SIPGES_VAPID_SUBJECT must be a mailto: address or an https URL"
	for name, c := range map[string]struct {
		env  lookupMap
		want string
	}{
		"private without public":  {full(map[string]string{"SIPGES_VAPID_PUBLIC_KEY": ""}), keysError},
		"public without private":  {full(map[string]string{"SIPGES_VAPID_PRIVATE_KEY": ""}), keysError},
		"short public":            {full(map[string]string{"SIPGES_VAPID_PUBLIC_KEY": "abc"}), keysError},
		"plain subject":           {full(map[string]string{"SIPGES_VAPID_SUBJECT": "ops@example.org"}), subjectError},
		"http subject":            {full(map[string]string{"SIPGES_VAPID_SUBJECT": "http://example.org"}), subjectError},
		"vertical tab in subject": {full(map[string]string{"SIPGES_VAPID_SUBJECT": "mailto:a\vb@example.org"}), subjectError},
	} {
		t.Run(name, func(t *testing.T) {
			keys, err := LoadVapid(c.env.get)
			if keys != nil || err == nil || err.Error() != c.want {
				t.Fatalf("got %v, %v", keys, err)
			}
		})
	}
	t.Run("unset disables push", func(t *testing.T) {
		keys, err := LoadVapid(lookupMap{"SIPGES_VAPID_SUBJECT": "not checked"}.get)
		if keys != nil || err != nil {
			t.Fatalf("got %v, %v", keys, err)
		}
	})
	t.Run("surrounding spaces are trimmed", func(t *testing.T) {
		keys, err := LoadVapid(full(map[string]string{"SIPGES_VAPID_PUBLIC_KEY": " " + testVapidPublic + "\n"}).get)
		if err != nil || keys == nil {
			t.Fatalf("got %v, %v", keys, err)
		}
	})
}

func TestSenderRefusesKeysThatDoNotMatch(t *testing.T) {
	for name, public := range map[string]string{
		"compressed marker": "A" + testVapidPublic[1:],
		"another key":       testP256dh,
	} {
		t.Run(name, func(t *testing.T) {
			keys := testKeys(t)
			keys.PublicKey = public
			_, err := NewWebPushSender(keys, nil)
			if err == nil {
				t.Fatal("expected an error")
			}
			if strings.Contains(err.Error(), testVapidPrivate) || strings.Contains(err.Error(), public) {
				t.Fatalf("error echoes a key: %v", err)
			}
		})
	}
}

func TestVapidKeysNeverReachLogsOrErrors(t *testing.T) {
	keys := testKeys(t)
	var logged bytes.Buffer
	slog.New(slog.NewJSONHandler(&logged, nil)).Info("x", "keys", keys, "value", *keys, "list", []VapidKeys{*keys})
	encoded, err := json.Marshal(struct {
		Keys VapidKeys
		List []*VapidKeys
	}{*keys, []*VapidKeys{keys}})
	if err != nil {
		t.Fatal(err)
	}
	for _, text := range []string{
		string(encoded),
		fmt.Sprintf("%v %+v %#v %s", keys, keys, keys, keys),
		fmt.Sprintf("%v %+v %#v %s", *keys, *keys, *keys, *keys),
		logged.String(),
	} {
		if strings.Contains(text, testVapidPrivate) {
			t.Fatalf("private key printed: %s", text)
		}
	}
}

type roundTrip func(*http.Request) (*http.Response, error)

func (f roundTrip) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

// answering is a client double: no request reaches a network.
func answering(status int, seen **http.Request, body *[]byte) *http.Client {
	return &http.Client{Transport: roundTrip(func(r *http.Request) (*http.Response, error) {
		if seen != nil {
			*seen = r
		}
		if body != nil {
			*body, _ = io.ReadAll(r.Body)
		}
		return &http.Response{StatusCode: status, Body: io.NopCloser(strings.NewReader("")), Header: http.Header{}, Request: r}, nil
	})}
}

func testSubscription() application.PushSubscription {
	return application.PushSubscription{Endpoint: testEndpoint, P256dh: testP256dh, Auth: testAuth}
}

// decrypt is the browser's side of RFC 8291, with the RFC example's user agent key.
func decrypt(t *testing.T, body []byte) []byte {
	t.Helper()
	ua, err := ecdh.P256().NewPrivateKey(b64u(t, testUAPrivate))
	if err != nil {
		t.Fatal(err)
	}
	salt, idLen := body[:16], int(body[20])
	as, err := ecdh.P256().NewPublicKey(body[21 : 21+idLen])
	if err != nil {
		t.Fatal(err)
	}
	secret, err := ua.ECDH(as)
	if err != nil {
		t.Fatal(err)
	}
	cek, nonce := pushKeys(secret, b64u(t, testAuth), ua.PublicKey().Bytes(), as.Bytes(), salt)
	block, err := aes.NewCipher(cek)
	if err != nil {
		t.Fatal(err)
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		t.Fatal(err)
	}
	plain, err := gcm.Open(nil, nonce, body[21+idLen:], nil)
	if err != nil {
		t.Fatal(err)
	}
	if plain[len(plain)-1] != 2 {
		t.Fatalf("record delimiter %d", plain[len(plain)-1])
	}
	return plain[:len(plain)-1]
}

func TestSendPostsTheEncryptedPayload(t *testing.T) {
	var req *http.Request
	var body []byte
	sender, err := NewWebPushSender(testKeys(t), answering(201, &req, &body))
	if err != nil {
		t.Fatal(err)
	}
	if sender.PublicKey() != testVapidPublic {
		t.Fatalf("public key %q", sender.PublicKey())
	}
	payload := application.PushPayload{Title: "Título <b>", Body: "Cuerpo & más", URL: "/objeto/a/1"}
	result, err := sender.Send(context.Background(), testSubscription(), payload, time.Unix(1_800_000_000, 0))
	if err != nil || result != application.PushSent {
		t.Fatalf("got %v, %v", result, err)
	}
	if req.Method != http.MethodPost || req.URL.String() != testEndpoint {
		t.Fatalf("%s %s", req.Method, req.URL)
	}
	for name, want := range map[string]string{
		"content-encoding": "aes128gcm",
		"content-type":     "application/octet-stream",
		"ttl":              "86400",
		"urgency":          "normal",
	} {
		if got := req.Header.Get(name); got != want {
			t.Fatalf("%s = %q", name, got)
		}
	}
	if !strings.HasPrefix(req.Header.Get("authorization"), "vapid t=") {
		t.Fatalf("authorization %q", req.Header.Get("authorization"))
	}
	plain := decrypt(t, body)
	if want := `{"title":"Título <b>","body":"Cuerpo & más","url":"/objeto/a/1"}`; string(plain) != want {
		t.Fatalf("decrypted %s", plain)
	}
	var decoded application.PushPayload
	if err := json.Unmarshal(plain, &decoded); err != nil || decoded != payload {
		t.Fatalf("decoded %+v, %v", decoded.Title, err)
	}
}

func TestSendReportsDroppedSubscriptionsAsGone(t *testing.T) {
	for _, status := range []int{404, 410} {
		sender, err := NewWebPushSender(testKeys(t), answering(status, nil, nil))
		if err != nil {
			t.Fatal(err)
		}
		result, err := sender.Send(context.Background(), testSubscription(), application.PushPayload{}, time.Now())
		if err != nil || result != application.PushGone {
			t.Fatalf("%d: got %v, %v", status, result, err)
		}
	}
}

func TestSendFailuresNameOnlyTheFailure(t *testing.T) {
	secretValues := func(t *testing.T, text string) {
		t.Helper()
		for _, value := range []string{"synthetic-capability-token", testP256dh, testAuth, testVapidPrivate, "persona secreta"} {
			if strings.Contains(text, value) {
				t.Fatalf("%q leaks %q", text, value)
			}
		}
	}
	payload := application.PushPayload{Title: "persona secreta", Body: "persona secreta"}
	t.Run("rejected", func(t *testing.T) {
		sender, _ := NewWebPushSender(testKeys(t), answering(500, nil, nil))
		_, err := sender.Send(context.Background(), testSubscription(), payload, time.Now())
		if err == nil || err.Error() != "Servicio de push: respuesta HTTP 500" {
			t.Fatalf("got %v", err)
		}
	})
	t.Run("redirect is refused", func(t *testing.T) {
		for name, location := range map[string]string{"with location": "https://evil.example/x", "without location": ""} {
			client := &http.Client{CheckRedirect: defaultClient.CheckRedirect, Transport: roundTrip(func(r *http.Request) (*http.Response, error) {
				header := http.Header{}
				if location != "" {
					header.Set("Location", location)
				}
				if r.URL.Host != "fcm.googleapis.com" {
					t.Fatalf("%s: followed a redirect to %s", name, r.URL.Host)
				}
				return &http.Response{StatusCode: http.StatusFound, Body: io.NopCloser(strings.NewReader("")), Header: header, Request: r}, nil
			})}
			sender, _ := NewWebPushSender(testKeys(t), client)
			_, err := sender.Send(context.Background(), testSubscription(), payload, time.Now())
			if err == nil || err.Error() != "Servicio de push sin conexión" {
				t.Fatalf("%s: got %v", name, err)
			}
		}
	})
	t.Run("304 is a plain rejection", func(t *testing.T) {
		sender, _ := NewWebPushSender(testKeys(t), answering(304, nil, nil))
		_, err := sender.Send(context.Background(), testSubscription(), payload, time.Now())
		if err == nil || err.Error() != "Servicio de push: respuesta HTTP 304" {
			t.Fatalf("got %v", err)
		}
	})
	t.Run("no connection", func(t *testing.T) {
		client := &http.Client{Transport: roundTrip(func(*http.Request) (*http.Response, error) {
			return nil, errors.New("dial failed")
		})}
		sender, _ := NewWebPushSender(testKeys(t), client)
		_, err := sender.Send(context.Background(), testSubscription(), payload, time.Now())
		if err == nil || err.Error() != "Servicio de push sin conexión" {
			t.Fatalf("got %v", err)
		}
		secretValues(t, fmt.Sprintf("%v %+v %#v", err, err, errors.Unwrap(err)))
	})
	t.Run("endpoint it cannot read", func(t *testing.T) {
		sender, _ := NewWebPushSender(testKeys(t), answering(201, nil, nil))
		bad := testSubscription()
		bad.Endpoint = "http://fcm.googleapis.com/fcm/send/synthetic-capability-token"
		_, err := sender.Send(context.Background(), bad, payload, time.Now())
		if err == nil {
			t.Fatal("expected an error")
		}
		secretValues(t, fmt.Sprintf("%v %+v", err, err))
	})
}

func TestEachMessageUsesFreshKeyMaterial(t *testing.T) {
	var bodies [2][]byte
	for i := range bodies {
		sender, _ := NewWebPushSender(testKeys(t), answering(201, nil, &bodies[i]))
		if _, err := sender.Send(context.Background(), testSubscription(), application.PushPayload{Title: "x"}, time.Now()); err != nil {
			t.Fatal(err)
		}
	}
	if bytes.Equal(bodies[0][:16], bodies[1][:16]) || bytes.Equal(bodies[0][21:86], bodies[1][21:86]) {
		t.Fatal("salt or ephemeral key repeated")
	}
}
