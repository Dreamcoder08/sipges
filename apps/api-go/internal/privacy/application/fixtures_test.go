package application_test

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"os"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/Dreamcoder08/sipges/apps/api-go/internal/platform/database"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/privacy/application"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/privacy/domain"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/privacy/infrastructure"
)

type guardCase struct {
	Name  string `json:"name"`
	Input struct {
		Enabled  *bool   `json:"enabled"`
		TenantID *string `json:"tenantId"`
		Channel  *string `json:"channel"`
		Purpose  *string `json:"purpose"`
		Actor    *string `json:"actor"`
		Records  []struct {
			Module  string  `json:"module"`
			ID      string  `json:"id"`
			Title   *string `json:"title"`
			Date    *string `json:"date"`
			Marking *string `json:"marking"`
			Fields  [][]any `json:"fields"`
		} `json:"records"`
		Payloads []any `json:"payloads"`
	} `json:"input"`
	Refused  *string         `json:"refused"`
	Released json.RawMessage `json:"released"`
	Audit    []struct {
		TenantID string `json:"tenantId"`
		Detail   string `json:"detail"`
	} `json:"audit"`
	Text   string `json:"text"`
	Allows []bool `json:"allows"`
}

type fixture struct {
	Pseudonymisers struct {
		Plain struct {
			Names []struct {
				Kind string `json:"kind"`
				Name string `json:"name"`
			} `json:"names"`
		} `json:"plain"`
	} `json:"pseudonymisers"`
	Guard []guardCase `json:"guard"`
}

func load(t *testing.T) fixture {
	t.Helper()
	raw, err := os.ReadFile("../testdata/fixtures.json")
	if err != nil {
		t.Fatal(err)
	}
	var f fixture
	if err := json.Unmarshal(raw, &f); err != nil {
		t.Fatal(err)
	}
	return f
}

type fakes struct {
	enabled bool
	names   []domain.KnownName
	written []application.EgressLogEntry
	tenants []string
	failLog error
}

func (f *fakes) Enabled(context.Context, string) (bool, error) { return f.enabled, nil }
func (f *fakes) Load(context.Context, string) ([]domain.KnownName, error) {
	return f.names, nil
}

func (f *fakes) Append(_ context.Context, tenantID string, entry application.EgressLogEntry) error {
	if f.failLog != nil {
		return f.failLog
	}
	f.tenants = append(f.tenants, tenantID)
	f.written = append(f.written, entry)
	return nil
}

var at = time.Date(2026, 11, 4, 12, 0, 0, 0, time.UTC)

func guardOf(f *fakes) *application.Guard {
	return application.NewGuard(application.Deps{
		Switch: f, Names: f, Log: f, Now: func() time.Time { return at },
		Keys: infrastructure.NewKeys(bytes.Repeat([]byte{7}, 32)),
	})
}

func or(value *string, fallback string) string {
	if value != nil {
		return *value
	}
	return fallback
}

func canonical(t *testing.T, raw []byte) string {
	t.Helper()
	var value any
	if err := json.Unmarshal(raw, &value); err != nil {
		t.Fatal(err)
	}
	out, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	return string(out)
}

