package app_test

import (
	"context"
	"errors"
	"log/slog"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/Dreamcoder08/sipges/apps/api-go/internal/app"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/platform/database"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/platform/database/dbtest"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/privacy/application"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/privacy/domain"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/privacy/infrastructure"
)

const (
	tenantUno = "PRIVACY/UNO"
	tenantDos = "PRIVACY/DOS"
	dataKey   = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=" // synthetic: bytes 0 to 31
)

var egressAt = time.Date(2026, 11, 4, 12, 0, 0, 0, time.UTC)

// privacyPool seeds two projects of synthetic people and returns a pool and the composed guard.
func privacyPool(t *testing.T) (*pgxpool.Pool, *application.Guard) {
	t.Helper()
	if scratch == nil {
		t.Skip(dbtest.EnvAdminURL + " is not set")
	}
	conn, err := pgx.Connect(t.Context(), scratch.URL)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = conn.Close(context.Background()) }()
	//nolint:misspell // Spanish field names kept verbatim from the TypeScript API
	if _, err := conn.Exec(t.Context(), `
		INSERT INTO tenants (company_id, project_id, label) VALUES ('PRIVACY','UNO','Uno'), ('PRIVACY','DOS','Dos')
		  ON CONFLICT DO NOTHING;
		INSERT INTO module_records (tenant_id, module, id, payload, created_at, updated_at, marking) VALUES
		  ('PRIVACY/UNO','Actores','A1','{"Nombre_Actor/Organizacion":"Comunidad Uno Secreta"}', now(), now(), 'interno'),
		  ('PRIVACY/UNO','Eventos','E1','{"Actor_Principal":"Persona Restringida Uno","Descripcion_Hecho":"No es un nombre"}', now(), now(), 'restringido'),
		  ('PRIVACY/UNO','Dialogos','D1','{"Participantes":"Ana Uno, Luis Uno y Eva Uno"}', now(), now(), 'interno'),
		  ('PRIVACY/UNO','Buzon','B1','{"Remitente":"Rosa Uno Tapia"}', now(), now(), 'interno'),
		  ('PRIVACY/DOS','Actores','A2','{"Nombre_Actor/Organizacion":"Vecino Ajeno Dos"}', now(), now(), 'interno')
		  ON CONFLICT DO NOTHING;
		INSERT INTO project_settings (tenant_id, settings, updated_by, updated_at) VALUES
		  ('PRIVACY/UNO','{"externalAi":{"enabled":true}}','t',now()),
		  ('PRIVACY/DOS','{"externalAi":{"enabled":"true"}}','t',now())
		  ON CONFLICT (tenant_id) DO UPDATE SET settings = EXCLUDED.settings;
		DELETE FROM audit WHERE tenant_id LIKE 'PRIVACY/%' AND module = 'IA externa';`); err != nil {
		t.Fatal(err)
	}
	pool, err := pgxpool.New(t.Context(), scratch.URL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	t.Setenv("SIPGES_DATA_KEY", dataKey)
	guard, err := app.EgressGuard(app.Deps{Pool: pool, Logger: slog.New(slog.DiscardHandler), Now: func() time.Time { return egressAt }})
	if err != nil {
		t.Fatal(err)
	}
	return pool, guard
}

func openEgress(t *testing.T, ctx context.Context, guard *application.Guard, tenant string) *application.Session { //nolint:revive // t first
	t.Helper()
	session, err := guard.Open(ctx, application.Request{TenantID: tenant, Channel: application.ChannelMCP, Purpose: "get_record"})
	if err != nil {
		t.Fatal(err)
	}
	return session
}

type auditRow struct {
	Tenant, Module, Action, Detail string
	RecordID                       *string
	At                             time.Time
}

func egressRows(t *testing.T, pool *pgxpool.Pool) []auditRow {
	t.Helper()
	rows, err := pool.Query(t.Context(), `SELECT tenant_id, module, action, detail, record_id, ts FROM audit
		WHERE tenant_id LIKE 'PRIVACY/%' ORDER BY id`)
	if err != nil {
		t.Fatal(err)
	}
	found, err := pgx.CollectRows(rows, pgx.RowToStructByPos[auditRow])
	if err != nil {
		t.Fatal(err)
	}
	return found
}

// Names are read with full clearance: a restricted record's name is replaced even for a limited
// role, list fields are split into people, and a field that is never sent still counts.
func TestEgressScrubsEveryNameOfTheProject(t *testing.T) {
	_, guard := privacyPool(t)
	ctx := database.WithActor(t.Context(), database.Actor{Name: "consulta", Clearance: database.ClearanceLimited})
	session := openEgress(t, ctx, guard, tenantUno)
	for _, name := range []string{"Comunidad Uno Secreta", "PERSONA RESTRINGIDA UNO", "Ana Uno", "Luis Uno", "Eva Uno", "rosa uno tapia"} {
		got := session.Text("Habló " + name + " ayer")
		if strings.Contains(strings.ToLower(got), strings.ToLower(name)) {
			t.Errorf("%q stayed in clear: %q", name, got)
		}
	}
	if got := session.Text("No es un nombre"); got != "No es un nombre" {
		t.Errorf("free text is not a name: %q", got)
	}
}

