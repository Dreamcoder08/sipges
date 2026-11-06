// Package application is the metadata read side of
// apps/api/src/contexts/evidence/application/evidence-service.ts: the attachment list and one
// attachment. Uploads, previews and downloads, which need the object storage, are alongside.
package application

import (
	"context"
	"strings"
	"unicode/utf16"

	"golang.org/x/text/cases"
	"golang.org/x/text/language"

	"github.com/Dreamcoder08/sipges/apps/api-go/internal/evidence/domain"
)

// MaxListLimit is MAX_LIST_LIMIT.
const MaxListLimit = 500

// maxIDLength bounds an id before it reaches the database, as `id.length <= 64`.
const maxIDLength = 64

// ListQuery is the list request as read from the query string; nil means the parameter is absent.
type ListQuery struct {
	LinkedModule   *string
	LinkedRecordID *string
	Q              *string
	Limit          int64
}

// Filter is the normalized query the store runs; nil means no condition.
type Filter struct {
	LinkedModule   *string
	LinkedRecordID *string
	Q              *string
	Limit          int64
}

// Store reads attachment metadata inside the request's tenant transaction, where row-level
// security hides other tenants' rows and attachments of records the clearance cannot see.
type Store interface {
	List(ctx context.Context, f Filter) ([]domain.Attachment, error)
	// Get returns nil when no visible attachment has that id.
	Get(ctx context.Context, id string) (*domain.Attachment, error)
}

// Service answers the evidence metadata reads.
type Service struct {
	Store Store
}

// List is evidence.list: a value PostgreSQL text cannot hold (NUL) matches nothing; the module
// is trimmed and lower-cased; empty values mean no condition; the limit is clamped to 1..500.
func (s Service) List(ctx context.Context, q ListQuery) ([]domain.Attachment, error) {
	f, ok := NewFilter(q)
	if !ok {
		return []domain.Attachment{}, nil
	}
	return s.Store.List(ctx, f)
}

// NewFilter normalizes q; false when it can match no stored row.
func NewFilter(q ListQuery) (Filter, bool) {
	if !storable(q.LinkedModule) || !storable(q.LinkedRecordID) || !storable(q.Q) {
		return Filter{}, false
	}
	f := Filter{Limit: max(1, min(q.Limit, MaxListLimit))}
	if q.LinkedModule != nil {
		f.LinkedModule = nonEmpty(lower.String(strings.TrimFunc(*q.LinkedModule, isJSSpace)))
	}
	if q.LinkedRecordID != nil {
		f.LinkedRecordID = nonEmpty(*q.LinkedRecordID)
	}
	if q.Q != nil {
		f.Q = nonEmpty(*q.Q)
	}
	return f, true
}

// Get is evidence.get: an id with NUL or over 64 UTF-16 units is never looked up.
func (s Service) Get(ctx context.Context, id string) (*domain.Attachment, error) {
	if !ValidID(id) {
		return nil, nil
	}
	return s.Store.Get(ctx, id)
}

// ValidID is `storable(id) && id.length <= 64`.
func ValidID(id string) bool {
	return !strings.ContainsRune(id, 0) && len(utf16.Encode([]rune(id))) <= maxIDLength
}

func storable(v *string) bool { return v == nil || !strings.ContainsRune(*v, 0) }

func nonEmpty(s string) *string {
	if s == "" {
		return nil
	}
	return &s
}

var lower = cases.Lower(language.Und)

// isJSSpace is JavaScript's String.prototype.trim set: WhiteSpace and LineTerminator.
func isJSSpace(r rune) bool {
	switch r {
	case '\t', '\n', '\v', '\f', '\r', ' ', 0xa0, 0x1680, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000, 0xfeff:
		return true
	}
	return r >= 0x2000 && r <= 0x200a
}
