package infrastructure

import (
	"context"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"

	"github.com/Dreamcoder08/sipges/apps/api-go/internal/integration/application"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/integration/domain"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/platform/database"
	records "github.com/Dreamcoder08/sipges/apps/api-go/internal/records/domain"
)

// The write side of the integration SQL stores, statement for statement with
// sql-api-key-store.ts, sql-ingest-receipts.ts, sql-media-feeds.ts and sql-source-settings.ts.
// Tenant tables are reached only through WithTenant (forced RLS); api_keys, which is global, on
// the owner connection and always filtered by the key's prefix or the resolved tenant.

// Pool is what the runtime stores need: transactions and plain queries on the owner connection.
type Pool interface {
	DB
	QueryRow(ctx context.Context, sql string, args ...any) pgx.Row
	Exec(ctx context.Context, sql string, args ...any) (pgconn.CommandTag, error)
	Begin(ctx context.Context) (pgx.Tx, error)
}

// appendAudit is appendAudit of apps/api/src/platform/database/audit-trail.ts.
const appendAudit = `INSERT INTO audit (tenant_id, ts, module, record_id, action, detail)
     VALUES (current_setting('app.tenant_id', true), $1, $2, $3, $4, $5)`

// ---- API keys ----

const activeKey = `SELECT id, tenant_id, name, access, clearance, secret_hash, last_used_at
       FROM api_keys WHERE prefix = $1 AND revoked_at IS NULL`

const touchKey = `UPDATE api_keys SET last_used_at = $2 WHERE id = $1`

const revokeKey = `UPDATE api_keys SET revoked_at = $3
         WHERE tenant_id = $1 AND id = $2 AND revoked_at IS NULL RETURNING name`

// Keys is the api_keys side the runtime uses.
type Keys struct{ DB Pool }

var _ application.KeyStore = Keys{}

