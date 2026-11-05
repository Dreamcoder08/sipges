// Package infrastructure reads records and links from PostgreSQL with the queries of
// apps/api/src/contexts/ontology/infrastructure/sql-ontology-store.ts, inside the request's
// tenant transaction (docs/adr/0003): row-level security hides other tenants' rows and, for a
// read-only account, records marked 'restringido'.
package infrastructure

import (
	"context"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/Dreamcoder08/sipges/apps/api-go/internal/ontology/application"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/ontology/domain"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/platform/database"
)

// inRefs is `(module, id) IN refs` over two parallel text arrays at $first, $first + 1.
func inRefs(moduleColumn, idColumn string, first int) string {
	return fmt.Sprintf("(%s, %s) IN (SELECT * FROM unnest($%d::text[], $%d::text[]))", moduleColumn, idColumn, first, first+1)
}

func columns(refs []application.NodeRef) (modules, ids []string) {
	modules, ids = make([]string, len(refs)), make([]string, len(refs))
	for i, r := range refs {
		modules[i], ids[i] = r.Module, r.ID
	}
	return modules, ids
}

var (
	nodesSQL = `SELECT module, id, payload, marking, updated_at FROM module_records WHERE ` + inRefs("module", "id", 1) + ` ORDER BY module, id`

	searchSQL = `SELECT module, id, payload, marking, updated_at
           FROM module_records,
                to_tsquery('pg_catalog.simple'::regconfig, COALESCE($1, '')) AS query
           WHERE module = ANY($3::text[])
             AND (lower(id) = lower($2) OR ($1 IS NOT NULL AND record_search_document(id, payload) @@ query))
           ORDER BY lower(id) = lower($2) DESC,
                    ts_rank(record_search_document(id, payload), query) DESC, updated_at DESC, id
           LIMIT $4`

	datedSQL = `SELECT r.module, r.id, r.payload, r.marking, r.updated_at, d.day
           FROM module_records r
           JOIN unnest($1::text[], $2::text[]) AS f(module, field) ON f.module = r.module
           CROSS JOIN LATERAL (SELECT left(r.payload->>f.field, 10) AS day) d
           WHERE d.day ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' AND d.day >= $3 AND d.day <= $4
           ORDER BY d.day DESC, r.module, r.id
           LIMIT $5`

	linksSQL = `SELECT id, link_type, source_module, source_id, target_module, target_id, note,
                  created_by, created_at, evidence_source_id
           FROM record_links
           WHERE ` + inRefs("source_module", "source_id", 1) + ` OR ` + inRefs("target_module", "target_id", 1) + `
           ORDER BY id`

	inferredSQL = `WITH rules (rule, holder, field, target, match, title_field) AS (
                 SELECT * FROM unnest($1::int[], $2::text[], $3::text[], $4::text[], $5::text[], $6::text[])
               )
               SELECT rules.rule, h.module AS holder_module, h.id AS holder_id,
                      t.module AS target_module, t.id AS target_id
               FROM rules
               JOIN module_records h
                 ON h.module = rules.holder AND COALESCE(btrim(h.payload ->> rules.field), '') <> ''
               JOIN module_records t
                 ON t.module = rules.target
                AND (h.module, h.id) <> (t.module, t.id)
                AND CASE rules.match
                      WHEN 'id' THEN t.id = btrim(h.payload ->> rules.field)
                      ELSE lower(btrim(t.payload ->> rules.title_field)) = lower(btrim(h.payload ->> rules.field))
                    END
               WHERE ` + inRefs("h.module", "h.id", 7) + ` OR ` + inRefs("t.module", "t.id", 7) + `
               ORDER BY rules.rule, h.module, h.id, t.id`
)

// Store is the read side of the SQL ontology store over one tenant transaction.
type Store struct {
	Q database.Querier
}

var _ application.Store = Store{}

