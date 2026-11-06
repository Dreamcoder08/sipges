package infrastructure

import (
	"context"
	"errors"

	"github.com/jackc/pgx/v5"

	"github.com/Dreamcoder08/sipges/apps/api-go/internal/analyst/application"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/analyst/domain"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/platform/database"
)

// auditModule is the audit module of proposal decisions; automation rules may react to it.
const auditModule = "Analista"

const insertDecision = `INSERT INTO proposal_decisions
    (tenant_id, fingerprint, subject_module, subject_id, kind, decision, result, decided_by, decided_at)
  VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
  ON CONFLICT DO NOTHING RETURNING 1`

const insertDecisionAudit = `INSERT INTO audit (tenant_id, ts, module, record_id, action, detail)
  VALUES (current_setting('app.tenant_id', true), $1, $2, $3, $4, $5)`

// Decisions is sql-proposal-store.ts: the decision and its audit row in one tenant transaction.
type Decisions struct {
	DB database.Beginner
}

// Save implements application.DecisionStore.
func (s Decisions) Save(ctx context.Context, tenantID string, d application.ProposalDecision) (bool, error) {
	return database.WithTenant(ctx, s.DB, tenantID, func(ctx context.Context, q database.Querier) (bool, error) {
		var inserted int
		err := q.QueryRow(ctx, insertDecision, tenantID, d.Fingerprint, d.SubjectSlug, d.SubjectID, d.Kind,
			d.Decision, d.Result, d.Actor, d.At).Scan(&inserted)
		if errors.Is(err, pgx.ErrNoRows) {
			return false, nil
		}
		if err != nil {
			return false, err
		}
		detail := domain.DecisionDetail(d.Decision == "approved", d.Title, d.Result)
		_, err = q.Exec(ctx, insertDecisionAudit, d.At, auditModule, d.SubjectID, "REVIEW", detail)
		return err == nil, err
	})
}
