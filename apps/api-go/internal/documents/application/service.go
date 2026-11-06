// Package application is the read side of
// apps/api/src/contexts/documents/application/document-lab-service.ts: one page of the
// verification inbox, each item with the records module its approval writes to and, once that
// record exists, a link to it. Reading, comparing and reporting on uploaded documents, importing
// excerpts and deciding items are alongside; PDF text alone stays in TypeScript.
package application

import (
	"context"

	"github.com/Dreamcoder08/sipges/apps/api-go/internal/documents/domain"
	tenancy "github.com/Dreamcoder08/sipges/apps/api-go/internal/tenancy/domain"
)

// ReviewQuery selects one page of a project's findings; nil Status or Theme means any.
type ReviewQuery struct {
	ProjectID string
	Status    *string
	Theme     *string
	Limit     int64
	Offset    int64
}

// ReviewPage is the store's page: the items, the rows matching every filter, and the count of
// rows per theme matching project and status only (themes in the store's order).
type ReviewPage struct {
	Items  []domain.ReviewItem
	Total  int64
	Themes domain.ThemeCounts
}

// ReviewStore reads the inbox and the records' existence inside one tenant.
type ReviewStore interface {
	List(ctx context.Context, tenantID string, q ReviewQuery) (ReviewPage, error)
	// ExistingRecords returns which of ids exist in the stored records module.
	ExistingRecords(ctx context.Context, tenantID, module string, ids []string) (map[string]bool, error)
}

// RecordLink names an approved item's record.
type RecordLink struct {
	Module string `json:"module"`
	ID     string `json:"id"`
}

// ReviewListItem is ReviewListItem: an item with its target and, when it exists, its record.
type ReviewListItem struct {
	domain.ReviewItem
	Target domain.ReviewTarget
	Record *RecordLink
}

// ReviewList is the page the route answers with.
type ReviewList struct {
	Items  []ReviewListItem
	Total  int64
	Themes domain.ThemeCounts
}

// Service answers the document lab's read route.
type Service struct {
	Store ReviewStore
}

// ListReview is listReview for the scope's tenant. status and theme are the query values as
// sent (nil when absent); the empty string means any, and text with NUL matches nothing.
func (s Service) ListReview(ctx context.Context, scope tenancy.Scope, status, theme *string, limit, offset int64) (ReviewList, error) {
	for _, text := range []*string{&scope.ProjectID, status, theme} {
		if text != nil && domain.HasNul(*text) {
			return ReviewList{Items: []ReviewListItem{}}, nil
		}
	}
	tenantID := scope.TenantID()
	page, err := s.Store.List(ctx, tenantID, ReviewQuery{
		ProjectID: scope.ProjectID, Status: orAny(status), Theme: orAny(theme), Limit: limit, Offset: offset,
	})
	if err != nil {
		return ReviewList{}, err
	}

	// Link only records that exist: items approved before their record was written wait for
	// the backfill (review:materialize).
	wanted := map[string][]string{}
	var modules []string
	for _, item := range page.Items {
		if !domain.IsApproval(item.Status) {
			continue
		}
		slug := domain.ReviewTargetFor(item.Theme).Module
		if _, seen := wanted[slug]; !seen {
			modules = append(modules, slug)
		}
		wanted[slug] = append(wanted[slug], domain.ReviewRecordID(item.ID))
	}
	found := map[string]map[string]bool{}
	for _, slug := range modules {
		module, ok := domain.RecordModule(slug)
		if !ok {
			continue
		}
		var ids []string
		for _, id := range wanted[slug] {
			if domain.IsLookupableID(id) {
				ids = append(ids, id)
			}
		}
		if len(ids) == 0 {
			continue
		}
		existing, err := s.Store.ExistingRecords(ctx, tenantID, module, ids)
		if err != nil {
			return ReviewList{}, err
		}
		found[slug] = existing
	}

	out := ReviewList{Items: make([]ReviewListItem, 0, len(page.Items)), Total: page.Total, Themes: page.Themes}
	for _, item := range page.Items {
		target := domain.ReviewTargetFor(item.Theme)
		listed := ReviewListItem{ReviewItem: item, Target: target}
		if id := domain.ReviewRecordID(item.ID); found[target.Module][id] {
			listed.Record = &RecordLink{Module: target.Module, ID: id}
		}
		out.Items = append(out.Items, listed)
	}
	return out, nil
}

// orAny is `value || null`.
func orAny(value *string) *string {
	if value == nil || *value == "" {
		return nil
	}
	return value
}