func scanNode(row pgx.CollectableRow) (application.NodeRow, error) {
	var (
		n       application.NodeRow
		payload []byte
		updated time.Time
	)
	if err := row.Scan(&n.Module, &n.ID, &payload, &n.Marking, &updated); err != nil {
		return n, err
	}
	p, err := domain.DecodePayload(payload)
	n.Payload = p
	return n, err
}

func (s Store) nodes(ctx context.Context, sql string, args ...any) ([]application.NodeRow, error) {
	rows, err := s.Q.Query(ctx, sql, args...)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, scanNode)
}

// Nodes returns the visible records among refs (in the database's order, as TypeScript).
func (s Store) Nodes(ctx context.Context, refs []application.NodeRef) ([]application.NodeRow, error) {
	modules, ids := columns(refs)
	return s.nodes(ctx, nodesSQL, modules, ids)
}

// Search returns records of modules whose id equals exactID or that match the prefix tsquery.
func (s Store) Search(ctx context.Context, query *string, exactID string, modules []string, limit int) ([]application.NodeRow, error) {
	return s.nodes(ctx, searchSQL, query, exactID, modules, limit)
}

// Dated returns the records whose date field falls in [from, to], newest first, with that day.
func (s Store) Dated(ctx context.Context, fields []application.DateField, from, to string, limit int) ([]application.DatedRow, error) {
	modules, names := make([]string, len(fields)), make([]string, len(fields))
	for i, f := range fields {
		modules[i], names[i] = f.Module, f.Field
	}
	rows, err := s.Q.Query(ctx, datedSQL, modules, names, from, to, limit)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, func(row pgx.CollectableRow) (application.DatedRow, error) {
		var (
			d       application.DatedRow
			payload []byte
			updated time.Time
		)
		if err := row.Scan(&d.Module, &d.ID, &payload, &d.Marking, &updated, &d.Day); err != nil {
			return d, err
		}
		p, err := domain.DecodePayload(payload)
		d.Payload = p
		return d, err
	})
}

// Links returns the explicit links with either end in refs, by id.
func (s Store) Links(ctx context.Context, refs []application.NodeRef) ([]application.StoredLink, error) {
	modules, ids := columns(refs)
	rows, err := s.Q.Query(ctx, linksSQL, modules, ids)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, func(row pgx.CollectableRow) (application.StoredLink, error) {
		var (
			l  application.StoredLink
			id int32
		)
		err := row.Scan(&id, &l.LinkType, &l.Source.Module, &l.Source.ID, &l.Target.Module, &l.Target.ID,
			&l.Note, &l.CreatedBy, &l.CreatedAt, &l.EvidenceSourceID)
		l.ID = int64(id)
		return l, err
	})
}

// Inferred returns the inferred matches with either end in refs.
func (s Store) Inferred(ctx context.Context, refs []application.NodeRef, rules []application.ResolvedRule) ([]application.InferredMatch, error) {
	if len(rules) == 0 || len(refs) == 0 {
		return []application.InferredMatch{}, nil
	}
	index := make([]int32, len(rules))
	holders, fields, targets, matches, titles := make([]string, len(rules)), make([]string, len(rules)),
		make([]string, len(rules)), make([]string, len(rules)), make([]string, len(rules))
	for i, r := range rules {
		index[i] = int32(r.Index) //nolint:gosec // rule indexes are small
		holders[i], fields[i], targets[i], matches[i], titles[i] = r.HolderModule, r.Field, r.TargetModule, r.Match, r.TargetTitleField
	}
	modules, ids := columns(refs)
	rows, err := s.Q.Query(ctx, inferredSQL, index, holders, fields, targets, matches, titles, modules, ids)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, func(row pgx.CollectableRow) (application.InferredMatch, error) {
		var (
			m    application.InferredMatch
			rule int32
		)
		err := row.Scan(&rule, &m.Holder.Module, &m.Holder.ID, &m.Target.Module, &m.Target.ID)
		m.Index = int(rule)
		return m, err
	})
}
