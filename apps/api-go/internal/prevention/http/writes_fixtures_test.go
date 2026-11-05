package http_test

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"reflect"
	"strings"
	"testing"
	"time"

	identitydomain "github.com/Dreamcoder08/sipges/apps/api-go/internal/identity/domain"
	identityhttp "github.com/Dreamcoder08/sipges/apps/api-go/internal/identity/http"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/prevention/application"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/prevention/domain"
	preventionhttp "github.com/Dreamcoder08/sipges/apps/api-go/internal/prevention/http"
	records "github.com/Dreamcoder08/sipges/apps/api-go/internal/records/domain"
	tenancydomain "github.com/Dreamcoder08/sipges/apps/api-go/internal/tenancy/domain"
	tenancyhttp "github.com/Dreamcoder08/sipges/apps/api-go/internal/tenancy/http"
)

// The answers of the TypeScript write routes on synthetic requests, recorded by
// ../testdata/writes.mjs through preventionRoutes and createPreventionService with an in-memory
// store: the Go routes and use cases, on a store that logs the same calls, must answer the same
// bytes and ask the store for the same writes.

type writeScenario struct {
	Name     string `json:"name"`
	Method   string `json:"method"`
	Path     string `json:"path"`
	Body     string `json:"body"`
	Status   int    `json:"status"`
	Response string `json:"response"`
	Log      []any  `json:"log"`
}

type memoryStore struct {
	created time.Time
	log     []any
}

var storedPlans = map[string]domain.ActionStatus{
	"PREV-OPEN": domain.StatusPending, "PREV-RUN": domain.StatusInProgress, "PREV-CANCEL": domain.StatusCancelled,
}

func iso(t time.Time) string { return t.UTC().Format("2006-01-02T15:04:05.000Z") }

func (m *memoryStore) List(context.Context, string, string) ([]domain.PreventiveAction, error) {
	return nil, nil
}

func (m *memoryStore) Create(_ context.Context, _ string, a application.NewAction, logID string) (domain.PreventiveAction, error) {
	m.log = append(m.log, map[string]any{"op": "create", "logId": logID, "action": map[string]any{
		"id": a.ID, "projectId": a.ProjectID, "alertId": a.AlertID, "title": records.WellFormed(a.Title), "responsible": a.Responsible,
		"dueDate": a.DueDate, "description": a.Description, "createdAt": iso(a.CreatedAt),
	}})
	return domain.PreventiveAction{
		ID: a.ID, ProjectID: a.ProjectID, AlertID: a.AlertID, Title: records.WellFormed(a.Title), Responsible: a.Responsible,
		DueDate: a.DueDate, Description: a.Description, Status: domain.StatusPending,
		CreatedAt: a.CreatedAt, UpdatedAt: a.CreatedAt, History: []domain.ActionLogEntry{},
	}, nil
}

func (m *memoryStore) Update(_ context.Context, _, id string, guard application.Guard, c application.ActionChange) (domain.PreventiveAction, domain.UpdateError, error) {
	status, found := storedPlans[id]
	if !found {
		return domain.PreventiveAction{}, domain.ErrMissing, nil
	}
	current := domain.PreventiveAction{
		ID: id, ProjectID: "PRJ-SINT", AlertID: "ALERT-OK", Title: "Plan sintético", Responsible: "Equipo",
		DueDate: "2027-01-01", Status: status, CreatedAt: m.created, UpdatedAt: m.created,
		History: []domain.ActionLogEntry{},
	}
	if refused := guard(current); refused != "" {
		return domain.PreventiveAction{}, refused, nil
	}
	var receipt, block any
	if c.Receipt != nil {
		receipt = map[string]any{"attachmentId": c.Receipt.AttachmentID, "fileName": c.Receipt.FileName, "sha256": c.Receipt.SHA256}
	}
	switch {
	case !c.Block.Change:
		block = "unchanged"
	case c.Block.To != nil:
		block = map[string]any{"by": c.Block.To.By, "reason": c.Block.To.Reason, "since": iso(c.Block.To.Since)}
	}
	m.log = append(m.log, map[string]any{"op": "update", "id": id, "change": map[string]any{
		"id": c.ID, "createdAt": iso(c.CreatedAt), "status": string(c.Status), "progress": float64(c.Progress),
		"note": c.Note, "evidenceUrl": c.EvidenceURL, "decidedBy": c.DecidedBy, "receipt": receipt, "block": block,
	}})
	current.Status, current.Progress = c.Status, c.Progress
	return current, "", nil
}

type lookups struct{}

func (lookups) Status(_ context.Context, _ tenancydomain.Scope, id string) (*string, error) {
	status, found := map[string]string{"ALERT-OK": "Corroborado", "ALERT-SEG": "En seguimiento", "ALERT-NEW": "Descartado"}[id]
	if !found {
		return nil, nil
	}
	return &status, nil
}

func (lookups) Find(_ context.Context, _ tenancydomain.Scope, id string) (*domain.DecisionReceipt, error) {
	if id != "EV-1" {
		return nil, nil
	}
	return &domain.DecisionReceipt{AttachmentID: id, FileName: "acta.pdf", SHA256: strings.Repeat("ab", 32)}, nil
}

// countingHex is the generator's countingHex: 1, 2, 3, … left-padded with F.
func countingHex() func(int) string {
	n := 0
	return func(length int) string {
		n++
		s := strings.Repeat("F", length) + strings.ToUpper(fmt.Sprintf("%x", n))
		return s[len(s)-length:]
	}
}

func TestWriteRoutesMatchTheRecordedTypeScriptAnswers(t *testing.T) {
	raw, err := os.ReadFile("../testdata/writes.json")
	if err != nil {
		t.Fatal(err)
	}
	var file struct {
		At        time.Time       `json:"at"`
		Created   time.Time       `json:"created"`
		Scenarios []writeScenario `json:"scenarios"`
	}
	if err := json.Unmarshal(raw, &file); err != nil {
		t.Fatal(err)
	}
	if len(file.Scenarios) == 0 {
		t.Fatal("no scenarios")
	}
	for _, s := range file.Scenarios {
		t.Run(s.Name, func(t *testing.T) {
			store := &memoryStore{created: file.Created}
			service := application.Service{
				Store: store, Alerts: lookups{}, Evidence: lookups{}, RandomHex: countingHex(),
				Now: func() time.Time { return file.At },
			}
			mux := http.NewServeMux()
			preventionhttp.WriteRoutes(mux, service, nil)
			r := httptest.NewRequest(s.Method, s.Path, strings.NewReader(s.Body))
			ctx := tenancyhttp.WithScope(r.Context(), tenancydomain.Scope{CompanyID: "SIPGES", ProjectID: "PRJ-SINT"})
			ctx = identityhttp.WithPrincipal(ctx, &identitydomain.Principal{Username: "sint.usuario"})
			w := httptest.NewRecorder()
			mux.ServeHTTP(w, r.WithContext(ctx))
			if w.Code != s.Status || w.Body.String() != s.Response {
				t.Fatalf("got %d %s\nwant %d %s", w.Code, w.Body.String(), s.Status, s.Response)
			}
			if !reflect.DeepEqual(append([]any{}, store.log...), append([]any{}, s.Log...)) {
				t.Fatalf("store log\n got %v\nwant %v", store.log, s.Log)
			}
		})
	}
}
