package application

import (
	"context"

	records "github.com/Dreamcoder08/sipges/apps/api-go/internal/records/domain"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/tenancy/domain"
)

// ExportReader is TenantDataReader.read: the project's business tables, by table name.
type ExportReader func(ctx context.Context, s domain.Scope) (*records.Object, error)

// ExportData is exportData of tenancy-service.ts: an administrator's versioned dump of the
// project, or ErrForbidden. The grant is read fresh, never from the request cache, so a grant
// revoked a moment ago stops the export even while the request cache still holds it.
func (a Admin) ExportData(ctx context.Context, actor Actor, s domain.Scope) (*records.Object, string, error) {
	if actor.Role != "admin" {
		return nil, ErrForbidden, nil
	}
	granted, err := a.IsGranted(ctx, actor.Username, s.TenantID())
	if err != nil {
		return nil, "", err
	}
	if !granted {
		return nil, ErrForbidden, nil
	}
	data, err := a.Export(ctx, s)
	if err != nil {
		return nil, "", err
	}
	scope := records.NewObject()
	scope.Set("company_id", s.CompanyID)
	scope.Set("project_id", s.ProjectID)
	out := records.NewObject()
	out.Set("format", "sipges.tenant-export")
	out.Set("version", float64(1))
	out.Set("scope", scope)
	out.Set("exported_at", a.now().UTC().Format("2006-01-02T15:04:05")+"Z")
	out.Set("data", data)
	return out, "", nil
}
