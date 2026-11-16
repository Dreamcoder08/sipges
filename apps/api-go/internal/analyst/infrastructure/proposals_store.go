package infrastructure

import (
	"context"
	"encoding/json"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/Dreamcoder08/sipges/apps/api-go/internal/analyst/application"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/analyst/domain"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/platform/database"
)

// Proposals stores the Inicio analyst's proposals in analyst_proposals (migration 0033), one
// tenant transaction per call, so row-level security keeps every project's proposals apart. The
// table is insert-only: a proposal is pending while proposal_decisions holds no row for it.
type Proposals struct {
	DB database.Beginner
}

// undecided is the condition of a pending proposal.
const undecided = `NOT EXISTS (SELECT 1 FROM proposal_decisions d
    WHERE d.tenant_id = p.tenant_id AND d.fingerprint = 'stored:' || p.id)`

const (
	countPending   = `SELECT count(*) FROM analyst_proposals p WHERE p.tenant_id = $1 AND ` + undecided
	insertProposal = `INSERT INTO analyst_proposals
    (tenant_id, id, kind, target_module, title, reason, proposal, proposed_by, proposed_at)
  VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`
	selectPending = `SELECT id, kind, title, reason, proposal, proposed_by, proposed_at
  FROM analyst_proposals p WHERE p.tenant_id = $1 AND ` + undecided
	// listLimit bounds the list even if concurrent proposals passed the pending limit together.
	listLimit = 2 * domain.MaxPendingProposals
)

type endJSON struct {
	Module string `json:"module"`
	ID     string `json:"id"`
}

// storedJSON is the proposal column: the record's fields as [key, value] pairs keep their order.
type storedJSON struct {
	Record *struct {
		Module string      `json:"module"`
		Fields [][2]string `json:"fields"`
	} `json:"record,omitempty"`
	Link *struct {
		LinkType string  `json:"link_type"`
		Source   endJSON `json:"source"`
		Target   endJSON `json:"target"`
	} `json:"link,omitempty"`
}

func encode(p domain.Proposal) (kind, module string, raw []byte, err error) {
	var out storedJSON
	switch {
	case p.Record != nil:
		out.Record = &struct {
			Module string      `json:"module"`
			Fields [][2]string `json:"fields"`
		}{Module: p.Record.Slug, Fields: make([][2]string, 0, len(p.Record.Payload))}
		for _, f := range p.Record.Payload {
			value, ok := f.Value.(string)
			if !ok {
				return "", "", nil, errors.New("analyst: proposed values are text")
			}
			out.Record.Fields = append(out.Record.Fields, [2]string{f.Key, value})
		}
		kind, module = "record", p.Record.Slug
	case p.Link != nil:
		out.Link = &struct {
			LinkType string  `json:"link_type"`
			Source   endJSON `json:"source"`
			Target   endJSON `json:"target"`
		}{p.Link.LinkType, endJSON{p.Link.Source.Slug, p.Link.Source.ID}, endJSON{p.Link.Target.Slug, p.Link.Target.ID}}
		kind, module = "link", p.Link.Source.Slug
	default:
		return "", "", nil, errors.New("analyst: empty proposal")
	}
	raw, err = json.Marshal(out)
	return kind, module, raw, err
}

func decode(id, kind, title, reason string, raw []byte) (domain.Proposal, error) {
	var in storedJSON
	if err := json.Unmarshal(raw, &in); err != nil {
		return domain.Proposal{}, err
	}
	p := domain.Proposal{Fingerprint: domain.StoredFingerprint(id), Kind: kind, Title: title, Reason: reason}
	switch {
	case kind == "record" && in.Record != nil:
		fields := make([]domain.Field, 0, len(in.Record.Fields))
		for _, f := range in.Record.Fields {
			fields = append(fields, domain.Field{Key: f[0], Value: f[1]})
		}
		p.Record = &domain.ProposedRecord{Slug: in.Record.Module, Payload: fields}
	case kind == "link" && in.Link != nil:
		p.Link = &domain.ProposedLink{
			LinkType: in.Link.LinkType,
			Source:   domain.Ref{Slug: in.Link.Source.Module, ID: in.Link.Source.ID},
			Target:   domain.Ref{Slug: in.Link.Target.Module, ID: in.Link.Target.ID},
		}
	default:
		return domain.Proposal{}, errors.New("analyst: unreadable stored proposal")
	}
	return p, nil
}

// Add implements application.ProposalStore.
func (s Proposals) Add(ctx context.Context, tenantID string, p application.StoredProposal, limit int) (bool, error) {
	kind, module, raw, err := encode(p.Proposal)
	if err != nil {
		return false, err
	}
	return database.WithTenant(ctx, s.DB, tenantID, func(ctx context.Context, q database.Querier) (bool, error) {
		var pending int
		if err := q.QueryRow(ctx, countPending, tenantID).Scan(&pending); err != nil {
			return false, err
		}
		if pending >= limit {
			return false, nil
		}
		_, err := q.Exec(ctx, insertProposal, tenantID, p.ID, kind, module, p.Proposal.Title, p.Proposal.Reason,
			raw, p.ProposedBy, p.ProposedAt)
		return err == nil, err
	})
}

func (s Proposals) read(ctx context.Context, tenantID, extra string, args ...any) ([]application.StoredProposal, error) {
	return database.WithTenant(ctx, s.DB, tenantID, func(ctx context.Context, q database.Querier) ([]application.StoredProposal, error) {
		rows, err := q.Query(ctx, selectPending+extra, append([]any{tenantID}, args...)...)
		if err != nil {
			return nil, err
		}
		out, err := pgx.CollectRows(rows, func(row pgx.CollectableRow) (application.StoredProposal, error) {
			var id, kind, title, reason, by string
			var raw []byte
			var at time.Time
			if err := row.Scan(&id, &kind, &title, &reason, &raw, &by, &at); err != nil {
				return application.StoredProposal{}, err
			}
			p, err := decode(id, kind, title, reason, raw)
			return application.StoredProposal{ID: id, Proposal: p, ProposedBy: by, ProposedAt: at}, err
		})
		if out == nil {
			out = []application.StoredProposal{}
		}
		return out, err
	})
}

// Pending implements application.ProposalStore.
func (s Proposals) Pending(ctx context.Context, tenantID string) ([]application.StoredProposal, error) {
	return s.read(ctx, tenantID, ` ORDER BY p.proposed_at, p.id LIMIT $2`, listLimit)
}

// Find implements application.ProposalStore.
func (s Proposals) Find(ctx context.Context, tenantID, id string) (application.StoredProposal, bool, error) {
	found, err := s.read(ctx, tenantID, ` AND p.id = $2`, id)
	if err != nil || len(found) == 0 {
		return application.StoredProposal{}, false, err
	}
	return found[0], true, nil
}
