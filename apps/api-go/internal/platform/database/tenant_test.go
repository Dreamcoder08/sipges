package database

import (
	"context"
	"errors"
	"testing"

	"github.com/jackc/pgx/v5"
)

func TestTenantStatement(t *testing.T) {
	t.Parallel()
	tests := []struct {
		name    string
		ctx     context.Context
		tenant  string
		want    string
		wantErr error
	}{
		{
			name:   "outside a request: no actor and full clearance",
			ctx:    context.Background(),
			tenant: "ACME/NORTE",
			want: `SELECT set_config('app.tenant_id', E'ACME/NORTE', true),
            set_config('app.actor', E'', true),
            set_config('app.clearance', E'full', true),
            set_config('role', 'sipges_tenant', true)`,
		},
		{
			name:   "request actor and clearance",
			ctx:    WithActor(context.Background(), Actor{Name: "ana.perez", Clearance: ClearanceLimited}),
			tenant: "ACME/NORTE",
			want: `SELECT set_config('app.tenant_id', E'ACME/NORTE', true),
            set_config('app.actor', E'ana.perez', true),
            set_config('app.clearance', E'limited', true),
            set_config('role', 'sipges_tenant', true)`,
		},
		{
			name:   "quotes and backslashes are doubled",
			ctx:    context.Background(),
			tenant: `X\'); SET LOCAL ROLE postgres; SELECT ('`,
			want: `SELECT set_config('app.tenant_id', E'X\\''); SET LOCAL ROLE postgres; SELECT (''', true),
            set_config('app.actor', E'', true),
            set_config('app.clearance', E'full', true),
            set_config('role', 'sipges_tenant', true)`,
		},
		{name: "empty tenant", ctx: context.Background(), tenant: "", wantErr: ErrTenantRequired},
		{name: "NUL in tenant", ctx: context.Background(), tenant: "ACME\x00NORTE", wantErr: ErrInvalidSetting},
		{
			name:    "NUL in actor",
			ctx:     WithActor(context.Background(), Actor{Name: "a\x00b", Clearance: ClearanceFull}),
			tenant:  "ACME/NORTE",
			wantErr: ErrInvalidSetting,
		},
		{name: "invalid UTF-8", ctx: context.Background(), tenant: "ACME\xc0'", wantErr: ErrInvalidSetting},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			got, err := tenantStatement(tc.ctx, tc.tenant)
			if !errors.Is(err, tc.wantErr) {
				t.Fatalf("err = %v, want %v", err, tc.wantErr)
			}
			if got != tc.want {
				t.Fatalf("statement =\n%s\nwant\n%s", got, tc.want)
			}
		})
	}
}

func TestWithTenantRejectsInvalidIDBeforeOpeningTransaction(t *testing.T) {
	t.Parallel()
	for _, tenant := range []string{"", "ACME\x00NORTE"} {
		db := &refusingBeginner{}
		_, err := WithTenant(context.Background(), db, tenant, func(context.Context, Querier) (struct{}, error) {
			t.Fatal("work must not run")
			return struct{}{}, nil
		})
		if err == nil {
			t.Fatalf("tenant %q: want an error", tenant)
		}
		if db.calls != 0 {
			t.Fatalf("tenant %q: Begin called %d times, want 0", tenant, db.calls)
		}
	}
}

// refusingBeginner counts Begin calls and never opens a transaction.
type refusingBeginner struct{ calls int }

func (b *refusingBeginner) Begin(context.Context) (pgx.Tx, error) {
	b.calls++
	return nil, errors.New("refusingBeginner: Begin must not be called")
}
