// Package application is the Go port of apps/api/src/contexts/audit/application/index.ts: the
// tenant audit trail as the read routes see it.
package application

import "time"

// Record is one audit entry (AuditRecord).
type Record struct {
	ID       int64
	At       time.Time
	Module   string
	RecordID *string
	Action   string
	Detail   *string
}

// MaxAuditLimit is the absolute ceiling for audit pages (docs/adr/0008 #10).
const MaxAuditLimit = 500

// LatestLimit is the page size createAuditService.latest reads: a negative limit means the
// ceiling, any other is capped at it.
func LatestLimit(limit int64) int {
	if limit < 0 || limit > MaxAuditLimit {
		return MaxAuditLimit
	}
	return int(limit)
}

// AfterLimit is the page size createAuditService.after reads: capped at the ceiling.
func AfterLimit(limit int) int { return min(limit, MaxAuditLimit) }
