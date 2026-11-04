package application

import (
	"context"
	"errors"
	"strconv"
	"time"

	"github.com/Dreamcoder08/sipges/apps/api-go/internal/records/domain"
)

// The write side of records-service.ts: create, replace, remove and the spreadsheet import.
// Every write and its audit entry share one tenant transaction (the store's job); the history
// row comes from the module_records trigger, as the session's actor.

// AuditNote is the audit text written in the same transaction as a change.
type AuditNote struct {
	Action string
	Detail string
}

// The notes of records-service.ts.
var (
	createNote = AuditNote{Action: "CREATE", Detail: "Registro creado desde prototipo V0.2"}
	updateNote = AuditNote{Action: "UPDATE", Detail: "Registro actualizado"}
	deleteNote = AuditNote{Action: "DELETE", Detail: "Registro eliminado"}
)

// Writer is the write side of the record store; each call is one tenant transaction.
type Writer interface {
	// Create inserts under the first free id among candidates (tried lazily, in order) and audits
	// it; "" when every candidate was taken.
	Create(ctx context.Context, tenantID, module string, candidates func(yield func(string) bool), payloadFor func(id string) *domain.Object, note AuditNote, at time.Time) (string, error)
	// Replace overwrites a record's payload; false when missing (nothing audited).
	Replace(ctx context.Context, tenantID, module, id string, payload *domain.Object, note AuditNote, at time.Time) (bool, error)
	// Existing returns the ids among ids already stored in module.
	Existing(ctx context.Context, tenantID, module string, ids []string) (map[string]bool, error)
	// ImportBatch merges every item into its record (creating it when missing) and appends one
	// audit entry for the batch.
	ImportBatch(ctx context.Context, tenantID, module string, items []domain.ImportItem, note AuditNote, at time.Time) (created, updated int, err error)
	// Remove deletes a record; false when missing (nothing audited).
	Remove(ctx context.Context, tenantID, module, id string, note AuditNote, at time.Time) (bool, error)
}

// Writes are the write use cases.
type Writes struct {
	Store Writer
	// Now is the clock; JavaScript dates hold milliseconds, so it is truncated to them.
	Now func() time.Time
	// RandomHex gives the upper-case hexadecimal digits of generated ids.
	RandomHex domain.RandomHex
}

// collisionAttempts is COLLISION_ATTEMPTS.
const collisionAttempts = 5

// ErrExhausted is the create that found no free id (the route's 500).
var ErrExhausted = errors.New("records: could not allocate a record id")

func (w Writes) now() time.Time { return w.Now().Truncate(time.Millisecond) }

// owned is ownedPayload: the id rule, then the tenant's project on the payload.
func owned(tenantID, module string, payload *domain.Object) (*domain.Object, *domain.Problem) {
	if problem := domain.ValidatePayload(module, payload); problem != nil {
		return nil, problem
	}
	project := domain.TenantProject(tenantID)
	if project == "" {
		return payload, nil
	}
	return domain.WithTenantProject(module, payload, project)
}

// Create is records.create: the id the record was stored under, the refused field, or an error
// (ErrExhausted when every candidate id was taken).
func (w Writes) Create(ctx context.Context, tenantID, module string, given *domain.Object) (string, *domain.Problem, error) {
	payload, problem := owned(tenantID, module, given)
	if problem != nil {
		return "", problem, nil
	}
	preferred := domain.RecordIDFor(module, payload, w.RandomHex)
	candidates := func(yield func(string) bool) {
		if !yield(preferred) {
			return
		}
		for range collisionAttempts {
			if !yield(domain.CollisionID(preferred, w.RandomHex)) {
				return
			}
		}
	}
	id, err := w.Store.Create(ctx, tenantID, module, candidates, func(chosen string) *domain.Object {
		return domain.WithAssignedID(module, payload, chosen)
	}, createNote, w.now())
	if err != nil {
		return "", nil, err
	}
	if id == "" {
		return "", nil, ErrExhausted
	}
	return id, nil, nil
}

// Replace is records.replace: found reports whether the record existed.
func (w Writes) Replace(ctx context.Context, tenantID, module, id string, given *domain.Object) (found bool, problem *domain.Problem, err error) {
	payload, problem := owned(tenantID, module, given)
	if problem != nil {
		return false, problem, nil
	}
	if !domain.IsLookupableID(id) {
		return false, nil, nil
	}
	found, err = w.Store.Replace(ctx, tenantID, module, id, payload, updateNote, w.now())
	return found, nil, err
}

// Remove is records.remove.
func (w Writes) Remove(ctx context.Context, tenantID, module, id string) (bool, error) {
	if !domain.IsLookupableID(id) {
		return false, nil
	}
	return w.Store.Remove(ctx, tenantID, module, id, deleteNote, w.now())
}

// ImportReport is ImportReport of records-service.ts.
type ImportReport struct {
	Applied  bool
	Created  int
	Updated  int
	Problems []domain.ImportProblem
}

// ImportRows is records.importRows, all or nothing: a dry run, a batch with problems or one
// without rows reports what would be created, updated or refused; otherwise the rows merge in one
// transaction with a single IMPORT audit entry naming the source.
func (w Writes) ImportRows(ctx context.Context, tenantID, module string, in domain.Import) (ImportReport, error) {
	if len(in.Rows) > domain.MaxImportRows {
		return ImportReport{Problems: []domain.ImportProblem{{Row: 0, Message: "Máximo " + strconv.Itoa(domain.MaxImportRows) + " filas por importación"}}}, nil
	}
	items, problems := domain.PlanImport(module, in.Rows, w.RandomHex, domain.TenantProject(tenantID))
	if in.DryRun || len(problems) > 0 || len(items) == 0 {
		existing := map[string]bool{}
		if len(items) > 0 {
			ids := make([]string, len(items))
			for i, item := range items {
				ids[i] = item.ID
			}
			var err error
			if existing, err = w.Store.Existing(ctx, tenantID, module, ids); err != nil {
				return ImportReport{}, err
			}
		}
		updated := 0
		for _, item := range items {
			if existing[item.ID] {
				updated++
			}
		}
		return ImportReport{Created: len(items) - updated, Updated: updated, Problems: problems}, nil
	}
	source := domain.Slice16(domain.TrimJS(in.Source), 120)
	if source == "" {
		source = "archivo sin nombre"
	}
	note := AuditNote{Action: "IMPORT", Detail: "Importación de " + strconv.Itoa(len(items)) + " filas desde " + source}
	created, updated, err := w.Store.ImportBatch(ctx, tenantID, module, items, note, w.now())
	if err != nil {
		return ImportReport{}, err
	}
	return ImportReport{Applied: true, Created: created, Updated: updated, Problems: []domain.ImportProblem{}}, nil
}
