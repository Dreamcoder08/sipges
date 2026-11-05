package domain

import (
	"encoding/json"
	"os"
	"strings"
	"testing"
	"time"
)

func TestEncodeURIComponentKeepsTheJavaScriptUnreservedSet(t *testing.T) {
	for in, want := range map[string]string{
		"":                       "",
		"ALERT-1":                "ALERT-1",
		"AZaz09-_.!~*'()":        "AZaz09-_.!~*'()",
		"a b/c?d#e&f=g+h":        "a%20b%2Fc%3Fd%23e%26f%3Dg%2Bh",
		"ñ":                      "%C3%B1",
		"😀":                      "%F0%9F%98%80",
		"%":                      "%25",
		"[]@$,;:":                "%5B%5D%40%24%2C%3B%3A",
		"  ":                     "%C2%A0%E2%80%A8",
		strings.Repeat("x", 3):   "xxx",
		"<script>\"'</script>":   "%3Cscript%3E%22'%3C%2Fscript%3E",
		"\x00\x1f\x7f":           "%00%1F%7F",
		"alerta·digital/2026-11": "alerta%C2%B7digital%2F2026-11",
	} {
		if got := EncodeURIComponent(in); got != want {
			t.Errorf("EncodeURIComponent(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestSourcesAreTheRecordModulesThenTheSystemSources(t *testing.T) {
	sources := Sources()
	if len(sources) != len(RecordModules)+6 {
		t.Fatalf("got %d sources", len(sources))
	}
	if sources[0] != (Source{Module: "Eventos", Label: "Eventos"}) {
		t.Errorf("first source %+v", sources[0])
	}
	if sources[9] != (Source{Module: "Directorio_Territorial", Label: "Directorio Territorial"}) {
		t.Errorf("tenth source %+v", sources[9])
	}
	if last := sources[len(sources)-1]; last != (Source{Module: "Analista", Label: "Propuestas del analista"}) {
		t.Errorf("last source %+v", last)
	}
}

func TestSlugOfARecordModule(t *testing.T) {
	for module, want := range map[string]string{
		"Eventos": "eventos", "Directorio_Territorial": "directorio", "Lecciones_Territoriales": "lecciones",
		"Buzon": "buzon", "InteligenciaDigital": "", "eventos": "", "": "",
	} {
		got, ok := Slug(module)
		if got != want || ok != (want != "") {
			t.Errorf("Slug(%q) = %q, %v", module, got, ok)
		}
	}
}

func TestLimitsAreClampedAsTheService(t *testing.T) {
	for _, c := range []struct{ in, runs, inbox int64 }{
		{-5, 1, 1}, {0, 1, 1}, {1, 1, 1}, {30, 30, 30}, {150, 150, 100}, {1 << 62, 200, 100},
	} {
		if got := RunsLimit(c.in); got != c.runs {
			t.Errorf("RunsLimit(%d) = %d", c.in, got)
		}
		if got := InboxLimit(c.in); got != c.inbox {
			t.Errorf("InboxLimit(%d) = %d", c.in, got)
		}
	}
}

func TestISOSecondsIsDateToISOStringWithoutFractions(t *testing.T) {
	for _, c := range []struct {
		in   time.Time
		want string
	}{
		{time.Date(2026, 11, 3, 10, 0, 0, 999_999_000, time.UTC), "2026-11-03T10:00:00Z"},
		{time.Date(2026, 11, 3, 5, 0, 1, 0, time.FixedZone("Lima", -5*3600)), "2026-11-03T10:00:01Z"},
		{time.Date(12345, 1, 2, 3, 4, 5, 0, time.UTC), "+012345-01-02T03:04:05Z"},
		{time.Date(-1, 1, 2, 3, 4, 5, 0, time.UTC), "-000001-01-02T03:04:05Z"},
	} {
		if got := ISOSeconds(c.in); got != c.want {
			t.Errorf("ISOSeconds(%v) = %q, want %q", c.in, got, c.want)
		}
	}
}

func TestPushOrigin(t *testing.T) {
	for endpoint, want := range map[string]string{
		"https://fcm.googleapis.com/fcm/send/x":    "https://fcm.googleapis.com",
		"HTTPS://FCM.googleapis.com:443/x":         "https://fcm.googleapis.com",
		"https://w.notify.windows.com:8443/w/?a=b": "https://w.notify.windows.com:8443",
	} {
		if got, ok := PushOrigin(endpoint); !ok || got != want {
			t.Errorf("%s: %q, %v", endpoint, got, ok)
		}
	}
	for _, endpoint := range []string{"http://fcm.googleapis.com/x", "not a url", "https://user@fcm.googleapis.com/x"} {
		if got, ok := PushOrigin(endpoint); ok {
			t.Errorf("%s: %q", endpoint, got)
		}
	}
}

func TestPushEndpointsMatchTheTypeScriptCheck(t *testing.T) {
	raw, err := os.ReadFile("../testdata/fixtures.json")
	if err != nil {
		t.Fatal(err)
	}
	var f struct {
		Endpoints []struct {
			Endpoint string `json:"endpoint"`
			OK       bool   `json:"ok"`
		} `json:"push_endpoints"`
	}
	if err := json.Unmarshal(raw, &f); err != nil {
		t.Fatal(err)
	}
	if len(f.Endpoints) == 0 {
		t.Fatal("no recorded endpoints")
	}
	for _, c := range f.Endpoints {
		if got := IsPushEndpoint(c.Endpoint); got != c.OK {
			t.Errorf("%.60q: got %v, TypeScript %v", c.Endpoint, got, c.OK)
		}
	}
}
