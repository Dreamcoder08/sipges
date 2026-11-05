package infrastructure

import (
	"context"

	"github.com/jackc/pgx/v5"

	"github.com/Dreamcoder08/sipges/apps/api-go/internal/platform/database"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/privacy/domain"
	situations "github.com/Dreamcoder08/sipges/apps/api-go/internal/situations/domain"
)

// maxNames bounds the names scanned per project; a project holds far fewer.
const maxNames = 20_000

const namesSQL = `SELECT DISTINCT s.field, btrim(r.payload ->> s.field) AS value
               FROM module_records r
               CROSS JOIN unnest($1::text[]) AS s(field)
              WHERE r.tenant_id = $2 AND btrim(coalesce(r.payload ->> s.field, '')) <> ''
              LIMIT $3`

// NameDirectory reads the values of every person and organisation field of the project
// (NameSources, in every module, lists split into people) so free text can be scrubbed of them. It
// reads with full clearance on purpose: a restricted record's name must be replaced too, and it
// only ever feeds the scrubber, never an output.
type NameDirectory struct {
	DB database.Beginner
}

type nameRow struct {
	field, value string
}

// Load reads the project's known names.
func (d NameDirectory) Load(ctx context.Context, tenantID string) ([]domain.KnownName, error) {
	fields := make([]string, 0, len(domain.NameSources))
	for _, source := range domain.NameSources {
		fields = append(fields, source.Field)
	}
	actor, _ := database.ActorFrom(ctx)
	actor.Clearance = database.ClearanceFull
	rows, err := database.WithTenant(database.WithActor(ctx, actor), d.DB, tenantID,
		func(ctx context.Context, q database.Querier) ([]nameRow, error) {
			rows, err := q.Query(ctx, namesSQL, fields, tenantID, maxNames)
			if err != nil {
				return nil, err
			}
			return pgx.CollectRows(rows, func(row pgx.CollectableRow) (nameRow, error) {
				var r nameRow
				err := row.Scan(&r.field, &r.value)
				return r, err
			})
		})
	if err != nil {
		return nil, err
	}
	sources := make(map[string]domain.NameSource, len(domain.NameSources))
	for _, source := range domain.NameSources {
		sources[source.Field] = source
	}
	names := []domain.KnownName{}
	for _, row := range rows {
		source := sources[row.field]
		people := []string{row.value}
		if source.List {
			people = domain.SplitList(row.value)
		}
		for _, name := range people {
			if name = situations.TrimJS(name); name != "" {
				names = append(names, domain.KnownName{Kind: source.Entity, Name: name})
			}
		}
	}
	return names, nil
}
