// Package infrastructure reads the integration tables with the queries of
// apps/api/src/contexts/integration/infrastructure: sql-api-key-store.ts `list`,
// sql-media-feeds.ts `list` and sql-source-settings.ts `get`.
package infrastructure

import (
	"context"
	"errors"

	"github.com/jackc/pgx/v5"

	"github.com/Dreamcoder08/sipges/apps/api-go/internal/integration/domain"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/platform/database"
)

// DB is the pool: api_keys is read on it directly, the tenant tables through WithTenant.
type DB interface {
	database.Beginner
	Query(ctx context.Context, sql string, args ...any) (pgx.Rows, error)
}

// listKeys never selects secret_hash: the Go API has no reason to hold a key's hash.
const listKeys = `SELECT id, name, prefix, access, clearance, created_by, created_at, last_used_at, revoked_at
  FROM api_keys WHERE tenant_id = $1 ORDER BY revoked_at IS NOT NULL, name, id`

const listFeeds = `SELECT id, name, url, keywords, territory, authorization_note, enabled, updated_by,
  updated_at, last_poll_at, last_poll_error, last_imported, last_matched
  FROM media_feeds WHERE tenant_id = $1 ORDER BY id`

const sourceState = `SELECT enabled, query, territory, authorization_note, revision, updated_by, updated_at,
  last_poll_at, last_poll_error, last_imported, last_duplicates
  FROM source_import_settings WHERE tenant_id = $1 AND source_id = 'defensoria'`

// Store is the read side of the integration SQL stores.
type Store struct {
	DB DB
}

// APIKeys reads the tenant's keys. api_keys is a global table the tenant role cannot read (it is
// looked up by prefix before any tenant is known), so, like sql-api-key-store.ts, it is read on
// the owner connection and always filtered by the resolved tenant.
func (s Store) APIKeys(ctx context.Context, tenantID string) ([]domain.APIKey, error) {
	rows, err := s.DB.Query(ctx, listKeys, tenantID)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, func(row pgx.CollectableRow) (domain.APIKey, error) {
		var (
			k  domain.APIKey
			id int32
		)
		err := row.Scan(&id, &k.Name, &k.Prefix, &k.Access, &k.Clearance, &k.CreatedBy,
			&k.CreatedAt, &k.LastUsedAt, &k.RevokedAt)
		k.ID = int(id)
		return k, err
	})
}

// Feeds reads the tenant's media feeds inside the tenant transaction (forced RLS).
func (s Store) Feeds(ctx context.Context, tenantID string) ([]domain.MediaFeed, error) {
	return database.WithTenant(ctx, s.DB, tenantID, func(ctx context.Context, q database.Querier) ([]domain.MediaFeed, error) {
		rows, err := q.Query(ctx, listFeeds, tenantID)
		if err != nil {
			return nil, err
		}
		return pgx.CollectRows(rows, func(row pgx.CollectableRow) (domain.MediaFeed, error) {
			var (
				f                     domain.MediaFeed
				id, imported, matched int32
			)
			err := row.Scan(&id, &f.Name, &f.URL, &f.Keywords, &f.Territory, &f.AuthorizationNote,
				&f.Enabled, &f.UpdatedBy, &f.UpdatedAt, &f.LastPollAt, &f.LastPollError, &imported, &matched)
			f.ID, f.LastImported, f.LastMatched = int(id), int(imported), int(matched)
			if f.Keywords == nil {
				f.Keywords = []string{}
			}
			return f, err
		})
	})
}

// SourceState reads the tenant's Defensoría settings inside the tenant transaction.
func (s Store) SourceState(ctx context.Context, tenantID string) (*domain.SourceState, error) {
	return database.WithTenant(ctx, s.DB, tenantID, func(ctx context.Context, q database.Querier) (*domain.SourceState, error) {
		var (
			st                             domain.SourceState
			revision, imported, duplicates int32
		)
		err := q.QueryRow(ctx, sourceState, tenantID).Scan(&st.Enabled, &st.Query, &st.Territory,
			&st.AuthorizationNote, &revision, &st.UpdatedBy, &st.UpdatedAt, &st.LastPollAt,
			&st.LastPollError, &imported, &duplicates)
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, nil
		}
		if err != nil {
			return nil, err
		}
		st.Revision, st.LastImported, st.LastDuplicates = int(revision), int(imported), int(duplicates)
		return &st, nil
	})
}
