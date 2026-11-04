// Package infrastructure reads records, links, inferred links and proposal decisions from
// PostgreSQL with the queries of apps/api/src/contexts/ontology/infrastructure/sql-ontology-store.ts
// (nodes, recent, links, inferred) and apps/api/src/contexts/analyst/infrastructure/sql-proposal-store.ts
// (decided), inside the request's tenant transaction (docs/adr/0003), so row-level security hides
// other projects and, from a read-only clearance, records marked 'restringido'.
package infrastructure

import (
	"context"

	"github.com/jackc/pgx/v5"

	"github.com/Dreamcoder08/sipges/apps/api-go/internal/analyst/application"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/analyst/domain"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/platform/database"
)

// inRefs is `(module, id) IN refs` over two parallel text arrays.
func inRefs(moduleColumn, idColumn, first, second string) string {
	return "(" + moduleColumn + ", " + idColumn + ") IN (SELECT * FROM unnest(" + first + "::text[], " + second + "::text[]))"
}

// The payload is read as jsonb's text so its key order is the one JSON.parse sees.
var (
	nodesQuery = `SELECT module, id, payload::text, marking FROM module_records WHERE ` + inRefs("module", "id", "$1", "$2")

	recentQuery = `SELECT module, id, payload::text, marking FROM module_records
           WHERE module = ANY($1::text[]) ORDER BY updated_at DESC, id LIMIT $2`

	linksQuery = `SELECT link_type, source_module, source_id, target_module, target_id
           FROM record_links
           WHERE ` + inRefs("source_module", "source_id", "$1", "$2") + ` OR ` + inRefs("target_module", "target_id", "$1", "$2") + `
           ORDER BY id`

	inferredQuery = `WITH rules (rule, holder, field, target, match, title_field) AS (
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
               WHERE ` + inRefs("h.module", "h.id", "$7", "$8") + ` OR ` + inRefs("t.module", "t.id", "$7", "$8") + `
               ORDER BY rules.rule, h.module, h.id, t.id`

	decidedQuery = `SELECT fingerprint FROM proposal_decisions WHERE fingerprint = ANY($1::text[])`
)

// rules is RULES of ontology-service.ts: the inference rules with stored module names.
var rules = func() (r struct {
	index                                  []int32
	holder, field, target, match, titleOfT []string
}) {
	for i, rule := range domain.InferenceRules {
		holder, hok := domain.ObjectTypeForSlug(rule.Holder)
		target, tok := domain.ObjectTypeForSlug(rule.Target)
		if !hok || !tok {
			continue
		}
		match := "id"
		if rule.MatchTitle {
			match = "title"
		}
		r.index = append(r.index, int32(i))
		r.holder = append(r.holder, holder.Module)
		r.field = append(r.field, rule.Field)
		r.target = append(r.target, target.Module)
		r.match = append(r.match, match)
		r.titleOfT = append(r.titleOfT, target.TitleField)
	}
	return r
}()

// Reader is the analyst's reader over one tenant transaction.
type Reader struct {
	Q database.Querier
}

var _ application.Reader = Reader{}

func columns(refs []application.NodeRef) ([]string, []string) {
	modules, ids := make([]string, len(refs)), make([]string, len(refs))
	for i, r := range refs {
		modules[i], ids[i] = r.Module, r.ID
	}
	return modules, ids
}

func (r Reader) rows(ctx context.Context, query string, args ...any) ([]application.NodeRow, error) {
	rows, err := r.Q.Query(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, func(row pgx.CollectableRow) (application.NodeRow, error) {
		var (
			n       application.NodeRow
			payload string
		)
		if err := row.Scan(&n.Module, &n.ID, &payload, &n.Marking); err != nil {
			return n, err
		}
		parsed, err := domain.ParsePayload([]byte(payload))
		n.Payload = parsed
		return n, err
	})
}

// Nodes reads the visible records of refs.
func (r Reader) Nodes(ctx context.Context, refs []application.NodeRef) ([]application.NodeRow, error) {
	modules, ids := columns(refs)
	return r.rows(ctx, nodesQuery, modules, ids)
}

// Recent reads the most recently updated records of modules.
func (r Reader) Recent(ctx context.Context, modules []string, limit int) ([]application.NodeRow, error) {
	return r.rows(ctx, recentQuery, modules, limit)
}

// Links reads the explicit links touching refs.
func (r Reader) Links(ctx context.Context, refs []application.NodeRef) ([]application.StoredLink, error) {
	modules, ids := columns(refs)
	rows, err := r.Q.Query(ctx, linksQuery, modules, ids)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, func(row pgx.CollectableRow) (application.StoredLink, error) {
		var l application.StoredLink
		err := row.Scan(&l.LinkType, &l.Source.Module, &l.Source.ID, &l.Target.Module, &l.Target.ID)
		return l, err
	})
}

// Inferred reads the inferred matches touching refs.
func (r Reader) Inferred(ctx context.Context, refs []application.NodeRef) ([]application.InferredMatch, error) {
	if len(refs) == 0 || len(rules.index) == 0 {
		return nil, nil
	}
	modules, ids := columns(refs)
	rows, err := r.Q.Query(ctx, inferredQuery, rules.index, rules.holder, rules.field, rules.target, rules.match, rules.titleOfT, modules, ids)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, func(row pgx.CollectableRow) (application.InferredMatch, error) {
		var (
			m    application.InferredMatch
			rule int32
		)
		err := row.Scan(&rule, &m.Holder.Module, &m.Holder.ID, &m.Target.Module, &m.Target.ID)
		m.Rule = int(rule)
		return m, err
	})
}

// Decided reads the fingerprints already decided.
func (r Reader) Decided(ctx context.Context, fingerprints []string) (map[string]bool, error) {
	out := map[string]bool{}
	if len(fingerprints) == 0 {
		return out, nil
	}
	rows, err := r.Q.Query(ctx, decidedQuery, fingerprints)
	if err != nil {
		return nil, err
	}
	found, err := pgx.CollectRows(rows, pgx.RowTo[string])
	for _, f := range found {
		out[f] = true
	}
	return out, err
}
