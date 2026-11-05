// Package application is the single gate for tenant data bound for an external model or client
// (docs/adr/0030), the port of egress-guard.ts. It refuses while the project's switch is off;
// otherwise it hands out a session whose output has only allowlisted fields, pseudonyms instead of
// names and no contact data, and which writes one access-log entry (ids and counts, never values)
// before anything is sealed.
package application

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/Dreamcoder08/sipges/apps/api-go/internal/platform/database"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/privacy/domain"
)

// Channel is where the data goes: the MCP server, the analyst narrator or an embeddings service.
type Channel string

// The egress channels.
const (
	ChannelMCP        Channel = "mcp"
	ChannelAnalyst    Channel = "analyst"
	ChannelEmbeddings Channel = "embeddings"
)

// Request opens one release.
type Request struct {
	// TenantID is company/project: the key and the known names are those of this project.
	TenantID string
	Channel  Channel
	// Purpose is the tool or purpose, e.g. get_record or briefing; it goes to the access log.
	Purpose string
	// Actor is who asked; nil means the actor of the current request.
	Actor *string
}

// ExternalAIDisabled is the message every refusing path shows for ErrDisabled.
const ExternalAIDisabled = "El envío a IA externa está desactivado para este proyecto"

var (
	// ErrDisabled is the refusal while the project's switch is off.
	ErrDisabled = errors.New("external AI is disabled for this project")
	// ErrReleased is a second release of one session.
	ErrReleased = errors.New("an egress session releases once")
)

const (
	maxLoggedRecords = 100
	maxLoggedFields  = 20
	maxLoggedField   = 60
)

// Deps is what the guard needs from the outside.
type Deps struct {
	Switch Switch
	Names  NameDirectory
	Keys   PseudonymKeys
	Log    EgressLog
	// Now is the clock; nil means time.Now.
	Now func() time.Time
	// Logger takes the refusals; nil logs nothing.
	Logger *slog.Logger
}

// Guard opens egress sessions.
type Guard struct {
	deps Deps
}

// NewGuard builds the guard.
func NewGuard(deps Deps) *Guard {
	if deps.Now == nil {
		deps.Now = time.Now
	}
	return &Guard{deps: deps}
}

// Session is one release: records and text pass through it, then Release logs and seals the
// payload. Its methods may be called from several goroutines.
type Session struct {
	guard         *Guard
	request       Request
	actor         string
	pseudonymiser *domain.Pseudonymiser

	mu            sync.Mutex
	released      bool
	ids           orderedSet
	withheld      orderedSet
	droppedFields orderedSet
	sent, dropped int
}

// orderedSet keeps the first position of each value, as a JavaScript Set does.
type orderedSet struct {
	seen   map[string]struct{}
	values []string
}

func (s *orderedSet) add(value string) {
	if _, ok := s.seen[value]; ok {
		return
	}
	if s.seen == nil {
		s.seen = map[string]struct{}{}
	}
	s.seen[value] = struct{}{}
	s.values = append(s.values, value)
}

// Open refuses with ErrDisabled unless the project switched external AI on.
func (g *Guard) Open(ctx context.Context, request Request) (*Session, error) {
	enabled, err := g.deps.Switch.Enabled(ctx, request.TenantID)
	if err != nil {
		return nil, err
	}
	if !enabled {
		if g.deps.Logger != nil {
			g.deps.Logger.LogAttrs(ctx, slog.LevelInfo, "external_ai_refused",
				slog.String("channel", string(request.Channel)), slog.String("purpose", request.Purpose))
		}
		return nil, ErrDisabled
	}
	names, err := g.deps.Names.Load(ctx, request.TenantID)
	if err != nil {
		return nil, err
	}
	return &Session{
		guard: g, request: request, actor: actorOf(ctx, request),
		pseudonymiser: domain.NewPseudonymiser(g.deps.Keys.MacFor(request.TenantID), names),
	}, nil
}

