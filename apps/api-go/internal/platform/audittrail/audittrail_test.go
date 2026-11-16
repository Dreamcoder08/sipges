package audittrail

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

// recorder is a Querier that keeps the statement and arguments of each Exec.
type recorder struct {
	sql  string
	args []any
}

func (r *recorder) Exec(_ context.Context, sql string, args ...any) (pgconn.CommandTag, error) {
	r.sql, r.args = sql, args
	return pgconn.NewCommandTag("INSERT 0 1"), nil
}

func (*recorder) Query(context.Context, string, ...any) (pgx.Rows, error) { panic("unused") }

func (*recorder) QueryRow(context.Context, string, ...any) pgx.Row { panic("unused") }

func appendOne(t *testing.T, e Entry) *recorder {
	t.Helper()
	r := &recorder{}
	if err := Append(context.Background(), r, e); err != nil {
		t.Fatal(err)
	}
	if len(r.args) != 6 {
		t.Fatalf("args = %d, want 6", len(r.args))
	}
	return r
}

func TestAppendWritesTheAuditTableInTheTransactionTenant(t *testing.T) {
	at := time.Date(2026, 1, 2, 3, 4, 5, 0, time.UTC)
	r := appendOne(t, Entry{At: at, Module: "M", RecordID: ID("R-1"), Action: "CREATE", Detail: "d"})
	want := `INSERT INTO audit (tenant_id, ts, module, record_id, action, detail, event_payload)
     VALUES (current_setting('app.tenant_id', true), $1, $2, $3, $4, $5, $6::jsonb)`
	if r.sql != want {
		t.Fatalf("sql =\n%s\nwant\n%s", r.sql, want)
	}
	if !strings.Contains(r.sql, "current_setting('app.tenant_id', true)") {
		t.Fatal("the tenant must come from the transaction")
	}
	if r.args[0] != at || r.args[1] != "M" || *r.args[2].(*string) != "R-1" || r.args[3] != "CREATE" || r.args[4] != "d" {
		t.Fatalf("args = %#v", r.args)
	}
}

func TestAppendPassesNilForAMissingPayload(t *testing.T) {
	r := appendOne(t, Entry{Module: "M", Action: "A"})
	if r.args[5] != nil {
		t.Fatalf("payload arg = %#v, want nil", r.args[5])
	}
}

func TestAppendPassesThePayloadText(t *testing.T) {
	r := appendOne(t, Entry{Module: "M", Action: "A", Payload: []byte(`{"id":"x"}`)})
	if r.args[5] != `{"id":"x"}` {
		t.Fatalf("payload arg = %#v", r.args[5])
	}
}

func TestAppendPassesNilForAMissingRecordID(t *testing.T) {
	r := appendOne(t, Entry{Module: "M", Action: "A"})
	if id, ok := r.args[2].(*string); !ok || id != nil {
		t.Fatalf("record_id arg = %#v, want a nil pointer", r.args[2])
	}
}

func TestAppendKeepsAnEmptyRecordIDEmpty(t *testing.T) {
	r := appendOne(t, Entry{Module: "M", Action: "A", RecordID: ID("")})
	if id, ok := r.args[2].(*string); !ok || id == nil || *id != "" {
		t.Fatalf("record_id arg = %#v, want a pointer to \"\"", r.args[2])
	}
}
