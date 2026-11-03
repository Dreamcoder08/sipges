// Package application is the Go port of
// apps/api/src/contexts/management/application/management-service.ts.
package application

import (
	"time"

	"github.com/Dreamcoder08/sipges/apps/api-go/internal/management/domain"
)

// Snapshot is what the read model returns for one project (ports.ts `ManagementSources`):
// alerts newest first, actions by due date ascending, `Compromisos` records newest first.
type Snapshot struct {
	Alerts  []domain.AlertRow
	Actions []domain.ActionRow
	Records []domain.Record
}

// GeneratedAt is `${now.toISOString().slice(0, 19)}Z`.
func GeneratedAt(now time.Time) string {
	return now.UTC().Format("2006-01-02T15:04:05") + "Z"
}

// Overview is the service's `overview` once the sources are read.
func Overview(projectID string, now time.Time, s Snapshot) domain.Overview {
	return domain.ManagementOverview(domain.Input{
		ProjectID:   projectID,
		GeneratedAt: GeneratedAt(now),
		Today:       domain.LimaToday(now),
		Alerts:      s.Alerts,
		Actions:     s.Actions,
		Commitments: domain.CommitmentsOf(s.Records),
	})
}

// CSV is the service's `csv`.
func CSV(projectID string, now time.Time, s Snapshot) string {
	return domain.ManagementCSV(Overview(projectID, now, s))
}
