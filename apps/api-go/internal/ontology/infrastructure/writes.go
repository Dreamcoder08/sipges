package infrastructure

import (
	"context"
	"errors"
	"strconv"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/Dreamcoder08/sipges/apps/api-go/internal/ontology/application"
)

// The write queries of sql-ontology-store.ts (createLink, setLinkEvidence, setMarking,
// deleteLink), statement for statement, in the request's tenant transaction: every row they
// read or lock passes row-level security first, and each change appends its audit row (and, for
// evidence, its private provenance row) in the same transaction, so both commit or neither.

// auditModule is AUDIT_MODULE: the audit module of link changes.
const auditModule = "Vinculos"

var (
	_ application.Writer = Store{}

	presentSQL  = `SELECT id FROM module_records WHERE ` + inRefs("module", "id", 1) + ` FOR SHARE`
	sourceSQL   = `SELECT id FROM module_records WHERE module = 'Fuentes' AND id = $1 FOR SHARE`
	reversedSQL = `SELECT 1 FROM record_links WHERE link_type = $1 AND source_module = $2
             AND source_id = $3 AND target_module = $4 AND target_id = $5`
	insertLinkSQL = `INSERT INTO record_links (tenant_id, link_type, source_module, source_id, target_module,
                                   target_id, note, created_by, created_at, evidence_source_id)
         VALUES (current_setting('app.tenant_id', true), $1, $2, $3, $4, $5, $6, $7, $8, $9)
         ON CONFLICT DO NOTHING RETURNING id`
	evidenceHistorySQL = `INSERT INTO link_evidence_history (tenant_id, link_id, previous_source_id, next_source_id, actor, at)
     VALUES (current_setting('app.tenant_id', true), $1, $2, $3,
       COALESCE(NULLIF(current_setting('app.actor', true), ''), 'sistema'), $4)`
	auditSQL = `INSERT INTO audit (tenant_id, ts, module, record_id, action, detail)
     VALUES (current_setting('app.tenant_id', true), $1, $2, $3, $4, $5)`
	lockLinkSQL = `SELECT source_module, source_id, target_module, target_id, evidence_source_id
           FROM record_links WHERE id = $1 FOR UPDATE`
	setEvidenceSQL = `UPDATE record_links SET evidence_source_id = $2 WHERE id = $1`
	lockMarkingSQL = `SELECT marking FROM module_records WHERE module = $1 AND id = $2 FOR UPDATE`
	setMarkingSQL  = `UPDATE module_records SET marking = $3 WHERE module = $1 AND id = $2`
	deleteLinkSQL  = `DELETE FROM record_links WHERE id = $1
         RETURNING id, link_type, source_module, source_id, target_module, target_id`
)

// count runs a query and counts its rows.
func (s Store) count(ctx context.Context, sql string, args ...any) (int, error) {
	rows, err := s.Q.Query(ctx, sql, args...)
	if err != nil {
		return 0, err
	}
	defer rows.Close()
	n := 0
	for rows.Next() {
		n++
	}
	return n, rows.Err()
}

// appendAudit is appendAudit of platform/database/audit-trail.ts.
func (s Store) appendAudit(ctx context.Context, at time.Time, module string, recordID *string, action, detail string) error {
	_, err := s.Q.Exec(ctx, auditSQL, at, module, recordID, action, detail)
	return err
}

// appendEvidenceHistory is appendEvidenceHistory: append-only private provenance.
func (s Store) appendEvidenceHistory(ctx context.Context, id int64, previous, next *string, at time.Time) error {
	_, err := s.Q.Exec(ctx, evidenceHistorySQL, int32(id), previous, next, at) //nolint:gosec // link ids are int4
	return err
}

// sourceVisible is whether a Fuentes record with that id is visible, locked FOR SHARE.
func (s Store) sourceVisible(ctx context.Context, id string) (bool, error) {
	n, err := s.count(ctx, sourceSQL, id)
	return n > 0, err
}

