//nolint:misspell // Spanish module slugs and record fields, verbatim from the TypeScript API.
package http_test

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"os"
	"regexp"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/Dreamcoder08/sipges/apps/api-go/internal/app/apitest"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/identity/infrastructure"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/platform/database/dbtest"
)

// The records read routes against a migrated synthetic PostgreSQL, through the composed handler
// (session, project scope, role gate). Every account, project and record is synthetic.

var scratch *dbtest.Scratch

func TestMain(m *testing.M) { os.Exit(run(m)) }

func run(m *testing.M) int {
	adminURL := os.Getenv(dbtest.EnvAdminURL)
	if adminURL == "" {
		return m.Run() // integration tests skip themselves
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	s, err := dbtest.NewScratch(ctx, adminURL)
	if err != nil {
		fmt.Fprintln(os.Stderr, "scratch database:", err)
		return 1
	}
	defer func() {
		if err := s.Drop(context.Background()); err != nil {
			fmt.Fprintln(os.Stderr, "drop scratch database:", err)
		}
	}()
	if err := seed(ctx, s.URL); err != nil {
		fmt.Fprintln(os.Stderr, "seed scratch database:", err)
		return 1
	}
	scratch = s
	return m.Run()
}

var t0 = time.Date(2026, 11, 3, 11, 0, 0, 0, time.UTC)

var tokens = map[string]string{}

// tenantRows runs sql inside a transaction entered as tenant, so the row-level security
// policies hold even for a non-superuser test login, and the history trigger records each change.
func tenantRows(ctx context.Context, conn *pgx.Conn, tenant, sql string) error {
	tx, err := conn.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `SELECT set_config('app.tenant_id', $1, true), set_config('app.actor', 'semilla', true)`, tenant); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, sql); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func seed(ctx context.Context, dsn string) error {
	conn, err := pgx.Connect(ctx, dsn)
	if err != nil {
		return err
	}
	defer func() { _ = conn.Close(ctx) }()
	if _, err := conn.Exec(ctx, `
		INSERT INTO tenants (company_id, project_id, label) VALUES
		  ('SIPGES','PRJ-SECHURA','Sechura'), ('ACME','NORTE','Norte') ON CONFLICT DO NOTHING;
		INSERT INTO users (username, full_name, password_hash, role, active, totp_enabled) VALUES
		  ('multi',  'Multi Admin',  'x', 'admin',    true, true),
		  ('solo',   'Solo Analyst', 'x', 'analista', true, true),
		  ('reader', 'Read Only',    'x', 'consulta', true, true);
		INSERT INTO grants (username, tenant_id) VALUES
		  ('multi','SIPGES/PRJ-SECHURA'), ('multi','ACME/NORTE'),
		  ('solo','SIPGES/PRJ-SECHURA'), ('reader','SIPGES/PRJ-SECHURA');`); err != nil {
		return err
	}
	if err := tenantRows(ctx, conn, "SIPGES/PRJ-SECHURA", `
		INSERT INTO module_records (tenant_id, module, id, payload, marking, created_at, updated_at) VALUES
		  ('SIPGES/PRJ-SECHURA','Buzon','BZ-1','{"Asunto":"Sechura","Territorio":"Sechura","2":1}','interno','2026-01-01T00:00:00Z','2026-01-01T00:00:00Z'),
		  ('SIPGES/PRJ-SECHURA','Buzon','BZ-R','{"Asunto":"Reservado"}','restringido','2026-01-02T00:00:00Z','2026-01-02T00:00:00Z'),
		  ('SIPGES/PRJ-SECHURA','Fuentes','F-1','{"Archivo_Fuente":"acta.pdf","Nivel_Base_Verificacion":"A - Confirmada"}','interno','2026-01-03T00:00:00Z','2026-01-03T00:00:00Z');
		UPDATE module_records SET payload = '{"Asunto":"Sechura revisado","2":1}', updated_at = '2026-01-04T00:00:00.5Z'
		  WHERE module = 'Buzon' AND id = 'BZ-1';`); err != nil {
		return fmt.Errorf("sechura: %w", err)
	}
	// Another tenant reuses the module and the id: only RLS keeps it out of Sechura.
	if err := tenantRows(ctx, conn, "ACME/NORTE", `
		INSERT INTO module_records (tenant_id, module, id, payload, created_at, updated_at) VALUES
		  ('ACME/NORTE','Buzon','BZ-1','{"Asunto":"Norte secreto"}','2026-02-01T00:00:00Z','2026-02-01T00:00:00Z'),
		  ('ACME/NORTE','Buzon','BZ-N','{"Asunto":"Solo del norte"}','2026-02-02T00:00:00Z','2026-02-02T00:00:00Z');
		DELETE FROM module_records WHERE module = 'Buzon' AND id = 'BZ-N';`); err != nil {
		return fmt.Errorf("norte: %w", err)
	}
	batch := &pgx.Batch{}
	for _, user := range []string{"multi", "solo", "reader"} {
		var b [32]byte
		_, _ = rand.Read(b[:])
		tokens[user] = hex.EncodeToString(b[:])
		batch.Queue(`INSERT INTO sessions (token_hash, username, expires_at) VALUES ($1, $2, $3)`,
			infrastructure.HashToken(tokens[user]), user, t0.Add(8*time.Hour))
	}
	return conn.SendBatch(ctx, batch).Close()
}

