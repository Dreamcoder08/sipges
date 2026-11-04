// Package application is the read side of apps/api/src/contexts/records/application
// (records-service.ts, records-summary.ts): a module's records, one record, its history and the
// Registros «Todos» page. Creating, replacing, deleting and importing are in writes.go.
package application

import (
	"context"
	"slices"
	"time"

	"github.com/Dreamcoder08/sipges/apps/api-go/internal/records/domain"
)

// Page is the validated `limit`, `offset` and `q` of a list.
type Page struct {
	Limit  int64
	Offset int64
	// Q is the search text; nil (or empty) searches nothing.
	Q *string
}

// StoredRecord is one row of module_records.
type StoredRecord struct {
	ID        string
	Payload   *domain.Object
	UpdatedAt time.Time
}

// TypedRecord is a stored record with its module (cross-type reads).
type TypedRecord struct {
	Module string
	StoredRecord
}

// StoredVersion is one row of record_versions, oldest first; Payload is nil for a deletion.
type StoredVersion struct {
	Operation string
	Payload   *domain.Object
	Actor     string
	At        time.Time
}

// Store reads records inside one tenant transaction; the tenant comes from the request scope,
// never from input.
type Store interface {
	List(ctx context.Context, tenantID, module string, page Page) ([]StoredRecord, error)
	Get(ctx context.Context, tenantID, module, id string) (*StoredRecord, error)
	History(ctx context.Context, tenantID, module, id string) ([]StoredVersion, error)
	// Summary returns the page in `modules` order, newest first within each module, and every
	// module's total matching q (missing when zero).
	Summary(ctx context.Context, tenantID string, modules []string, page Page) ([]TypedRecord, map[string]int64, error)
}

// MaxLimit is MAX_LIMIT, the absolute ceiling for list sizes (docs/adr/0008 #10).
const MaxLimit = 500

// BoundLimit is boundLimit: a negative limit (app.py's "no limit") and any larger one become
// MaxLimit.
func BoundLimit(limit int64) int64 {
	if limit < 0 {
		return MaxLimit
	}
	return min(limit, MaxLimit)
}

// bound applies boundLimit and `q || null`.
func bound(page Page) Page {
	page.Limit = BoundLimit(page.Limit)
	if page.Q != nil && *page.Q == "" {
		page.Q = nil
	}
	return page
}

// Service answers the records read routes.
type Service struct {
	Store Store
}

// List is records.list.
func (s Service) List(ctx context.Context, tenantID, module string, page Page) ([]StoredRecord, error) {
	return s.Store.List(ctx, tenantID, module, bound(page))
}

// Get is records.get: nil when missing or when the id can never be stored.
func (s Service) Get(ctx context.Context, tenantID, module, id string) (*StoredRecord, error) {
	if !domain.IsLookupableID(id) {
		return nil, nil
	}
	return s.Store.Get(ctx, tenantID, module, id)
}

// RecordVersion is RecordVersion of records-service.ts.
type RecordVersion struct {
	Version   int
	Operation string
	Actor     string
	At        time.Time
	Payload   *domain.Object
	Changes   []domain.FieldChange
}

// History is records.history: newest first, numbered from 1, each with its field changes
// against the previous version.
func (s Service) History(ctx context.Context, tenantID, module, id string) ([]RecordVersion, error) {
	if !domain.IsLookupableID(id) {
		return []RecordVersion{}, nil
	}
	versions, err := s.Store.History(ctx, tenantID, module, id)
	if err != nil {
		return nil, err
	}
	out := make([]RecordVersion, len(versions))
	var previous *domain.Object
	for i, v := range versions {
		out[i] = RecordVersion{
			Version: i + 1, Operation: v.Operation, Actor: v.Actor, At: v.At, Payload: v.Payload,
			Changes: domain.DiffPayloads(previous, v.Payload),
		}
		previous = v.Payload
	}
	slices.Reverse(out)
	return out, nil
}

// SummaryCount is one hub type's total.
type SummaryCount struct {
	Slug  string
	Count int64
}

// SummaryRow is one row of Registros «Todos».
type SummaryRow struct {
	domain.RecordSummary
	UpdatedAt time.Time
}

// SummaryPage is RecordsSummaryPage.
type SummaryPage struct {
	Counts []SummaryCount
	Rows   []SummaryRow
}

// Summary is createRecordsSummary: the shared columns of every hub type plus their totals.
func (s Service) Summary(ctx context.Context, tenantID string, page Page) (SummaryPage, error) {
	rows, counts, err := s.Store.Summary(ctx, tenantID, domain.SummaryModules(), bound(page))
	if err != nil {
		return SummaryPage{}, err
	}
	out := SummaryPage{Counts: make([]SummaryCount, len(domain.SummaryTypes)), Rows: make([]SummaryRow, 0, len(rows))}
	byModule := make(map[string]domain.SummaryType, len(domain.SummaryTypes))
	for i, t := range domain.SummaryTypes {
		out.Counts[i] = SummaryCount{Slug: t.Slug, Count: counts[t.Module]}
		byModule[t.Module] = t
	}
	for _, row := range rows {
		if t, ok := byModule[row.Module]; ok {
			out.Rows = append(out.Rows, SummaryRow{domain.Summarize(t, row.ID, row.Payload), row.UpdatedAt})
		}
	}
	return out, nil
}
