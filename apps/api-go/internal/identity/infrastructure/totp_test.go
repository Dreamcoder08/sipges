package infrastructure

import (
	"encoding/base64"
	"encoding/json"
	"os"
	"regexp"
	"testing"
	"time"

	"github.com/Dreamcoder08/sipges/apps/api-go/internal/platform/secrets"
)

const rfcSecret = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ"

func at(seconds int64) time.Time { return time.Unix(seconds, 0) }

// totpFixture is testdata/totp.json, recorded from the TypeScript sources.
type totpFixture struct {
	Key      string `json:"key"`
	Previous string `json:"previous"`
	Codes    []struct {
		Secret string `json:"secret"`
		At     int64  `json:"at"`
		Code   string `json:"code"`
	} `json:"codes"`
	URIs []struct {
		Username string `json:"username"`
		URI      string `json:"uri"`
	} `json:"uris"`
	Sealed []struct {
		Plain string `json:"plain"`
		Value string `json:"value"`
	} `json:"sealed"`
}

func loadTOTPFixture(t *testing.T) totpFixture {
	t.Helper()
	raw, err := os.ReadFile("testdata/totp.json")
	if err != nil {
		t.Fatal(err)
	}
	var f totpFixture
	if err := json.Unmarshal(raw, &f); err != nil {
		t.Fatal(err)
	}
	return f
}

func TestTOTPAcceptsTheCodesTypeScriptComputes(t *testing.T) {
	f := loadTOTPFixture(t)
	if len(f.Codes) < 40 {
		t.Fatalf("%d codes: the fixture lost its cases", len(f.Codes))
	}
	for _, c := range f.Codes {
		moment := time.UnixMilli(c.At)
		step, ok, err := TOTP{}.Verify(c.Secret, c.Code, moment, nil)
		// A short secret's code may repeat in the window: the first matching step answers.
		current := c.At / 30000
		if err != nil || !ok || step < current-1 || step > current {
			t.Errorf("%s at %d: step=%d ok=%v err=%v", c.Secret, c.At, step, ok, err)
		}
		if got, err := (TOTP{}).CodeAt(c.Secret, moment); err != nil || got != c.Code {
			t.Errorf("%s at %d: code %q, TypeScript %q, err=%v", c.Secret, c.At, got, c.Code, err)
		}
	}
}

func TestTOTPWindowAndShape(t *testing.T) {
	for seconds, code := range map[int64]string{59: "287082", 1111111109: "081804", 1234567890: "005924", 2000000000: "279037"} {
		step, ok, err := TOTP{}.Verify(rfcSecret, code, at(seconds), nil)
		if err != nil || !ok || step != seconds/30 {
			t.Errorf("t=%d: step=%d ok=%v err=%v", seconds, step, ok, err)
		}
	}
	verify := func(code string, moment time.Time, last *int64) bool {
		_, ok, err := TOTP{}.Verify(rfcSecret, code, moment, last)
		if err != nil {
			t.Fatal(err)
		}
		return ok
	}
	if !verify("081804", at(1111111109+30), nil) || !verify("081804", at(1111111109-30), nil) {
		t.Fatal("one step of drift must pass")
	}
	if verify("081804", at(1111111109+60), nil) || verify("081804", at(1111111109-60), nil) {
		t.Fatal("two steps of drift must fail")
	}
	for _, code := range []string{"", "12345", "1234567", "abcdef", " 081804", "081804 ", "081804\n", "٠٨١٨٠٤"} {
		if verify(code, at(1111111109), nil) {
			t.Errorf("malformed code %q passed", code)
		}
	}
	if _, ok, _ := (TOTP{}).Verify("", "081804", at(1111111109), nil); ok {
		t.Fatal("an empty secret must fail")
	}
}

func TestTOTPRefusesAReplayedStep(t *testing.T) {
	step := int64(1111111109 / 30)
	if _, ok, _ := (TOTP{}).Verify(rfcSecret, "081804", at(1111111109), &step); ok {
		t.Fatal("the stored step was accepted again")
	}
	earlier := step - 1
	if got, ok, _ := (TOTP{}).Verify(rfcSecret, "081804", at(1111111109), &earlier); !ok || got != step {
		t.Fatalf("got %d %v", got, ok)
	}
}

func TestTOTPRefusesAnInvalidStoredSecretWithAnError(t *testing.T) {
	// TypeScript throws here: a stored secret that is not base32 answers 500, not "bad code".
	if _, _, err := (TOTP{}).Verify("not base32!", "081804", at(1111111109), nil); err == nil {
		t.Fatal("no error")
	}
	// The code shape is checked first.
	if _, _, err := (TOTP{}).Verify("not base32!", "12", at(1111111109), nil); err != nil {
		t.Fatalf("err = %v", err)
	}
}

func TestTOTPGenerateSecretAndURI(t *testing.T) {
	a, err := TOTP{}.GenerateSecret()
	if err != nil {
		t.Fatal(err)
	}
	b, _ := TOTP{}.GenerateSecret()
	if !regexp.MustCompile(`^[A-Z2-7]{32}$`).MatchString(a) || a == b {
		t.Fatalf("secrets %q %q", a, b)
	}
	if _, _, err := (TOTP{}).Verify(a, "000000", time.Now(), nil); err != nil {
		t.Fatalf("a generated secret must decode: %v", err)
	}
	for _, c := range loadTOTPFixture(t).URIs {
		if got := (TOTP{}).URI(c.Username, "JBSWY3DPEHPK3PXP"); got != c.URI {
			t.Errorf("%q: got %q, want %q", c.Username, got, c.URI)
		}
	}
}

func TestCipherOpensWhatTypeScriptSealed(t *testing.T) {
	f := loadTOTPFixture(t)
	key, _ := base64.StdEncoding.DecodeString(f.Key)
	previous, _ := base64.StdEncoding.DecodeString(f.Previous)
	cipher, err := secrets.NewCipher(key, previous)
	if err != nil {
		t.Fatal(err)
	}
	for _, c := range f.Sealed {
		if got, err := cipher.Open(c.Value); err != nil || got != c.Plain {
			t.Errorf("%q: got %q err=%v", c.Plain, got, err)
		}
	}
}