func start(t *testing.T) string {
	t.Helper()
	return apitest.Start(t, scratch, t0)
}

func get(t *testing.T, base, path, user string, headers map[string]string) (int, string) {
	t.Helper()
	return apitest.Get(t, base, path, tokens[user], headers)
}

func expect(t *testing.T, label string, gotStatus int, gotBody string, status int, body string) {
	t.Helper()
	if gotStatus != status || gotBody != body {
		t.Errorf("%s\n got  %d %s\n want %d %s", label, gotStatus, gotBody, status, body)
	}
}

var deletedAt = regexp.MustCompile(`"operation":"DELETE","actor":"semilla","at":"\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ"`)

var norte = map[string]string{"X-SIPGES-Scope": "ACME/NORTE"}

const (
	missing = `{"detail":"Registro no encontrado"}`
	unknown = `{"detail":"Módulo no válido"}`
	zero    = `"actores":0,"directorio":0,"demandas":0,"narrativas":0`
)

func TestReadsOnlyTheResolvedTenantsRecords(t *testing.T) {
	base := start(t)
	for _, c := range []struct {
		path, user string
		headers    map[string]string
		status     int
		body       string
	}{
		{"/api/buzon", "solo", nil, 200, `[{"2":1,"Asunto":"Sechura revisado","_id":"BZ-1","_updated_at":"2026-01-04T00:00:00Z"},{"Asunto":"Reservado","_id":"BZ-R","_updated_at":"2026-01-02T00:00:00Z"}]`},
		{"/api/buzon", "multi", norte, 200, `[{"Asunto":"Norte secreto","_id":"BZ-1","_updated_at":"2026-02-01T00:00:00Z"}]`},
		{"/api/buzon/BZ-1", "solo", nil, 200, `{"2":1,"Asunto":"Sechura revisado","_id":"BZ-1"}`},
		{"/api/buzon/BZ-1", "multi", norte, 200, `{"Asunto":"Norte secreto","_id":"BZ-1"}`},
		// Norte's deleted record and its history never reach Sechura.
		{"/api/buzon/BZ-N", "solo", nil, 404, missing},
		{"/api/buzon/BZ-N/history", "solo", nil, 404, missing},
		{"/api/buzon/BZ-N/history", "multi", norte, 200, `[` +
			`{"version":2,"operation":"DELETE","actor":"semilla","at":"@","payload":null,"changes":[{"field":"Asunto","before":"Solo del norte"}]},` +
			`{"version":1,"operation":"CREATE","actor":"semilla","at":"2026-02-02T00:00:00Z","payload":{"Asunto":"Solo del norte"},"changes":[{"field":"Asunto","after":"Solo del norte"}]}]`},
		{"/api/buzon/BZ-1/history", "solo", nil, 200, `[` +
			`{"version":2,"operation":"UPDATE","actor":"semilla","at":"2026-01-04T00:00:00Z","payload":{"2":1,"Asunto":"Sechura revisado"},"changes":[{"field":"Asunto","before":"Sechura","after":"Sechura revisado"},{"field":"Territorio","before":"Sechura"}]},` +
			`{"version":1,"operation":"CREATE","actor":"semilla","at":"2026-01-01T00:00:00Z","payload":{"2":1,"Asunto":"Sechura","Territorio":"Sechura"},"changes":[{"field":"2","after":1},{"field":"Asunto","after":"Sechura"},{"field":"Territorio","after":"Sechura"}]}]`},
		{"/api/buzon/BZ-1/history", "multi", norte, 200, `[{"version":1,"operation":"CREATE","actor":"semilla","at":"2026-02-01T00:00:00Z","payload":{"Asunto":"Norte secreto"},"changes":[{"field":"Asunto","after":"Norte secreto"}]}]`},
		{"/api/registros/summary", "solo", nil, 200, `{"counts":{"eventos":0,` + zero + `,"fuentes":1,"buzon":2},"rows":[` +
			`{"module":"fuentes","id":"F-1","title":"acta.pdf","territory":"","date":"","verification":"A","validation":"","updated_at":"2026-01-03T00:00:00Z"},` +
			`{"module":"buzon","id":"BZ-1","title":"Sechura revisado","territory":"","date":"","verification":null,"validation":"","updated_at":"2026-01-04T00:00:00Z"},` +
			`{"module":"buzon","id":"BZ-R","title":"Reservado","territory":"","date":"","verification":null,"validation":"","updated_at":"2026-01-02T00:00:00Z"}]}`},
		{"/api/registros/summary", "multi", norte, 200, `{"counts":{"eventos":0,` + zero + `,"fuentes":0,"buzon":1},"rows":[` +
			`{"module":"buzon","id":"BZ-1","title":"Norte secreto","territory":"","date":"","verification":null,"validation":"","updated_at":"2026-02-01T00:00:00Z"}]}`},
		{"/api/registros/summary?q=norte", "solo", nil, 200, `{"counts":{"eventos":0,` + zero + `,"fuentes":0,"buzon":0},"rows":[]}`},
	} {
		status, body := get(t, base, c.path, c.user, c.headers)
		// The DELETE version is stamped by clock_timestamp(), not by the seed.
		body = deletedAt.ReplaceAllString(body, `"operation":"DELETE","actor":"semilla","at":"@"`)
		expect(t, c.path+" "+c.user, status, body, c.status, c.body)
	}
}