// One project's directory holds only its own names, and the same name has another token elsewhere.
func TestEgressKeepsProjectsApart(t *testing.T) {
	pool, guard := privacyPool(t)
	uno := openEgress(t, t.Context(), guard, tenantUno)
	if got := uno.Text("Vecino Ajeno Dos"); got != "Vecino Ajeno Dos" {
		t.Errorf("a name of another project reached this one's directory: %q", got)
	}
	if _, err := pool.Exec(t.Context(), `UPDATE project_settings SET settings = '{"externalAi":{"enabled":true}}' WHERE tenant_id = $1`, tenantDos); err != nil {
		t.Fatal(err)
	}
	dos := openEgress(t, t.Context(), guard, tenantDos)
	if got := dos.Text("Comunidad Uno Secreta"); got != "Comunidad Uno Secreta" {
		t.Errorf("a name of another project reached this one's directory: %q", got)
	}
	record := []domain.RawRecord{{Module: "actores", ID: "A", Marking: new("interno"), Fields: []domain.RawField{
		{Name: "Nombre_Actor/Organizacion", Value: "Vecino Ajeno Dos"}, //nolint:misspell // Spanish name kept verbatim from the TypeScript API
	}}}
	first, second := uno.Records(record)[0].Fields[0].Value.Text, dos.Records(record)[0].Fields[0].Value.Text
	if first == second || !strings.HasPrefix(first, "Actor-") || !strings.HasPrefix(second, "Actor-") {
		t.Errorf("tokens %q and %q", first, second)
	}
}

// The switch is the project's own, and only the boolean true opens it.
func TestEgressRefusesWhileTheSwitchIsOff(t *testing.T) {
	pool, guard := privacyPool(t)
	for _, tenant := range []string{tenantDos, "SIPGES/PRJ-SECHURA"} {
		_, err := guard.Open(t.Context(), application.Request{TenantID: tenant, Channel: application.ChannelMCP, Purpose: "x"})
		if !errors.Is(err, application.ErrDisabled) {
			t.Fatalf("%s: %v", tenant, err)
		}
	}
	if rows := egressRows(t, pool); len(rows) != 0 {
		t.Fatalf("a refusal wrote %v", rows)
	}
}

// One release writes one audit row in the project it left from, with ids and counts only.
func TestEgressWritesOneAuditRow(t *testing.T) {
	pool, guard := privacyPool(t)
	ctx := database.WithActor(t.Context(), database.Actor{Name: "analista", Clearance: database.ClearanceFull})
	session := openEgress(t, ctx, guard, tenantUno)
	clean := session.Records([]domain.RawRecord{{
		Module: "eventos", ID: "E9", Marking: new("interno"),
		Fields: []domain.RawField{
			{Name: "Descripcion_Hecho", Value: "Ana Uno llamó al 987654321"},
			{Name: "Posicion_Proyecto", Value: "En contra"},
		},
	}})
	if _, err := application.Release(ctx, session, clean); err != nil {
		t.Fatal(err)
	}
	rows := egressRows(t, pool)
	if len(rows) != 1 {
		t.Fatalf("rows = %+v", rows)
	}
	row := rows[0]
	const detail = "canal mcp · get_record · actor analista · registros: eventos/E9 · campos enviados: 1 · descartados: 1 (Posicion_Proyecto) · caracteres: "
	if row.Tenant != tenantUno || row.Module != infrastructure.AuditModule || row.Action != infrastructure.AuditAction ||
		row.RecordID != nil || !row.At.Equal(egressAt) || !strings.HasPrefix(row.Detail, detail) {
		t.Fatalf("row = %+v", row)
	}
	for _, secret := range []string{"Ana Uno", "987654321", "En contra"} {
		if strings.Contains(row.Detail, secret) {
			t.Fatalf("the log holds a value: %q", row.Detail)
		}
	}
}

// A project that does not exist cannot be logged, so nothing leaves it.
func TestEgressLogFailsWithoutItsRow(t *testing.T) {
	pool, _ := privacyPool(t)
	err := infrastructure.EgressLog{DB: pool}.Append(t.Context(), "PRIVACY/NINGUNO", application.EgressLogEntry{Detail: "x", At: egressAt})
	if err == nil {
		t.Fatal("the audit row of an unknown project was written")
	}
}

func TestAMalformedDataKeyStopsTheGuard(t *testing.T) {
	t.Setenv("SIPGES_DATA_KEY", "corta")
	if _, err := app.EgressGuard(app.Deps{}); err == nil || err.Error() != "SIPGES_DATA_KEY must decode to 32 bytes" {
		t.Fatalf("err = %v", err)
	}
}
