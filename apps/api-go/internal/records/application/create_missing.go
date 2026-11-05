package application

import (
	"context"
	"slices"
	"strconv"
	"time"

	"github.com/Dreamcoder08/sipges/apps/api-go/internal/records/domain"
)

// InsertOnlyWriter is the record store's insert-only import (importBatch with insertOnly):
// ids already stored are left untouched, and one audit entry covers the batch.
type InsertOnlyWriter interface {
	Writer
	InsertBatch(ctx context.Context, tenantID, module string, items []domain.ImportItem, note AuditNote, at time.Time) (created int, err error)
}

// MissingItem is one record to create under a caller-chosen id.
type MissingItem struct {
	ID     string
	Fields *domain.Object // string values only
}

// MissingReport is what CreateMissing did (or, in a dry run, would do).
type MissingReport struct {
	Created  int
	Existing int
	Problems []domain.ImportProblem
}

// CreateMissing is records.createMissing: insert-only creation under caller-chosen,
// deterministic ids (document review approvals). Values are normalized and validated exactly as
// a spreadsheet import; any problem refuses the whole batch. Ids already stored are left
// untouched, so re-running never duplicates nor overwrites an edited record. A dry run writes
// nothing. One item is audited as CREATE under its id; a batch as one IMPORT entry.
func CreateMissing(ctx context.Context, store InsertOnlyWriter, now func() time.Time, tenantID, module string, items []MissingItem, dryRun bool, source string) (MissingReport, error) {
	if len(items) > domain.MaxImportRows {
		return MissingReport{Problems: []domain.ImportProblem{{Row: 0, Message: "Máximo " + strconv.Itoa(domain.MaxImportRows) + " filas por importación"}}}, nil
	}
	// The caller's ids replace planImport's; a per-row counter keeps its throwaway ids for
	// modules without an id field distinct, so they can never refuse the batch as repeated.
	row := 0
	counter := func(length int) string {
		s := strconv.FormatInt(int64(row), 16)
		row++
		for len(s) < length {
			s = "0" + s
		}
		return s
	}
	rows := make([]*domain.Object, len(items))
	for i, item := range items {
		rows[i] = item.Fields
	}
	planned, problems := domain.PlanImport(module, rows, counter, "")
	seen := map[string]bool{}
	for index, item := range items {
		switch {
		case item.ID == "" || !domain.IsLookupableID(item.ID):
			problems = append(problems, domain.ImportProblem{Row: index + 1, Message: "Código de registro inválido"})
		case seen[item.ID]:
			problems = append(problems, domain.ImportProblem{Row: index + 1, Message: "El código " + item.ID + " está repetido"})
		}
		seen[item.ID] = true
	}
	if len(problems) > 0 {
		slices.SortStableFunc(problems, func(a, b domain.ImportProblem) int { return a.Row - b.Row })
		return MissingReport{Problems: problems}, nil
	}
	for i := range planned {
		planned[i].ID = items[planned[i].Row-1].ID
	}
	present := map[string]bool{}
	if len(planned) > 0 {
		ids := make([]string, len(planned))
		for i, p := range planned {
			ids[i] = p.ID
		}
		var err error
		if present, err = store.Existing(ctx, tenantID, module, ids); err != nil {
			return MissingReport{}, err
		}
	}
	var fresh []domain.ImportItem
	for _, p := range planned {
		if !present[p.ID] {
			fresh = append(fresh, p)
		}
	}
	if dryRun || len(fresh) == 0 {
		return MissingReport{Created: len(fresh), Existing: len(planned) - len(fresh), Problems: []domain.ImportProblem{}}, nil
	}
	source = domain.Slice16(domain.TrimJS(source), 120)
	if source == "" {
		source = "origen sin nombre"
	}
	at := now().Truncate(time.Millisecond)
	created := 0
	if len(fresh) == 1 {
		single := fresh[0]
		id, err := store.Create(ctx, tenantID, module, func(yield func(string) bool) { yield(single.ID) },
			func(string) *domain.Object { return single.Payload },
			AuditNote{Action: "CREATE", Detail: "Registro creado desde " + source}, at)
		if err != nil {
			return MissingReport{}, err
		}
		if id != "" {
			created = 1
		}
	} else {
		var err error
		created, err = store.InsertBatch(ctx, tenantID, module, fresh,
			AuditNote{Action: "IMPORT", Detail: strconv.Itoa(len(fresh)) + " registros creados desde " + source}, at)
		if err != nil {
			return MissingReport{}, err
		}
	}
	return MissingReport{Created: created, Existing: len(planned) - created, Problems: []domain.ImportProblem{}}, nil
}