func TestTheReadOnlyRoleNeverSeesRestrictedRecords(t *testing.T) {
	base := start(t)
	for _, c := range []struct{ path, status, body string }{
		{"/api/buzon", "200", `[{"2":1,"Asunto":"Sechura revisado","_id":"BZ-1","_updated_at":"2026-01-04T00:00:00Z"}]`},
		{"/api/buzon/BZ-R", "404", missing},
		{"/api/buzon/BZ-R/history", "404", missing},
		{"/api/registros/summary?q=reservado", "200", `{"counts":{"eventos":0,` + zero + `,"fuentes":0,"buzon":0},"rows":[]}`},
	} {
		status, body := get(t, base, c.path, "reader", nil)
		expect(t, c.path, status, body, map[string]int{"200": 200, "404": 404}[c.status], c.body)
	}
	// The analyst's full clearance reads it.
	status, body := get(t, base, "/api/buzon/BZ-R", "solo", nil)
	expect(t, "analyst", status, body, 200, `{"Asunto":"Reservado","_id":"BZ-R"}`)
}

func TestRefusesRequestsOutsideTheScopeAndInvalidQueries(t *testing.T) {
	base := start(t)
	intParsing := func(name string) string {
		return `{"detail":[{"type":"int_parsing","loc":["query","` + name + `"],"msg":"Input should be a valid integer, unable to parse string as an integer"}]}`
	}
	for _, c := range []struct {
		path, user string
		headers    map[string]string
		status     int
		body       string
	}{
		{"/api/buzon", "", nil, 401, `{"detail":"Inicie sesión para acceder a SIPGES"}`},
		{"/api/buzon", "solo", norte, 403, `{"detail":"Seleccione un proyecto autorizado mediante X-SIPGES-Scope o /select-project","projects":["SIPGES/PRJ-SECHURA"]}`},
		{"/api/buzon/BZ-1?project_id=NORTE", "solo", nil, 403, `{"detail":"Proyecto fuera de alcance"}`},
		{"/api/registros/summary", "multi", nil, 403, `{"detail":"Seleccione un proyecto autorizado mediante X-SIPGES-Scope o /select-project","projects":["ACME/NORTE","SIPGES/PRJ-SECHURA"]}`},
		{"/api/usuarios", "reader", nil, 403, `{"detail":"Acceso administrativo requerido"}`},
		{"/api/nada?limit=x", "solo", nil, 404, unknown},
		{"/api/registros", "solo", nil, 404, unknown},
		{"/api/buzon?limit=x", "solo", nil, 422, intParsing("limit")},
		{"/api/registros/summary?offset=1.5", "solo", nil, 422, intParsing("offset")},
		{"/api/buzon?offset=-1", "solo", nil, 422, `{"detail":"offset debe ser un entero no negativo"}`},
		{"/api/buzon?offset=9007199254740992", "solo", nil, 422, `{"detail":"offset debe ser un entero no negativo"}`},
		{"/api/buzon?limit=1&offset=1", "solo", nil, 200, `[{"Asunto":"Reservado","_id":"BZ-R","_updated_at":"2026-01-02T00:00:00Z"}]`},
		{"/api/buzon/" + strings.Repeat("x", 201), "solo", nil, 404, missing},
		{"/api/buzon/", "solo", nil, 404, `{"detail":"Not Found"}`},
	} {
		status, body := get(t, base, c.path, c.user, c.headers)
		expect(t, c.path+" "+c.user, status, body, c.status, c.body)
	}
}
