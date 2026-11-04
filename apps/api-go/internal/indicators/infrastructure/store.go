// Package infrastructure reads and writes the indicators context's rows in PostgreSQL with the
// queries of apps/api/src/contexts/indicators/infrastructure (module records, IRSA configuration
// and snapshots, and their audit rows) and the project phase of the situations context's settings, inside the tenant
// transaction (docs/adr/0003).
package infrastructure

import (
	"context"
	"encoding/json"
	"errors"
	"strconv"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/Dreamcoder08/sipges/apps/api-go/internal/indicators/application"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/indicators/domain"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/platform/database"
)

const (
	loadConfig = `SELECT config::text FROM irsa_configs WHERE tenant_id = $1`

	relation = `SELECT to_regclass('public.module_records')::text AS present,
  COALESCE((SELECT relrowsecurity AND relforcerowsecurity FROM pg_class
            WHERE oid = to_regclass('public.module_records')), false) AS secured`

	listRecords = `SELECT module, id, payload::text FROM public.module_records
 WHERE tenant_id = $1 AND module = ANY($2::text[])
 ORDER BY module, id`

	// The phase and the weights saved for it (activePhaseWeights): only a string phase names a
	// phaseWeights key; anything else reads as no weights.
	loadPhase = `SELECT settings->>'phase',
  CASE WHEN jsonb_typeof(settings->'phase') = 'string'
       THEN (settings->'phaseWeights'->(settings->>'phase'))::text END
  FROM project_settings WHERE tenant_id = $1`

	listSnapshots = `SELECT id, ts, irsa, level, scores::text, config_version, note FROM irsa_snapshots
 WHERE tenant_id = $1 ORDER BY id DESC LIMIT $2`
)

// ErrUnsecuredRecords is createSqlModuleRecordReader's refusal to read module_records without
// forced row-level security.
var ErrUnsecuredRecords = errors.New("module_records requires forced tenant row-level security")

// Store is the SQL implementation of application.Store.
type Store struct {
	DB database.Beginner
}

var _ application.Store = Store{}

// Config reads the stored IRSA configuration (json, so its text keeps the saved key order).
func (s Store) Config(ctx context.Context, tenantID string) (json.RawMessage, error) {
	return database.WithTenant(ctx, s.DB, tenantID, func(ctx context.Context, q database.Querier) (json.RawMessage, error) {
		return config(ctx, q, tenantID)
	})
}

// Records reads the tenant's records of the indicator modules.
func (s Store) Records(ctx context.Context, tenantID string) (domain.Records, error) {
	return database.WithTenant(ctx, s.DB, tenantID, func(ctx context.Context, q database.Querier) (domain.Records, error) {
		return records(ctx, q, tenantID)
	})
}

// IrsaInputs reads the configuration, the records and the phase in one tenant transaction.
func (s Store) IrsaInputs(ctx context.Context, tenantID string) (application.IrsaInputs, error) {
	return database.WithTenant(ctx, s.DB, tenantID, func(ctx context.Context, q database.Querier) (application.IrsaInputs, error) {
		var in application.IrsaInputs
		var err error
		if in.Config, err = config(ctx, q, tenantID); err != nil {
			return in, err
		}
		if in.Records, err = records(ctx, q, tenantID); err != nil {
			return in, err
		}
		in.Phase, err = phase(ctx, q, tenantID)
		return in, err
	})
}

// History reads the tenant's snapshots, newest first; a nil limit reads every one.
func (s Store) History(ctx context.Context, tenantID string, limit *int64) ([]application.Snapshot, error) {
	return database.WithTenant(ctx, s.DB, tenantID, func(ctx context.Context, q database.Querier) ([]application.Snapshot, error) {
		rows, err := q.Query(ctx, listSnapshots, tenantID, limit)
		if err != nil {
			return nil, err
		}
		return pgx.CollectRows(rows, func(row pgx.CollectableRow) (application.Snapshot, error) {
			var (
				s      application.Snapshot
				id     int32
				ts     time.Time
				scores string
			)
			err := row.Scan(&id, &ts, &s.Irsa, &s.Level, &scores, &s.ConfigVersion, &s.Note)
			s.ID, s.TS, s.Scores = int64(id), isoSeconds(ts), json.RawMessage(scores)
			return s, err
		})
	})
}

