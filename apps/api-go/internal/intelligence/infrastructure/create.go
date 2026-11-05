package infrastructure

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"time"

	"github.com/Dreamcoder08/sipges/apps/api-go/internal/intelligence/application"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/intelligence/domain"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/platform/database"
	records "github.com/Dreamcoder08/sipges/apps/api-go/internal/records/domain"
)

const duplicateWindow = 24 * time.Hour

var errNoRow = errors.New("intelligence: alert insert returned no row")

const createAudit = "Señal registrada; IRSA intacto"

const insertDedupLock = `INSERT INTO digital_signal_dedup_locks (tenant_id, dedup_key)
  VALUES (current_setting('app.tenant_id', true), $1) ON CONFLICT DO NOTHING`

const lockDedupKey = `SELECT dedup_key FROM digital_signal_dedup_locks WHERE dedup_key = $1 FOR UPDATE`

const findDuplicate = `SELECT ` + columns + ` FROM digital_alert_reviews
  WHERE sha256 = $1 AND source_url = $2 AND source_type = $3
    AND territory IS NOT DISTINCT FROM $4 AND source_record IS NOT DISTINCT FROM NULL::jsonb
    AND created_at >= $5
  ORDER BY created_at DESC, id DESC LIMIT 1`

const insertAlert = `INSERT INTO digital_alert_reviews (tenant_id, id, project_id, created_at, source_url,
    source_type, excerpt, sha256, level, score, method, themes, signals, suggestions,
    semantic_active, status, analyst_note, territory, source_record)
  VALUES (current_setting('app.tenant_id', true), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
    $11::jsonb, $12::jsonb, $13::jsonb, $14, 'Pendiente de verificación', $15, $16, NULL)
  RETURNING ` + columns

type created struct {
	alert     domain.Alert
	duplicate bool
}

// Create is create of sql-alert-store.ts. A lock on the signal's key makes concurrent equal
// signals wait, so a duplicate finds the first; the key is the one TypeScript computes, so both
// APIs serialise on the same row while traffic moves between them.
func (s Alerts) Create(ctx context.Context, tenantID string, a application.NewAlert) (domain.Alert, bool, error) {
	out, err := database.WithTenant(ctx, s.DB, tenantID, func(ctx context.Context, q database.Querier) (created, error) {
		key := dedupKey(a)
		if _, err := q.Exec(ctx, insertDedupLock, key); err != nil {
			return created{}, err
		}
		if _, err := q.Exec(ctx, lockDedupKey, key); err != nil {
			return created{}, err
		}
		existing, err := one(ctx, q, findDuplicate, a.SHA256, a.SourceURL, a.SourceType, a.Territory, a.CreatedAt.Add(-duplicateWindow))
		if err != nil {
			return created{}, err
		}
		if existing != nil {
			return created{*existing, true}, nil
		}
		row, err := one(ctx, q, insertAlert, a.ID, a.ProjectID, a.CreatedAt, a.SourceURL, a.SourceType, a.Excerpt,
			a.SHA256, a.Level, a.Score, a.Method, string(a.Themes), string(a.Signals), string(a.Suggestions),
			a.SemanticActive, a.AnalystNote, a.Territory)
		if err != nil {
			return created{}, err
		}
		if row == nil {
			return created{}, errNoRow
		}
		if err := audit(ctx, q, *row, "CREATE", createAudit, a.CreatedAt); err != nil {
			return created{}, err
		}
		return created{*row, false}, nil
	})
	return out.alert, out.duplicate, err
}

// dedupKey is the sha-256 of the JSON.stringify of the signal; the last two are the source
// record's module and id, which these signals do not have.
func dedupKey(a application.NewAlert) string {
	var territory any
	if a.Territory != nil {
		territory = *a.Territory
	}
	sum := sha256.Sum256(records.Stringify([]any{a.SHA256, a.SourceURL, a.SourceType, territory, nil, nil}))
	return hex.EncodeToString(sum[:])
}
