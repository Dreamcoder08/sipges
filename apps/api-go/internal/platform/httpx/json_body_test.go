package httpx

import (
	"strings"
	"testing"
)

// Expected values are what JSON.parse and Hono's c.req.json() answer on Node.
func TestParseJSONBodyReadsLikeJSONParse(t *testing.T) {
	valid := map[string]JSONKind{
		`{}`: JSONObject, `[]`: JSONArray, `null`: JSONNull, `true`: JSONBool, `1`: JSONNumber, `"x"`: JSONString,
		`1e400`: JSONInfinity, `-1e400`: JSONNegInf, "\xef\xbb\xbf{}": JSONObject,
	}
	valid["\t\r\n{}"+" "] = JSONObject // JSON whitespace around the value
	for body, kind := range valid {
		got, ok := ParseJSONBody([]byte(body))
		if !ok || got.Kind != kind {
			t.Errorf("%q: %v %v, want %v", body, got.Kind, ok, kind)
		}
	}
	for _, body := range []string{"", " ", "{", "{}x", "01", "1.", "+1", ".5", "'x'", `{"a":1,}`, "[1,]", "tru", "\x0c{}", `"\x"`, `"\u12"`, "\"\n\"", "\xef\xbb\xbf\xef\xbb\xbf{}"} {
		if _, ok := ParseJSONBody([]byte(body)); ok {
			t.Errorf("%q parsed", body)
		}
	}
}

func TestParseJSONBodyFields(t *testing.T) {
	cases := map[string]string{
		`{"code":"1","code":"2"}`:           "2", // the last duplicate wins
		`{"co\u0064e":"3"}`:                 "3", // keys are unescaped
		`{"code":"\ud83d\ude00"}`:           "😀",
		`{"code":"\u00f1"}`:                 "ñ",
		"{\"code\":\"\xff\"}":               "�", // invalid UTF-8 is replaced before parsing
		`{"code":"\ud83d"}`:                 "�", // a lone surrogate reaches Go as U+FFFD
		`{"other":{"code":"x"},"code":"4"}`: "4",
	}
	for body, want := range cases {
		got, ok := ParseJSONBody([]byte(body))
		if !ok || got.Fields["code"].Text != want {
			t.Errorf("%q: %q %v, want %q", body, got.Fields["code"].Text, ok, want)
		}
	}
}

func TestParseJSONBodyHasNoNestingLimit(t *testing.T) {
	const depth = 200_000
	body := `{"a":` + strings.Repeat("[", depth) + strings.Repeat("]", depth) + `,"code":"x"}`
	got, ok := ParseJSONBody([]byte(body))
	if !ok || got.Fields["code"].Text != "x" {
		t.Fatalf("got %v %v", got.Kind, ok)
	}
}
