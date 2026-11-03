// Package domain holds the read models of apps/api/src/contexts/integration: API key metadata,
// media feeds (docs/adr/0021) and the authorized-source catalog. No secret is ever part of
// them: an API key is listed by its public prefix only, never by its stored hash.
package domain

import "time"

// Media monitoring limits of application/media-monitor.ts.
const (
	// PollMinutes is POLL_MINUTES: a feed is fetched at most this often by the cron.
	PollMinutes = 30
	// MaxFeeds is MAX_FEEDS: feeds per project.
	MaxFeeds = 20
)

// APIKey is StoredKey of application/ports.ts: the metadata of a machine credential.
type APIKey struct {
	ID         int
	Name       string
	Prefix     string
	Access     string
	Clearance  string
	CreatedBy  string
	CreatedAt  time.Time
	LastUsedAt *time.Time
	RevokedAt  *time.Time
}

// MediaFeed is MediaFeed of @sipges/contracts, as sql-media-feeds.ts reads it.
type MediaFeed struct {
	ID                int
	Name              string
	URL               string
	Keywords          []string
	Territory         string
	AuthorizationNote string
	Enabled           bool
	UpdatedBy         string
	UpdatedAt         time.Time
	LastPollAt        *time.Time
	LastPollError     string
	LastImported      int
	LastMatched       int
}

// SourceState is AuthorizedSourceState of @sipges/contracts: the project's Defensoría
// connector settings. UpdatedAt is nil until the project saves them (emptySourceState).
type SourceState struct {
	Enabled           bool
	Query             string
	Territory         string
	AuthorizationNote string
	Revision          int
	UpdatedBy         string
	UpdatedAt         *time.Time
	LastPollAt        *time.Time
	LastPollError     string
	LastImported      int
	LastDuplicates    int
}

// Source is the fixed catalog entry of authorized-sources.ts `catalog`.
var Source = struct{ ID, Name, URL, CheckedAt, Attribution string }{
	ID:        "defensoria",
	Name:      "Defensoría del Pueblo del Perú",
	URL:       "https://www.defensoria.gob.pe/",
	CheckedAt: "2026-10-17",
	Attribution: "Publicaciones oficiales de la Defensoría del Pueblo. Solo título y extracto; " + //nolint:misspell // Spanish text of authorized-sources.ts
		"disponibilidad externa variable. Pendientes de verificación.",
}