// Each scenario ran through the TypeScript guard: same payload, same access-log line.
func TestGuardMatchesTypeScript(t *testing.T) {
	f := load(t)
	names := make([]domain.KnownName, 0, len(f.Pseudonymisers.Plain.Names))
	for _, n := range f.Pseudonymisers.Plain.Names {
		names = append(names, domain.KnownName{Kind: domain.PseudonymKind(n.Kind), Name: n.Name})
	}
	for _, c := range f.Guard {
		t.Run(c.Name, func(t *testing.T) {
			deps := &fakes{enabled: c.Input.Enabled == nil || *c.Input.Enabled, names: names}
			tenant := or(c.Input.TenantID, "SIPGES/PRJ-SECHURA")
			session, err := guardOf(deps).Open(t.Context(), application.Request{
				TenantID: tenant, Channel: application.Channel(or(c.Input.Channel, "mcp")),
				Purpose: or(c.Input.Purpose, "get_record"), Actor: c.Input.Actor,
			})
			if c.Refused != nil {
				if !errors.Is(err, application.ErrDisabled) || len(deps.written) != 0 {
					t.Fatalf("err = %v, log %v", err, deps.written)
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			records := make([]domain.RawRecord, 0, len(c.Input.Records))
			for _, r := range c.Input.Records {
				fields := make([]domain.RawField, 0, len(r.Fields))
				for _, pair := range r.Fields {
					fields = append(fields, domain.RawField{Name: pair[0].(string), Value: pair[1]})
				}
				records = append(records, domain.RawRecord{
					Module: r.Module, ID: r.ID, Title: r.Title, Date: r.Date, Marking: r.Marking, Fields: fields,
				})
			}
			sanitised := session.Records(records)
			payloads := c.Input.Payloads
			if payloads == nil {
				payloads = []any{map[string]any{"records": sanitised}}
			}
			released, err := application.ReleaseMany(t.Context(), session, payloads)
			if err != nil {
				t.Fatal(err)
			}
			got, err := json.Marshal(released)
			if err != nil {
				t.Fatal(err)
			}
			if a, b := canonical(t, got), canonical(t, c.Released); a != b {
				t.Errorf("released:\n got %s\nwant %s", a, b)
			}
			if len(deps.written) != len(c.Audit) {
				t.Fatalf("log rows %d, want %d", len(deps.written), len(c.Audit))
			}
			for i, want := range c.Audit {
				if got := domain.WellFormed(deps.written[i].Detail); got != want.Detail {
					t.Errorf("detail:\n got %s\nwant %s", got, want.Detail)
				}
				if deps.tenants[i] != want.TenantID || !deps.written[i].At.Equal(at) {
					t.Errorf("row %d: %s at %s", i, deps.tenants[i], deps.written[i].At)
				}
			}
			if got := session.Text("Habló José Pérez Núñez, a.b@x.org"); got != c.Text {
				t.Errorf("text %q, want %q", got, c.Text)
			}
			allows := []bool{session.Allows("actores", "Territorio"), session.Allows("actores", "Posicion_Proyecto"), session.Allows("nada", "Territorio")}
			if !reflect.DeepEqual(allows, c.Allows) {
				t.Errorf("allows %v, want %v", allows, c.Allows)
			}
		})
	}
}

func open(t *testing.T, deps *fakes) *application.Session {
	t.Helper()
	session, err := guardOf(deps).Open(t.Context(), application.Request{TenantID: "A/B", Channel: application.ChannelMCP, Purpose: "x"})
	if err != nil {
		t.Fatal(err)
	}
	return session
}

func TestASessionReleasesOnce(t *testing.T) {
	deps := &fakes{enabled: true}
	session := open(t, deps)
	if _, err := application.Release(t.Context(), session, "uno"); err != nil {
		t.Fatal(err)
	}
	if _, err := application.Release(t.Context(), session, "dos"); !errors.Is(err, application.ErrReleased) {
		t.Fatalf("second release: %v", err)
	}
	if len(deps.written) != 1 {
		t.Fatalf("log rows %d", len(deps.written))
	}
}

func TestAnUnloggedReleaseNeverHappens(t *testing.T) {
	boom := errors.New("audit down")
	session := open(t, &fakes{enabled: true, failLog: boom})
	sealed, err := application.Release(t.Context(), session, "secreto")
	if !errors.Is(err, boom) {
		t.Fatalf("err = %v", err)
	}
	if sealed.Value() != "" {
		t.Fatalf("payload left: %q", sealed.Value())
	}
}

type hidden struct{ note string }

// A value the guard cannot read does not leave, and is not logged as released.
func TestAPayloadTheGuardCannotReadFailsClosed(t *testing.T) {
	for name, release := range map[string]func(context.Context, *application.Session) error{
		"bytes": func(c context.Context, s *application.Session) error {
			return second(application.Release(c, s, []byte("x")))
		},
		"raw JSON": func(c context.Context, s *application.Session) error {
			return second(application.Release(c, s, json.RawMessage(`"x"`)))
		},
		"unexported": func(c context.Context, s *application.Session) error {
			return second(application.Release(c, s, hidden{"x"}))
		},
		"nested": func(c context.Context, s *application.Session) error {
			return second(application.Release[any](c, s, []any{hidden{"x"}}))
		},
		"channel": func(c context.Context, s *application.Session) error {
			return second(application.Release(c, s, make(chan string)))
		},
		"int keys": func(c context.Context, s *application.Session) error {
			return second(application.Release(c, s, map[int]string{1: "x"}))
		},
	} {
		t.Run(name, func(t *testing.T) {
			deps := &fakes{enabled: true}
			if err := release(t.Context(), open(t, deps)); !errors.Is(err, application.ErrUnreleasable) {
				t.Fatalf("err = %v", err)
			}
			if len(deps.written) != 0 {
				t.Fatalf("logged a release that did not happen: %v", deps.written)
			}
		})
	}
}

func second[T any](_ T, err error) error { return err }

type summary struct {
	Title  string
	Note   *string
	Tags   []string
	Score  json.Number
	Seen   time.Time
	Nested map[string]any
	Fields domain.Fields
	Count  int
}

func TestStructsAreWalkedAndMapKeysStay(t *testing.T) {
	const name = "José Pérez Núñez"
	deps := &fakes{enabled: true, names: []domain.KnownName{{Kind: domain.Persona, Name: name}}}
	session := open(t, deps)
	note := "fono 987654321"
	in := summary{
		Title: name, Note: &note, Tags: []string{name}, Score: "987654321", Seen: at,
		Nested: map[string]any{name: []any{name, 1.5, nil}},
		Fields: domain.Fields{{Name: name, Value: domain.Value{Text: name}}, {Name: "n", Value: domain.Value{Number: 987654321, IsNumber: true}}},
		Count:  987654321,
	}
	sealed, err := application.Release(t.Context(), session, in)
	if err != nil {
		t.Fatal(err)
	}
	out := sealed.Value()
	token := session.Text(name)
	if out.Title != token || *out.Note != "fono [teléfono]" || out.Tags[0] != token || out.Score != "987654321" ||
		!out.Seen.Equal(at) || out.Count != 987654321 {
		t.Fatalf("out = %+v", out)
	}
	list := out.Nested[name].([]any)
	if list[0] != token || list[1] != 1.5 || list[2] != nil {
		t.Fatalf("nested = %v", list)
	}
	if out.Fields[0].Name != name || out.Fields[0].Value.Text != token || out.Fields[1].Value.Number != 987654321 {
		t.Fatalf("fields = %+v", out.Fields)
	}
	if in.Title != name || note != "fono 987654321" || in.Tags[0] != name || in.Fields[0].Value.Text != name {
		t.Fatalf("the input changed: %+v", in)
	}
	if !strings.HasPrefix(token, "Persona-") {
		t.Fatalf("token = %q", token)
	}
}

func TestTheActorComesFromTheRequest(t *testing.T) {
	deps := &fakes{enabled: true}
	ctx := database.WithActor(t.Context(), database.Actor{Name: "analista", Clearance: database.ClearanceFull})
	session, err := guardOf(deps).Open(ctx, application.Request{TenantID: "A/B", Channel: application.ChannelAnalyst, Purpose: "briefing"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := application.Release(ctx, session, "x"); err != nil {
		t.Fatal(err)
	}
	if got := deps.written[0].Detail; !strings.Contains(got, "canal analyst · briefing · actor analista ·") {
		t.Fatalf("detail = %q", got)
	}
}

func TestExemptPayloadIsNotSanitised(t *testing.T) {
	if got := application.ExemptPayload("José Pérez", application.ExemptConstant).Value(); got != "José Pérez" {
		t.Fatalf("got %q", got)
	}
}
