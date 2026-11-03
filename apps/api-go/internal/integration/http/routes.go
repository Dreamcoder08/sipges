// Package http serves the admin read routes of apps/api/src/contexts/integration with the same
// JSON: GET /system/integrations/api-keys (api-key-routes.ts), GET /system/v4/media
// (media-routes.ts) and GET /system/intelligence/sources (source-routes.ts). The scope's project
// is always used; the session, project scope and role gate ran before (internal/app). Writes,
// previews, polls, ingest webhooks and key verification stay in the TypeScript API.
package http

import (
	"context"
	"log/slog"
	"net/http"
	"time"

	"github.com/Dreamcoder08/sipges/apps/api-go/internal/integration/application"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/integration/domain"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/platform/httpx"
	tenancy "github.com/Dreamcoder08/sipges/apps/api-go/internal/tenancy/domain"
	tenancyhttp "github.com/Dreamcoder08/sipges/apps/api-go/internal/tenancy/http"
)

// isoSeconds is isoSeconds of platform/http/time.ts: ISO 8601 UTC without fractional seconds.
func isoSeconds(t time.Time) string { return t.UTC().Format("2006-01-02T15:04:05Z") }

// isoMillis is Date#toISOString: milliseconds, truncated like a JavaScript Date.
func isoMillis(t time.Time) string { return t.UTC().Format("2006-01-02T15:04:05.000Z") }

func optional(t *time.Time, format func(time.Time) string) *string {
	if t == nil {
		return nil
	}
	s := format(*t)
	return &s
}

// apiKeyJSON is ApiKeyOut of @sipges/contracts: metadata only, never the hash or the secret.
type apiKeyJSON struct {
	ID         int     `json:"id"`
	Name       string  `json:"name"`
	Prefix     string  `json:"prefix"`
	Access     string  `json:"access"`
	Clearance  string  `json:"clearance"`
	CreatedBy  string  `json:"created_by"`
	CreatedAt  string  `json:"created_at"`
	LastUsedAt *string `json:"last_used_at"`
	RevokedAt  *string `json:"revoked_at"`
}

type feedJSON struct {
	ID                int      `json:"id"`
	Name              string   `json:"name"`
	URL               string   `json:"url"`
	Keywords          []string `json:"keywords"`
	Territory         string   `json:"territory"`
	AuthorizationNote string   `json:"authorization_note"`
	Enabled           bool     `json:"enabled"`
	UpdatedBy         string   `json:"updated_by"`
	UpdatedAt         string   `json:"updated_at"`
	LastPollAt        *string  `json:"last_poll_at"`
	LastPollError     string   `json:"last_poll_error"`
	LastImported      int      `json:"last_imported"`
	LastMatched       int      `json:"last_matched"`
}

type mediaJSON struct {
	PollMinutes int        `json:"poll_minutes"`
	MaxFeeds    int        `json:"max_feeds"`
	Feeds       []feedJSON `json:"feeds"`
}

type sourceStateJSON struct {
	Enabled           bool    `json:"enabled"`
	Query             string  `json:"query"`
	Territory         string  `json:"territory"`
	AuthorizationNote string  `json:"authorization_note"`
	Revision          int     `json:"revision"`
	UpdatedBy         string  `json:"updated_by"`
	UpdatedAt         *string `json:"updated_at"`
	LastPollAt        *string `json:"last_poll_at"`
	LastPollError     string  `json:"last_poll_error"`
	LastImported      int     `json:"last_imported"`
	LastDuplicates    int     `json:"last_duplicates"`
}

type catalogJSON struct {
	ID          string          `json:"id"`
	Name        string          `json:"name"`
	URL         string          `json:"url"`
	CheckedAt   string          `json:"checked_at"`
	Attribution string          `json:"attribution"`
	State       sourceStateJSON `json:"state"`
}

func toKeys(keys []domain.APIKey) []apiKeyJSON {
	out := make([]apiKeyJSON, 0, len(keys))
	for _, k := range keys {
		out = append(out, apiKeyJSON{
			ID: k.ID, Name: k.Name, Prefix: k.Prefix, Access: k.Access, Clearance: k.Clearance,
			CreatedBy: k.CreatedBy, CreatedAt: isoSeconds(k.CreatedAt),
			LastUsedAt: optional(k.LastUsedAt, isoSeconds), RevokedAt: optional(k.RevokedAt, isoSeconds),
		})
	}
	return out
}

func toMedia(m application.MediaState) mediaJSON {
	feeds := make([]feedJSON, 0, len(m.Feeds))
	for _, f := range m.Feeds {
		feeds = append(feeds, feedJSON{
			ID: f.ID, Name: f.Name, URL: f.URL, Keywords: f.Keywords, Territory: f.Territory,
			AuthorizationNote: f.AuthorizationNote, Enabled: f.Enabled, UpdatedBy: f.UpdatedBy,
			UpdatedAt: isoMillis(f.UpdatedAt), LastPollAt: optional(f.LastPollAt, isoMillis),
			LastPollError: f.LastPollError, LastImported: f.LastImported, LastMatched: f.LastMatched,
		})
	}
	return mediaJSON{PollMinutes: m.PollMinutes, MaxFeeds: m.MaxFeeds, Feeds: feeds}
}

func toCatalog(s domain.SourceState) catalogJSON {
	return catalogJSON{
		ID: domain.Source.ID, Name: domain.Source.Name, URL: domain.Source.URL,
		CheckedAt: domain.Source.CheckedAt, Attribution: domain.Source.Attribution,
		State: sourceStateJSON{
			Enabled: s.Enabled, Query: s.Query, Territory: s.Territory, AuthorizationNote: s.AuthorizationNote,
			Revision: s.Revision, UpdatedBy: s.UpdatedBy, UpdatedAt: optional(s.UpdatedAt, isoMillis),
			LastPollAt: optional(s.LastPollAt, isoMillis), LastPollError: s.LastPollError,
			LastImported: s.LastImported, LastDuplicates: s.LastDuplicates,
		},
	}
}

// Routes registers the integration read routes on mux.
func Routes(mux *http.ServeMux, service application.Service, log *slog.Logger) {
	mux.HandleFunc("GET /system/integrations/api-keys", handle(log, func(ctx context.Context, scope tenancy.Scope) (any, error) {
		keys, err := service.APIKeys(ctx, scope)
		return toKeys(keys), err
	}))
	mux.HandleFunc("GET /system/v4/media", handle(log, func(ctx context.Context, scope tenancy.Scope) (any, error) {
		state, err := service.Media(ctx, scope)
		return toMedia(state), err
	}))
	mux.HandleFunc("GET /system/intelligence/sources", handle(log, func(ctx context.Context, scope tenancy.Scope) (any, error) {
		state, err := service.Sources(ctx, scope)
		return toCatalog(state), err
	}))
}

// handle answers 200 with the work's JSON, or the TypeScript API's onError 500 when the request
// has no resolved project or the work fails.
func handle(log *slog.Logger, work func(context.Context, tenancy.Scope) (any, error)) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		scope, ok := tenancyhttp.ScopeFrom(r.Context())
		var (
			body any
			err  = tenancyhttp.ErrNoScope
		)
		if ok {
			body, err = work(r.Context(), scope)
		}
		if err != nil {
			// Only the event: driver errors may carry connection details.
			if log != nil {
				log.LogAttrs(r.Context(), slog.LevelError, "integration read failed",
					slog.String("request_id", httpx.RequestIDFrom(r.Context())))
			}
			httpx.WriteError(w, http.StatusInternalServerError, "Internal Server Error")
			return
		}
		httpx.WriteJSON(w, http.StatusOK, body)
	}
}