// isoSeconds is isoSeconds of platform/http/time.ts: ISO 8601 UTC without fractional seconds.
func isoSeconds(t time.Time) string { return t.UTC().Format("2006-01-02T15:04:05Z") }

func config(ctx context.Context, q database.Querier, tenantID string) (json.RawMessage, error) {
	var text string
	err := q.QueryRow(ctx, loadConfig, tenantID).Scan(&text)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	return json.RawMessage(text), err
}

// records is createSqlModuleRecordReader.read: until module_records exists every module is empty.
func records(ctx context.Context, q database.Querier, tenantID string) (domain.Records, error) {
	out := domain.Records{}
	var (
		present *string
		secured bool
	)
	if err := q.QueryRow(ctx, relation).Scan(&present, &secured); err != nil {
		return nil, err
	}
	if present == nil {
		return out, nil
	}
	if !secured {
		return nil, ErrUnsecuredRecords
	}
	rows, err := q.Query(ctx, listRecords, tenantID, domain.Modules)
	if err != nil {
		return nil, err
	}
	var module, id, payload string
	_, err = pgx.ForEachRow(rows, []any{&module, &id, &payload}, func() error {
		out[module] = append(out[module], domain.Record{ID: id, Payload: json.RawMessage(payload)})
		return nil
	})
	return out, err
}

func phase(ctx context.Context, q database.Querier, tenantID string) (*domain.Phase, error) {
	var (
		id      *string
		weights *string
	)
	err := q.QueryRow(ctx, loadPhase, tenantID).Scan(&id, &weights)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var raw json.RawMessage
	if weights != nil {
		raw = json.RawMessage(*weights)
	}
	p, ok := domain.ActivePhase(id, raw)
	if !ok {
		return nil, nil
	}
	return &p, nil
}

const (
	saveConfig = `INSERT INTO irsa_configs (tenant_id, config, updated_at) VALUES ($1, $2::text::json, $3)
 ON CONFLICT (tenant_id) DO UPDATE SET config = EXCLUDED.config, updated_at = EXCLUDED.updated_at`

	insertSnapshot = `INSERT INTO irsa_snapshots (tenant_id, ts, irsa, level, scores, config_version, note)
 VALUES ($1, $2, $3, $4, $5::text::json, $6, $7) RETURNING id`

	// appendAudit of platform/database/audit-trail.ts: the tenant is the transaction's own.
	insertAudit = `INSERT INTO audit (tenant_id, ts, module, record_id, action, detail)
 VALUES (current_setting('app.tenant_id', true), $1, $2, $3, $4, $5)`
)

// SaveConfig is createSqlIrsaConfigStore.save: the configuration's exact text into the json
// column (so its key order survives) and the CONFIG_UPDATE audit row, in one tenant transaction.
func (s Store) SaveConfig(ctx context.Context, tenantID string, config json.RawMessage, at time.Time, auditDetail string) error {
	_, err := database.WithTenant(ctx, s.DB, tenantID, func(ctx context.Context, q database.Querier) (struct{}, error) {
		if _, err := q.Exec(ctx, saveConfig, tenantID, string(config), at); err != nil {
			return struct{}{}, err
		}
		_, err := q.Exec(ctx, insertAudit, at, "IRSA", nil, "CONFIG_UPDATE", auditDetail)
		return struct{}{}, err
	})
	return err
}

// InsertSnapshot is createSqlIrsaSnapshotStore.insert: the snapshot and its SNAPSHOT audit row
// (record_id the new id) in one tenant transaction.
func (s Store) InsertSnapshot(ctx context.Context, tenantID string, n application.NewSnapshot) (int64, error) {
	return database.WithTenant(ctx, s.DB, tenantID, func(ctx context.Context, q database.Querier) (int64, error) {
		var id int32
		err := q.QueryRow(ctx, insertSnapshot, tenantID, n.TS, n.Irsa, n.Level, string(n.Scores), n.ConfigVersion, n.Note).Scan(&id)
		if err != nil {
			return 0, err
		}
		_, err = q.Exec(ctx, insertAudit, n.TS, "IRSA", strconv.FormatInt(int64(id), 10), "SNAPSHOT", n.AuditDetail)
		return int64(id), err
	})
}
