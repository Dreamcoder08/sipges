package infrastructure

import (
	"context"
	"errors"
	"fmt"
	"strconv"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/Dreamcoder08/sipges/apps/api-go/internal/platform/database"
	records "github.com/Dreamcoder08/sipges/apps/api-go/internal/records/domain"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/tenancy/domain"
)

// exportTables is TABLES of sql-tenant-data-reader.ts, in its order, with each table's sort
// column. The names are static code, never request-controlled; channels stay out because their
// settings hold sealed third-party secrets.
var exportTables = []struct{ name, order string }{
	{"module_records", "id"},
	{"audit", "id"},
	{"attachments", "id"},
	{"document_review", "id"},
	{"digital_alert_reviews", "id"},
	{"preventive_actions", "id"},
	{"preventive_action_log", "id"},
	{"record_versions", "id"},
	{"record_links", "id"},
	{"automation_rules", "id"},
	{"automation_runs", "id"},
	{"notifications", "id"},
	{"source_import_settings", "source_id"},
	{"project_settings", "tenant_id"},
}

// ExportTransaction begins what createSqlTenantDataReader sets first: one snapshot of every
// table, read only, so a dump is never partial.
type ExportTransaction struct{ DB TxBeginner }

// TxBeginner is the part of a pgx pool that opens a transaction with options.
type TxBeginner interface {
	BeginTx(ctx context.Context, opts pgx.TxOptions) (pgx.Tx, error)
}

// Begin satisfies database.Beginner.
func (e ExportTransaction) Begin(ctx context.Context) (pgx.Tx, error) {
	return e.DB.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly})
}

// ExportData is createSqlTenantDataReader. An administrator's export includes records marked
// 'restringido' (ADR 0012), so the transaction runs with full clearance whoever asks.
type ExportData ExportTransaction

// Read returns the project's rows, table by table, as postgres.js gives them to JSON.stringify.
func (e ExportData) Read(ctx context.Context, s domain.Scope) (*records.Object, error) {
	tenantID := s.TenantID()
	ctx = database.WithActor(ctx, database.Actor{Clearance: database.ClearanceFull})
	return database.WithTenant(ctx, ExportTransaction(e), tenantID, func(ctx context.Context, q database.Querier) (*records.Object, error) {
		data := records.NewObject()
		for _, table := range exportTables {
			rows := []any{}
			present, err := secured(ctx, q, table.name)
			if err != nil {
				return nil, err
			}
			if present {
				if rows, err = readTable(ctx, q, table.name, table.order, tenantID); err != nil {
					return nil, err
				}
			}
			data.Set(table.name, rows)
		}
		return data, nil
	})
}

// secured reports whether the table exists, and fails when it exists without forced row-level
// security: the WHERE clause must never be a tenant's only protection in a whole-table dump.
func secured(ctx context.Context, q database.Querier, table string) (bool, error) {
	var present *string
	var forced bool
	err := q.QueryRow(ctx, `SELECT to_regclass($1)::text,
		COALESCE((SELECT relrowsecurity AND relforcerowsecurity FROM pg_class WHERE oid = to_regclass($1)), false)`,
		"public."+table).Scan(&present, &forced)
	if err != nil {
		return false, err
	}
	if present == nil {
		return false, nil
	}
	if !forced {
		return false, errors.New("Export requires forced tenant row-level security") //nolint:staticcheck // the TypeScript message
	}
	return true, nil
}

func readTable(ctx context.Context, q database.Querier, table, order, tenantID string) ([]any, error) {
	// Text results, the format postgres.js parses: a column keeps PostgreSQL's own spelling. Each
	// statement is described afresh: a cached `SELECT *` would fail after a migration adds or
	// drops a column of the table.
	// Both names come from exportTables.
	rows, err := q.Query(ctx, `SELECT * FROM public.`+table+` WHERE tenant_id = $1 ORDER BY `+order,
		pgx.QueryExecModeDescribeExec, pgx.QueryResultFormats{pgx.TextFormatCode}, tenantID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	fields := rows.FieldDescriptions()
	out := []any{}
	for rows.Next() {
		row := records.NewObject()
		for i, raw := range rows.RawValues() {
			value, err := columnValue(fields[i].DataTypeOID, raw)
			if err != nil {
				return nil, fmt.Errorf("%s.%s: %w", table, fields[i].Name, err)
			}
			row.Set(fields[i].Name, value)
		}
		out = append(out, row)
	}
	return out, rows.Err()
}

var textTypes = pgtype.NewMap()

// columnValue is the parser postgres.js picks for a column by its type (src/types.js), with the
// value JSON.stringify then writes: numbers, booleans, json and text arrays are parsed, dates go
// through a Date, and every other type stays text, including bigint, which keeps its digits.
func columnValue(oid uint32, raw []byte) (any, error) {
	if raw == nil {
		return nil, nil
	}
	switch oid {
	case pgtype.BoolOID:
		return string(raw) == "t", nil
	case pgtype.Int2OID, pgtype.Int4OID, pgtype.OIDOID, pgtype.Float4OID, pgtype.Float8OID:
		return strconv.ParseFloat(string(raw), 64)
	case pgtype.JSONOID, pgtype.JSONBOID:
		return records.Parse(raw)
	case pgtype.DateOID, pgtype.TimestampOID, pgtype.TimestamptzOID:
		return dateValue(oid, raw)
	case pgtype.TextArrayOID:
		return textArray(raw)
	}
	return string(raw), nil
}

func textArray(raw []byte) (any, error) {
	var items []*string
	if err := textTypes.Scan(pgtype.TextArrayOID, pgx.TextFormatCode, raw, &items); err != nil {
		return nil, err
	}
	out := make([]any, len(items))
	for i, item := range items {
		if item != nil {
			out[i] = *item
		}
	}
	return out, nil
}

// dateValue is `new Date(text)` under JSON.stringify: the instant in toISOString form, cut to
// milliseconds; infinity is an invalid Date, which JSON.stringify writes as null.
func dateValue(oid uint32, raw []byte) (any, error) {
	var value pgtype.Timestamptz
	if err := textTypes.Scan(oid, pgx.TextFormatCode, raw, &value); err != nil {
		return nil, err
	}
	if value.InfinityModifier != pgtype.Finite {
		return nil, nil
	}
	return value.Time.UTC().Format("2006-01-02T15:04:05.000Z"), nil
}