// CreateLink is createLink: both ends (and the evidence source) must be visible; a symmetric
// link also counts as a duplicate when stored reversed.
func (s Store) CreateLink(ctx context.Context, link application.NewLink, at time.Time) (int64, application.CreateProblem, error) {
	modules, ids := columns([]application.NodeRef{link.Source, link.Target})
	present, err := s.count(ctx, presentSQL, modules, ids)
	if err != nil {
		return 0, "", err
	}
	if present != 2 {
		return 0, application.Missing, nil
	}
	if link.EvidenceSourceID != nil && *link.EvidenceSourceID != "" {
		visible, err := s.sourceVisible(ctx, *link.EvidenceSourceID)
		if err != nil {
			return 0, "", err
		}
		if !visible {
			return 0, application.Missing, nil
		}
	}
	if link.Symmetric {
		reversed, err := s.count(ctx, reversedSQL, link.LinkType, link.Target.Module, link.Target.ID, link.Source.Module, link.Source.ID)
		if err != nil {
			return 0, "", err
		}
		if reversed > 0 {
			return 0, application.Duplicate, nil
		}
	}
	var id int32
	err = s.Q.QueryRow(ctx, insertLinkSQL, link.LinkType, link.Source.Module, link.Source.ID,
		link.Target.Module, link.Target.ID, link.Note, link.CreatedBy, at, link.EvidenceSourceID).Scan(&id)
	if errors.Is(err, pgx.ErrNoRows) {
		return 0, application.Duplicate, nil
	}
	if err != nil {
		return 0, "", err
	}
	if err := s.appendEvidenceHistory(ctx, int64(id), nil, link.EvidenceSourceID, at); err != nil {
		return 0, "", err
	}
	recordID := itoa(id)
	if err := s.appendAudit(ctx, at, auditModule, &recordID, "CREATE", "Vínculo creado: "+link.AuditDetail); err != nil {
		return 0, "", err
	}
	return int64(id), "", nil
}

// SetLinkEvidence is setLinkEvidence: the link and both ends must be visible, and the source
// too when one is named; setting the evidence it already has changes and audits nothing.
func (s Store) SetLinkEvidence(ctx context.Context, id int64, sourceID *string, at time.Time) (bool, error) {
	var (
		ends     [2]application.NodeRef
		previous *string
	)
	err := s.Q.QueryRow(ctx, lockLinkSQL, int32(id)). //nolint:gosec // the route accepts at most nine digits
								Scan(&ends[0].Module, &ends[0].ID, &ends[1].Module, &ends[1].ID, &previous)
	if errors.Is(err, pgx.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	modules, ids := columns(ends[:])
	endpoints, err := s.count(ctx, presentSQL, modules, ids)
	if err != nil || endpoints != 2 {
		return false, err
	}
	if sourceID != nil {
		visible, err := s.sourceVisible(ctx, *sourceID)
		if err != nil || !visible {
			return false, err
		}
	}
	if equal(previous, sourceID) {
		return true, nil
	}
	if _, err := s.Q.Exec(ctx, setEvidenceSQL, int32(id), sourceID); err != nil { //nolint:gosec // nine digits at most
		return false, err
	}
	if err := s.appendEvidenceHistory(ctx, id, previous, sourceID, at); err != nil {
		return false, err
	}
	detail := "Fuente de evidencia vinculada"
	if sourceID == nil {
		detail = "Fuente de evidencia retirada"
	}
	recordID := itoa(int32(id)) //nolint:gosec // nine digits at most
	return true, s.appendAudit(ctx, at, auditModule, &recordID, "UPDATE", detail)
}

// SetMarking is setMarking: false when the record is not visible; the same marking again
// changes and audits nothing.
func (s Store) SetMarking(ctx context.Context, ref application.NodeRef, marking string, at time.Time) (bool, error) {
	var previous string
	err := s.Q.QueryRow(ctx, lockMarkingSQL, ref.Module, ref.ID).Scan(&previous)
	if errors.Is(err, pgx.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	if previous == marking {
		return true, nil
	}
	if _, err := s.Q.Exec(ctx, setMarkingSQL, ref.Module, ref.ID, marking); err != nil {
		return false, err
	}
	id := ref.ID
	return true, s.appendAudit(ctx, at, ref.Module, &id, "CLASSIFY", "Clasificación: "+previous+" → "+marking)
}

// DeleteLink is deleteLink: false when no such link exists in the tenant.
func (s Store) DeleteLink(ctx context.Context, id int64, at time.Time) (bool, error) {
	var (
		deleted                                                int32
		linkType, sourceModule, sourceID, targetModule, target string
	)
	err := s.Q.QueryRow(ctx, deleteLinkSQL, int32(id)). //nolint:gosec // nine digits at most
								Scan(&deleted, &linkType, &sourceModule, &sourceID, &targetModule, &target)
	if errors.Is(err, pgx.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	recordID := itoa(int32(id)) //nolint:gosec // nine digits at most
	return true, s.appendAudit(ctx, at, auditModule, &recordID, "DELETE",
		"Vínculo eliminado: "+sourceModule+" "+sourceID+" "+linkType+" "+targetModule+" "+target)
}

func equal(a, b *string) bool {
	if a == nil || b == nil {
		return a == nil && b == nil
	}
	return *a == *b
}

// itoa is String(id) for a link id.
func itoa(id int32) string { return strconv.FormatInt(int64(id), 10) }