func actorOf(ctx context.Context, request Request) string {
	if request.Actor != nil {
		return *request.Actor
	}
	if actor, ok := database.ActorFrom(ctx); ok && actor.Name != "" {
		return actor.Name
	}
	return "sistema"
}

// Records keeps allowed fields only, with names replaced by pseudonyms.
func (s *Session) Records(records []domain.RawRecord) []domain.SanitisedRecord {
	sanitised, report := domain.SanitiseRecords(s.pseudonymiser, records)
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, id := range report.Records {
		s.ids.add(id)
	}
	s.sent += report.Sent
	s.dropped += report.Dropped
	for _, id := range report.Withheld {
		s.withheld.add(id)
	}
	for _, field := range report.DroppedFields {
		s.droppedFields.add(field)
	}
	return sanitised
}

// Allows says whether field of module slug may be sent at all; matching on any other leaks it.
func (s *Session) Allows(slug, field string) bool {
	_, ok := domain.PolicyFor(slug, field)
	return ok
}

// Text is free text without contact data or any name the project knows.
func (s *Session) Text(value string) string { return s.pseudonymiser.Scrub(value) }

// Release scrubs every string of data, writes the access log and seals the payload (once).
func Release[T any](ctx context.Context, s *Session, data T) (Sanitised[T], error) {
	sealed, err := ReleaseMany(ctx, s, []T{data})
	if err != nil {
		var zero Sanitised[T]
		return zero, err
	}
	return sealed[0], nil
}

// ReleaseMany is Release for several payloads that travel separately but are logged as one. An
// unlogged release never happens: when the log fails, nothing comes back.
func ReleaseMany[T any](ctx context.Context, s *Session, items []T) ([]Sanitised[T], error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.released {
		return nil, ErrReleased
	}
	s.released = true
	clean := make([]T, 0, len(items))
	chars := 0
	for _, item := range items {
		scrubbed, err := mapValue(item, s.pseudonymiser.Scrub)
		if err != nil {
			return nil, err
		}
		count, err := stringChars(scrubbed)
		if err != nil {
			return nil, err
		}
		clean = append(clean, scrubbed)
		chars += count
	}
	entry := EgressLogEntry{Detail: s.detail(chars), At: s.guard.deps.Now()}
	if err := s.guard.deps.Log.Append(ctx, s.request.TenantID, entry); err != nil {
		return nil, err
	}
	sealed := make([]Sanitised[T], 0, len(clean))
	for _, item := range clean {
		sealed = append(sealed, seal(item))
	}
	return sealed, nil
}

// first is the first limit values, scrubbed.
func (s *Session) first(values []string, limit int) []string {
	shown := make([]string, 0, min(limit, len(values)))
	for _, value := range values[:min(limit, len(values))] {
		shown = append(shown, s.pseudonymiser.Scrub(value))
	}
	return shown
}

// detail is the access-log line: channel, purpose, actor, record ids and counts, never values.
func (s *Session) detail(chars int) string {
	shown := s.first(s.ids.values, maxLoggedRecords)
	records := "ninguno"
	if len(shown) > 0 {
		records = strings.Join(shown, ", ")
	}
	if more := len(s.ids.values) - len(shown); more > 0 {
		records += fmt.Sprintf(" (+%d más)", more)
	}
	dropped := strconv.Itoa(s.dropped)
	if fields := s.first(s.droppedFields.values, maxLoggedFields); len(fields) > 0 {
		for i, field := range fields {
			fields[i] = domain.Slice16(field, maxLoggedField)
		}
		dropped += " (" + strings.Join(fields, ", ") + ")"
	}
	parts := []string{
		"canal " + string(s.request.Channel),
		s.request.Purpose,
		"actor " + s.actor,
		"registros: " + records,
		"campos enviados: " + strconv.Itoa(s.sent),
		"descartados: " + dropped,
	}
	if kept := s.first(s.withheld.values, maxLoggedRecords); len(kept) > 0 {
		parts = append(parts, "retenidos: "+strings.Join(kept, ", "))
	}
	return strings.Join(append(parts, "caracteres: "+strconv.Itoa(chars)), " · ")
}