// Active is `active`: the key with this prefix, unless revoked.
func (k Keys) Active(ctx context.Context, prefix string) (*application.ActiveKey, error) {
	var (
		key application.ActiveKey
		id  int32
	)
	err := k.DB.QueryRow(ctx, activeKey, prefix).Scan(&id, &key.TenantID, &key.Name, &key.Access,
		&key.Clearance, &key.SecretHash, &key.LastUsedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	key.KeyID = int(id)
	return &key, nil
}

// Touch is `touch`.
func (k Keys) Touch(ctx context.Context, id int, at time.Time) error {
	_, err := k.DB.Exec(ctx, touchKey, id, at)
	return err
}

// Revoke is `revoke`: the update and its audit row in one owner transaction, the audit row
// written in the tenant (app.tenant_id set for the transaction), as sql-api-key-store.ts does.
func (k Keys) Revoke(ctx context.Context, tenantID string, id int, at time.Time) (revoked bool, err error) {
	tx, err := k.DB.Begin(ctx)
	if err != nil {
		return false, err
	}
	defer func() {
		if err != nil || !revoked {
			_ = tx.Rollback(context.WithoutCancel(ctx))
		}
	}()
	var name string
	err = tx.QueryRow(ctx, revokeKey, tenantID, id, at).Scan(&name)
	if errors.Is(err, pgx.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	if _, err = tx.Exec(ctx, "SELECT set_config('app.tenant_id', $1, true)", tenantID); err != nil {
		return false, err
	}
	recordID := "clave-" + itoa(id)
	if _, err = tx.Exec(ctx, appendAudit, at, "Integraciones", recordID, "DELETE",
		records.WellFormed("Clave de API «"+name+"» revocada")); err != nil {
		return false, err
	}
	if err = tx.Commit(ctx); err != nil {
		return false, err
	}
	return true, nil
}

func itoa(n int) string { return records.NumberString(float64(n)) }

// ---- Idempotency receipts ----

const (
	claimReceipt = `INSERT INTO ingest_receipts (tenant_id, key_id, idem_key, created_at)
         VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING RETURNING 1 AS ok`
	storedReceipt   = `SELECT response::text FROM ingest_receipts WHERE tenant_id = $1 AND key_id = $2 AND idem_key = $3`
	completeReceipt = `UPDATE ingest_receipts SET response = $4::jsonb
         WHERE tenant_id = $1 AND key_id = $2 AND idem_key = $3`
	releaseReceipt = `DELETE FROM ingest_receipts WHERE tenant_id = $1 AND key_id = $2 AND idem_key = $3`
)

// Receipts live in the key's tenant under RLS, like every other tenant row.
type Receipts struct{ DB database.Beginner }

var _ application.Receipts = Receipts{}

// Claim is `claim`.
func (r Receipts) Claim(ctx context.Context, tenantID string, keyID int, key string, at time.Time) (application.ClaimKind, application.Response, error) {
	type claim struct {
		kind     application.ClaimKind
		response application.Response
	}
	c, err := database.WithTenant(ctx, r.DB, tenantID, func(ctx context.Context, q database.Querier) (claim, error) {
		rows, err := q.Query(ctx, claimReceipt, tenantID, keyID, records.WellFormed(key), at)
		if err != nil {
			return claim{}, err
		}
		inserted := rows.Next()
		rows.Close()
		if err := rows.Err(); err != nil {
			return claim{}, err
		}
		if inserted {
			return claim{kind: application.Claimed}, nil
		}
		var stored *string
		err = q.QueryRow(ctx, storedReceipt, tenantID, keyID, records.WellFormed(key)).Scan(&stored)
		if errors.Is(err, pgx.ErrNoRows) || err == nil && stored == nil {
			return claim{kind: application.InProgress}, nil
		}
		if err != nil {
			return claim{}, err
		}
		response, err := storedResponse(*stored)
		return claim{kind: application.Stored, response: response}, err
	})
	return c.kind, c.response, err
}

// storedResponse reads {status, body} as postgres.js gives it to JavaScript: the jsonb value
// parsed (keys in jsonb order), the body written back by JSON.stringify.
func storedResponse(text string) (application.Response, error) {
	v, err := records.ParseBody([]byte(text))
	if err != nil {
		return application.Response{}, err
	}
	o, ok := v.(*records.Object)
	if !ok {
		return application.Response{}, errors.New("integration: stored receipt is not an object")
	}
	status, _ := o.Get("status")
	body, _ := o.Get("body")
	n, _ := status.(float64)
	return application.Response{Status: int(n), Body: records.Stringify(body)}, nil
}

// Complete is `complete`: {status, body} as JSON.stringify writes it.
func (r Receipts) Complete(ctx context.Context, tenantID string, keyID int, key string, response application.Response) error {
	text := `{"status":` + itoa(response.Status) + `,"body":` + string(response.Body) + `}`
	_, err := database.WithTenant(ctx, r.DB, tenantID, func(ctx context.Context, q database.Querier) (struct{}, error) {
		_, err := q.Exec(ctx, completeReceipt, tenantID, keyID, records.WellFormed(key), text)
		return struct{}{}, err
	})
	return err
}

// Release is `release`.
func (r Receipts) Release(ctx context.Context, tenantID string, keyID int, key string) error {
	_, err := database.WithTenant(ctx, r.DB, tenantID, func(ctx context.Context, q database.Querier) (struct{}, error) {
		_, err := q.Exec(ctx, releaseReceipt, tenantID, keyID, records.WellFormed(key))
		return struct{}{}, err
	})
	return err
}

// ---- Media feeds ----

const feedColumns = `id, name, url, keywords, territory, authorization_note, enabled, updated_by,
  updated_at, last_poll_at, last_poll_error, last_imported, last_matched`

const (
	countFeeds = `SELECT count(*) AS n FROM media_feeds WHERE tenant_id=$1`
	insertFeed = `INSERT INTO media_feeds (tenant_id,name,url,keywords,territory,authorization_note,enabled,updated_by,updated_at)
           VALUES ($1,$2,$3,$4::jsonb,$5,$6,$7,$8,$9) RETURNING ` + feedColumns
	startCursor = `INSERT INTO automation_cursors (tenant_id, last_audit_id)
           SELECT current_setting('app.tenant_id', true), COALESCE(max(id), 0) FROM audit
           ON CONFLICT (tenant_id) DO NOTHING`
	updateFeed = `UPDATE media_feeds SET name=$3,url=$4,keywords=$5::jsonb,territory=$6,authorization_note=$7,
             enabled=$8,updated_by=$9,updated_at=$10
           WHERE tenant_id=$1 AND id=$2 RETURNING ` + feedColumns
	deleteFeed = `DELETE FROM media_feeds WHERE tenant_id=$1 AND id=$2 RETURNING name, url`
	claimFeeds = `UPDATE media_feeds SET last_poll_at=$2
           WHERE tenant_id=$1 AND enabled
             AND (last_poll_at IS NULL OR last_poll_at <= $2::timestamptz - make_interval(mins => $3))
           RETURNING ` + feedColumns
	finishFeed = `UPDATE media_feeds SET last_poll_error=$4,last_imported=$5,last_matched=$6
         WHERE tenant_id=$1 AND id=$2 AND last_poll_at=$3`
	mediaAuditModule = "Monitoreo de medios"
)

// Feeds is sql-media-feeds.ts's write side.
type Feeds struct{ DB database.Beginner }

var _ application.FeedStore = Feeds{}

func scanFeed(row pgx.CollectableRow) (domain.MediaFeed, error) {
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
}

func feedAudit(ctx context.Context, q database.Querier, detail string, at time.Time) error {
	_, err := q.Exec(ctx, appendAudit, at, mediaAuditModule, nil, "CONFIG_UPDATE", records.WellFormed(detail))
	return err
}

func isUniqueViolation(err error) bool {
	var pgErr *pgconn.PgError
	return errors.As(err, &pgErr) && pgErr.Code == "23505"
}

func keywordsJSON(keywords []string) string {
	values := make([]any, len(keywords))
	for i, k := range keywords {
		values[i] = k
	}
	return string(records.Stringify(values))
}

func oneFeed(ctx context.Context, q database.Querier, sql string, args ...any) (*domain.MediaFeed, error) {
	rows, err := q.Query(ctx, sql, args...)
	if err != nil {
		return nil, err
	}
	feeds, err := pgx.CollectRows(rows, scanFeed)
	if err != nil || len(feeds) == 0 {
		return nil, err
	}
	return &feeds[0], nil
}

// Create is `create`: the per-project limit, the insert, the tenant's automation cursor (the
// cron visits tenants that have one; it starts at the current audit head) and the audit row.
func (f Feeds) Create(ctx context.Context, tenantID string, feed application.FeedWrite) (*domain.MediaFeed, string, error) {
	type result struct {
		feed    *domain.MediaFeed
		refused string
	}
	r, err := database.WithTenant(ctx, f.DB, tenantID, func(ctx context.Context, q database.Querier) (result, error) {
		var n int64
		if err := q.QueryRow(ctx, countFeeds, tenantID).Scan(&n); err != nil {
			return result{}, err
		}
		if n >= domain.MaxFeeds {
			return result{refused: "limit"}, nil
		}
		saved, err := oneFeed(ctx, q, insertFeed, tenantID, records.WellFormed(feed.Name), records.WellFormed(feed.URL),
			keywordsJSON(feed.Keywords), records.WellFormed(feed.Territory), records.WellFormed(feed.AuthorizationNote),
			feed.Enabled, feed.Actor, feed.At)
		if err != nil {
			return result{}, err
		}
		if _, err := q.Exec(ctx, startCursor); err != nil {
			return result{}, err
		}
		if saved == nil {
			return result{}, errors.New("media_feed_not_created")
		}
		return result{feed: saved}, feedAudit(ctx, q, "Fuente agregada: "+feed.Name+" ("+feed.URL+")", feed.At)
	})
	if isUniqueViolation(err) {
		return nil, "duplicate", nil
	}
	return r.feed, r.refused, err
}

// Update is `update`.
func (f Feeds) Update(ctx context.Context, tenantID string, id int, feed application.FeedWrite) (*domain.MediaFeed, bool, error) {
	saved, err := database.WithTenant(ctx, f.DB, tenantID, func(ctx context.Context, q database.Querier) (*domain.MediaFeed, error) {
		saved, err := oneFeed(ctx, q, updateFeed, tenantID, id, records.WellFormed(feed.Name), records.WellFormed(feed.URL),
			keywordsJSON(feed.Keywords), records.WellFormed(feed.Territory), records.WellFormed(feed.AuthorizationNote),
			feed.Enabled, feed.Actor, feed.At)
		if err != nil || saved == nil {
			return nil, err
		}
		state := "actualizada"
		if !feed.Enabled {
			state = "pausada"
		}
		return saved, feedAudit(ctx, q, "Fuente "+state+": "+feed.Name+" ("+feed.URL+")", feed.At)
	})
	if isUniqueViolation(err) {
		return nil, true, nil
	}
	return saved, false, err
}

// Remove is `remove`.
func (f Feeds) Remove(ctx context.Context, tenantID string, id int, at time.Time) (bool, error) {
	return database.WithTenant(ctx, f.DB, tenantID, func(ctx context.Context, q database.Querier) (bool, error) {
		var name, url string
		err := q.QueryRow(ctx, deleteFeed, tenantID, id).Scan(&name, &url)
		if errors.Is(err, pgx.ErrNoRows) {
			return false, nil
		}
		if err != nil {
			return false, err
		}
		return true, feedAudit(ctx, q, "Fuente eliminada: "+name+" ("+url+")", at)
	})
}

// ClaimDue is `claimDue`, sorted by id.
func (f Feeds) ClaimDue(ctx context.Context, tenantID string, at time.Time, minutes int) ([]domain.MediaFeed, error) {
	feeds, err := database.WithTenant(ctx, f.DB, tenantID, func(ctx context.Context, q database.Querier) ([]domain.MediaFeed, error) {
		rows, err := q.Query(ctx, claimFeeds, tenantID, at, minutes)
		if err != nil {
			return nil, err
		}
		return pgx.CollectRows(rows, scanFeed)
	})
	sortFeeds(feeds)
	return feeds, err
}

func sortFeeds(feeds []domain.MediaFeed) {
	for i := 1; i < len(feeds); i++ {
		for j := i; j > 0 && feeds[j].ID < feeds[j-1].ID; j-- {
			feeds[j], feeds[j-1] = feeds[j-1], feeds[j]
		}
	}
}

// Finish is `finish`.
func (f Feeds) Finish(ctx context.Context, tenantID string, id int, at time.Time, imported, matched int, errorText string) error {
	_, err := database.WithTenant(ctx, f.DB, tenantID, func(ctx context.Context, q database.Querier) (struct{}, error) {
		_, err := q.Exec(ctx, finishFeed, tenantID, id, at, records.WellFormed(errorText), imported, matched)
		return struct{}{}, err
	})
	return err
}

// ---- Defensoría settings ----

const sourceColumns = `enabled, query, territory, authorization_note, revision, updated_by, updated_at,
  last_poll_at, last_poll_error, last_imported, last_duplicates`

const (
	saveSettings = `INSERT INTO source_import_settings (tenant_id,source_id,enabled,query,territory,authorization_note,updated_by,updated_at)
  VALUES ($1,'defensoria',$2,$3,$4,$5,$6,$7) ON CONFLICT (tenant_id,source_id) DO UPDATE SET
  enabled=EXCLUDED.enabled,query=EXCLUDED.query,territory=EXCLUDED.territory,authorization_note=EXCLUDED.authorization_note,
  revision=source_import_settings.revision+1,updated_by=EXCLUDED.updated_by,updated_at=EXCLUDED.updated_at RETURNING ` + sourceColumns
	claimSettings  = `UPDATE source_import_settings SET last_poll_at=$3,last_poll_error='' WHERE tenant_id=$1 AND source_id='defensoria' AND enabled AND revision=$2 AND (last_poll_at IS NULL OR last_poll_at <= $3::timestamptz - interval '15 minutes') RETURNING tenant_id`
	finishSettings = `UPDATE source_import_settings SET last_poll_error=$3,last_imported=$4,last_duplicates=$5 WHERE tenant_id=$1 AND source_id='defensoria' AND last_poll_at=$2`
	cursorTenants  = `SELECT tenant_id FROM automation_cursors ORDER BY tenant_id`
	enabledSource  = `SELECT 1 FROM source_import_settings WHERE tenant_id=$1 AND source_id='defensoria' AND enabled`
)

// Settings is sql-source-settings.ts.
type Settings struct{ DB Pool }

var _ application.SettingsStore = Settings{}

func scanState(row pgx.Row) (domain.SourceState, error) {
	var (
		st                             domain.SourceState
		revision, imported, duplicates int32
	)
	err := row.Scan(&st.Enabled, &st.Query, &st.Territory, &st.AuthorizationNote, &revision,
		&st.UpdatedBy, &st.UpdatedAt, &st.LastPollAt, &st.LastPollError, &imported, &duplicates)
	st.Revision, st.LastImported, st.LastDuplicates = int(revision), int(imported), int(duplicates)
	return st, err
}

// Get is `get`: the empty state when nothing is saved.
func (s Settings) Get(ctx context.Context, tenantID string) (domain.SourceState, error) {
	state, err := Store{DB: s.DB}.SourceState(ctx, tenantID)
	if err != nil || state == nil {
		return domain.SourceState{}, err
	}
	return *state, nil
}

// Save is `save`: the upsert (each save a new revision) and, when enabled, the tenant's
// automation cursor at the current audit head, in the same transaction.
func (s Settings) Save(ctx context.Context, tenantID string, in domain.SourceConfig, username string, at time.Time) (domain.SourceState, error) {
	return database.WithTenant(ctx, s.DB, tenantID, func(ctx context.Context, q database.Querier) (domain.SourceState, error) {
		st, err := scanState(q.QueryRow(ctx, saveSettings, tenantID, in.Enabled, records.WellFormed(in.Query),
			records.WellFormed(in.Territory), records.WellFormed(in.AuthorizationNote), username, at))
		if err != nil {
			return st, err
		}
		if in.Enabled {
			_, err = q.Exec(ctx, startCursor)
		}
		return st, err
	})
}

// ClaimPoll is `claimPoll`.
func (s Settings) ClaimPoll(ctx context.Context, tenantID string, revision int, at time.Time) (bool, error) {
	return database.WithTenant(ctx, s.DB, tenantID, func(ctx context.Context, q database.Querier) (bool, error) {
		rows, err := q.Query(ctx, claimSettings, tenantID, revision, at)
		if err != nil {
			return false, err
		}
		claimed := rows.Next()
		rows.Close()
		return claimed, rows.Err()
	})
}

// FinishPoll is `finishPoll`.
func (s Settings) FinishPoll(ctx context.Context, tenantID string, at time.Time, imported, duplicates int, errorText string) error {
	_, err := database.WithTenant(ctx, s.DB, tenantID, func(ctx context.Context, q database.Querier) (struct{}, error) {
		_, err := q.Exec(ctx, finishSettings, tenantID, at, errorText, imported, duplicates)
		return struct{}{}, err
	})
	return err
}

// ActiveTenants is `activeTenants`: the tenants with an automation cursor (a table the owner may
// enumerate), each checked under its own tenant role.
func (s Settings) ActiveTenants(ctx context.Context) ([]string, error) {
	rows, err := s.DB.Query(ctx, cursorTenants)
	if err != nil {
		return nil, err
	}
	candidates, err := pgx.CollectRows(rows, pgx.RowTo[string])
	if err != nil {
		return nil, err
	}
	enabled := []string{}
	for _, tenantID := range candidates {
		active, err := database.WithTenant(ctx, s.DB, tenantID, func(ctx context.Context, q database.Querier) (bool, error) {
			rows, err := q.Query(ctx, enabledSource, tenantID)
			if err != nil {
				return false, err
			}
			found := rows.Next()
			rows.Close()
			return found, rows.Err()
		})
		if err != nil {
			return nil, err
		}
		if active {
			enabled = append(enabled, tenantID)
		}
	}
	return enabled, nil
}
