//nolint:misspell // Spanish record fields and messages, verbatim from the TypeScript API.
package app_test

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5"

	"github.com/Dreamcoder08/sipges/apps/api-go/internal/platform/database/dbtest"
)

// The MCP tools against PostgreSQL under row-level security, ported from
// apps/api/test/privacy/mcp-egress.test.ts: another project's rows and `restringido` records never
// reach an answer, and with the switch off no tool answers any data. Every key and row is
// synthetic.

const disabled = "El envío a IA externa está desactivado para este proyecto"

func mcpSecret(letter string) string { return strings.Repeat(letter, 43) }

func mcpKey(prefix, letter string) string { return "mscli_" + prefix + "_" + mcpSecret(letter) }

var (
	mcpFull    = mcpKey("c0ffee44a001", "a")
	mcpLimited = mcpKey("c0ffee44a002", "b")
	mcpOtro    = mcpKey("c0ffee44b001", "c")
	mcpOff     = mcpKey("c0ffee44c001", "d")
	mcpWrite   = mcpKey("c0ffee44a003", "e")
	mcpCounts  = mcpKey("c0ffee44d001", "f")
)

func mcpSeed(t *testing.T) {
	t.Helper()
	if scratch == nil {
		t.Skip(dbtest.EnvAdminURL + " is not set")
	}
	conn, err := pgx.Connect(t.Context(), scratch.URL)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = conn.Close(context.Background()) }()
	hash := func(letter string) string {
		sum := sha256.Sum256([]byte(mcpSecret(letter)))
		return hex.EncodeToString(sum[:])
	}
	key := func(id int, tenant, name, prefix, letter, access, clearance string) string {
		return fmt.Sprintf(`(%d, '%s', '%s', '%s', '%s', '%s', '%s', 'test', now())`,
			id, tenant, name, prefix, hash(letter), access, clearance)
	}
	if _, err := conn.Exec(t.Context(), `
		INSERT INTO tenants (company_id, project_id, label) VALUES
		  ('MCP','UNO','Uno'), ('MCP','DOS','Dos'), ('MCP','OFF','Apagado'), ('MCP','CNT','Conteos')
		  ON CONFLICT DO NOTHING;
		INSERT INTO project_settings (tenant_id, settings, updated_by, updated_at) VALUES
		  ('MCP/UNO', '{"externalAi":{"enabled":true}}', 'test', now()),
		  ('MCP/DOS', '{"externalAi":{"enabled":true}}', 'test', now()),
		  ('MCP/CNT', '{"externalAi":{"enabled":true}}', 'test', now())
		  ON CONFLICT DO NOTHING;
		INSERT INTO module_records (tenant_id, module, id, payload, created_at, updated_at, marking) VALUES
		  ('MCP/UNO', 'Actores', 'A-1',
		   '{"Nombre_Actor/Organizacion":"Comunidad Abierta","Territorio":"Sechura","Observaciones":"probetaoculta"}',
		   now(), now(), 'interno'),
		  ('MCP/UNO', 'Actores', 'A-2', '{"Nombre_Actor/Organizacion":"Frente Reservado","Territorio":"Sechura"}',
		   now(), now(), 'restringido'),
		  ('MCP/UNO', 'Eventos', 'E-1', '{"Fecha":"2026-10-01","Descripcion_Hecho":"Asamblea comun","Actor_Principal":"A-2"}',
		   now(), now(), 'interno'),
		  ('MCP/UNO', 'Eventos', 'E-2', '{"Fecha":"2026-10-02","Descripcion_Hecho":"Asamblea Reservada"}',
		   now(), now(), 'restringido'),
		  ('MCP/DOS', 'Actores', 'A-1', '{"Nombre_Actor/Organizacion":"Comunidad AJENA","Territorio":"AJENA"}',
		   now(), now(), 'interno'),
		  ('MCP/DOS', 'Eventos', 'E-9', '{"Fecha":"2026-10-03","Descripcion_Hecho":"Asamblea AJENA"}',
		   now(), now(), 'interno'),
		  ('MCP/OFF', 'Actores', 'A-1', '{"Nombre_Actor/Organizacion":"Comunidad Apagada"}',
		   now(), now(), 'interno'),
		  ('MCP/CNT', 'Eventos', 'C-1', '{"Fecha":"2026-01-15","Tipo_Evento":"Asamblea","Descripcion_Hecho":"Uno"}',
		   now(), now(), 'interno'),
		  ('MCP/CNT', 'Eventos', 'C-2', '{"Fecha":"2026-03-02T10:00:00","Tipo_Evento":"Asamblea"}',
		   now(), now(), 'interno'),
		  ('MCP/CNT', 'Eventos', 'C-3', '{"Fecha":"2025-12-31","Tipo_Evento":"Paro"}',
		   now(), now(), 'publico'),
		  ('MCP/CNT', 'Eventos', 'C-4', '{"Tipo_Evento":"  "}', now(), now(), 'interno'),
		  ('MCP/CNT', 'Eventos', 'C-5', '{"Fecha":"2026-02-10","Tipo_Evento":"Reservado"}',
		   now(), now(), 'restringido'),
		  ('MCP/CNT', 'Eventos', 'C-6', '{"Fecha":"sin fecha","Tipo_Evento":"Bloqueo"}',
		   now(), now(), 'interno'),
		  ('MCP/CNT', 'Actores', 'A-1', '{"Nombre_Actor/Organizacion":"Comunidad Contada","Tipo_Actor":"comunidad"}',
		   now(), now(), 'interno')
		  ON CONFLICT DO NOTHING;
		INSERT INTO record_links (tenant_id, link_type, source_module, source_id, target_module, target_id,
		  note, created_by, created_at) VALUES
		  ('MCP/UNO', 'relacionado_con', 'Actores', 'A-1', 'Actores', 'A-2', '', 'test', now())
		  ON CONFLICT DO NOTHING;
		INSERT INTO api_keys (id, tenant_id, name, prefix, secret_hash, access, clearance, created_by, created_at)
		  OVERRIDING SYSTEM VALUE VALUES `+strings.Join([]string{
		key(44001, "MCP/UNO", "total", "c0ffee44a001", "a", "read", "full"),
		key(44002, "MCP/UNO", "limitada", "c0ffee44a002", "b", "read", "limited"),
		key(44003, "MCP/DOS", "otra", "c0ffee44b001", "c", "write", "full"),
		key(44004, "MCP/OFF", "apagada", "c0ffee44c001", "d", "read", "full"),
		key(44005, "MCP/UNO", "escritura", "c0ffee44a003", "e", "write", "full"),
		key(44006, "MCP/CNT", "conteos", "c0ffee44d001", "f", "read", "full"),
	}, ",")+` ON CONFLICT DO NOTHING`); err != nil {
		t.Fatal(err)
	}
}

// tool calls a tool and gives the text of its first content item with isError.
func tool(t *testing.T, s *server, token, name, args string) (string, bool) {
	t.Helper()
	got := s.do(t, req{method: http.MethodPost, path: "/mcp", headers: map[string]string{"Authorization": "Bearer " + token},
		body: `{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"` + name + `","arguments":` + args + `}}`})
	var answer struct {
		Result struct {
			Content []struct {
				Text string `json:"text"`
			} `json:"content"`
			IsError bool `json:"isError"`
		} `json:"result"`
	}
	if err := json.Unmarshal([]byte(got.body), &answer); err != nil || len(answer.Result.Content) != 1 {
		t.Fatalf("%s: %d %s", name, got.status, got.body)
	}
	return answer.Result.Content[0].Text, answer.Result.IsError
}

var mcpReads = [][2]string{
	{"search_records", `{"query":"comunidad"}`},
	{"search_records", `{"query":"asamblea"}`},
	{"get_record", `{"module":"actores","id":"A-1"}`},
	{"get_record", `{"module":"actores","id":"A-2"}`},
	{"get_links", `{"module":"actores","id":"A-1"}`},
	{"get_links", `{"module":"actores","id":"A-2"}`},
	{"get_timeline", `{"from":"2026"}`},
	{"get_briefing", `{"module":"actores","id":"A-1"}`},
	{"get_briefing", `{"module":"actores","id":"A-2"}`},
	{"get_briefing", `{"module":"eventos","id":"E-1"}`},
	{"count_records", `{"module":"eventos","group_by":"Territorio","from":"2026"}`},
}

func mcpEgressRows(t *testing.T, tenant string) int {
	t.Helper()
	conn, err := pgx.Connect(t.Context(), scratch.URL)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = conn.Close(context.Background()) }()
	var n int
	if err := conn.QueryRow(t.Context(), `SELECT count(*) FROM audit WHERE tenant_id = $1 AND detail LIKE 'canal mcp%'`, tenant).Scan(&n); err != nil {
		t.Fatal(err)
	}
	return n
}

func TestMCPToolsNeverShowAnotherProjectOrARestrictedRecord(t *testing.T) {
	mcpSeed(t)
	t.Setenv("SIPGES_DATA_KEY", dataKey)
	s := start(t, false)
	for _, token := range []string{mcpFull, mcpLimited} {
		for _, read := range mcpReads {
			text, _ := tool(t, s, token, read[0], read[1])
			for _, leak := range []string{"AJENA", "Frente Reservado", "Asamblea Reservada", "E-9", "E-2", "Comunidad Abierta", "probetaoculta"} {
				if strings.Contains(text, leak) {
					t.Errorf("%s %s holds %q: %s", read[0], read[1], leak, text)
				}
			}
		}
	}
	if text, isError := tool(t, s, mcpFull, "search_records", `{"query":"sechura"}`); isError || !strings.Contains(text, `"excerpt":"Sechura"`) {
		t.Errorf("a search with hits: %s", text)
	}
	// Only a stub of a restricted record leaves; its id is pseudonymised like any other text.
	withheld := func(text string) bool {
		return strings.HasPrefix(text, `{"module":"actores","id":"`) && strings.HasSuffix(text, `","withheld":true}`)
	}
	text, isError := tool(t, s, mcpFull, "get_record", `{"module":"actores","id":"A-2"}`)
	if isError || !withheld(text) {
		t.Errorf("a restricted record with full clearance: %s", text)
	}
	if text, isError = tool(t, s, mcpLimited, "get_record", `{"module":"actores","id":"A-2"}`); !isError || text != "Registro no encontrado" {
		t.Errorf("a restricted record with limited clearance: %s", text)
	}
	if text, _ = tool(t, s, mcpFull, "get_links", `{"module":"actores","id":"A-2"}`); !withheld(text) {
		t.Errorf("the links of a restricted record: %s", text)
	}
	if text, _ = tool(t, s, mcpFull, "get_briefing", `{"module":"actores","id":"A-2"}`); !withheld(text) {
		t.Errorf("the briefing of a restricted record: %s", text)
	}
	if text, _ = tool(t, s, mcpOtro, "get_record", `{"module":"eventos","id":"E-1"}`); text != "Registro no encontrado" {
		t.Errorf("a record of another project: %s", text)
	}
	if text, _ = tool(t, s, mcpOtro, "search_records", `{"query":"sechura"}`); text != `{"hits":[]}` {
		t.Errorf("a search of another project's words: %s", text)
	}
}

func TestMCPSearchHidesWhatADroppedFieldHolds(t *testing.T) {
	mcpSeed(t)
	t.Setenv("SIPGES_DATA_KEY", dataKey)
	s := start(t, false)
	for _, query := range []string{"probetaoculta", "comunidad probetaoculta"} {
		if text, _ := tool(t, s, mcpFull, "search_records", `{"query":"`+query+`"}`); text != `{"hits":[]}` {
			t.Errorf("%s: %s", query, text)
		}
	}
}

func TestMCPReadToolsAnswerNoDataWithTheSwitchOff(t *testing.T) {
	mcpSeed(t)
	t.Setenv("SIPGES_DATA_KEY", dataKey)
	s := start(t, false)
	before := mcpEgressRows(t, "MCP/OFF")
	for _, read := range mcpReads {
		if text, isError := tool(t, s, mcpOff, read[0], read[1]); !isError || text != disabled {
			t.Errorf("%s: %v %s", read[0], isError, text)
		}
	}
	if got := mcpEgressRows(t, "MCP/OFF"); got != before {
		t.Errorf("%d access-log rows for a refused read", got-before)
	}
	if text, isError := tool(t, s, mcpOff, "list_object_types", `{}`); isError || !strings.Contains(text, "object_types") {
		t.Errorf("the catalogue: %s", text)
	}
}

func TestMCPLogsEveryReleaseBeforeAnswering(t *testing.T) {
	mcpSeed(t)
	t.Setenv("SIPGES_DATA_KEY", dataKey)
	s := start(t, false)
	before := mcpEgressRows(t, "MCP/UNO")
	if text, isError := tool(t, s, mcpFull, "get_record", `{"module":"actores","id":"A-1"}`); isError {
		t.Fatal(text)
	}
	if got := mcpEgressRows(t, "MCP/UNO"); got != before+1 {
		t.Errorf("%d rows after one read", got-before)
	}
	// A refusal releases nothing.
	if text, isError := tool(t, s, mcpFull, "get_links", `{"module":"actores","id":"NADA"}`); !isError || text != "Registro no encontrado" {
		t.Fatal(text)
	}
	if got := mcpEgressRows(t, "MCP/UNO"); got != before+1 {
		t.Errorf("%d rows after a refused read", got-before)
	}
}

func TestMCPReadToolsAreRefusedWithoutADataKey(t *testing.T) {
	mcpSeed(t)
	t.Setenv("SIPGES_DATA_KEY", "") // restores it after the test
	if err := os.Unsetenv("SIPGES_DATA_KEY"); err != nil {
		t.Fatal(err)
	}
	s := start(t, false)
	for _, read := range mcpReads {
		if text, isError := tool(t, s, mcpFull, read[0], read[1]); !isError || text != disabled {
			t.Errorf("%s: %v %s", read[0], isError, text)
		}
	}
}

// count_records against PostgreSQL: the total, the groups and the date bounds count only what the
// guard lets through, and every refusal keeps its fixed wording (odd/tasks/reporting-mcp.md S3, S4).
func TestMCPCountRecords(t *testing.T) {
	mcpSeed(t)
	t.Setenv("SIPGES_DATA_KEY", dataKey)
	s := start(t, false)
	for _, c := range []struct{ name, args, want string }{
		{"total without group_by", `{"module":"eventos"}`,
			`{"module":"eventos","group_by":null,"from":null,"to":null,"total":5,"truncated":false,"groups":[]}`},
		{"grouped, largest first, null last", `{"module":"eventos","group_by":"Tipo_Evento"}`,
			`{"module":"eventos","group_by":"Tipo_Evento","from":null,"to":null,"total":5,"truncated":false,` +
				`"groups":[{"value":"Asamblea","count":2},{"value":"Bloqueo","count":1},{"value":"Paro","count":1},{"value":null,"count":1}]}`},
		{"dates bound the count", `{"module":"eventos","group_by":"Tipo_Evento","from":"2026","to":"2026-02"}`,
			`{"module":"eventos","group_by":"Tipo_Evento","from":"2026-01-01","to":"2026-02-31","total":1,"truncated":false,` +
				`"groups":[{"value":"Asamblea","count":1}]}`},
		{"one date excludes undated records", `{"module":"eventos","from":"2026"}`,
			`{"module":"eventos","group_by":null,"from":"2026-01-01","to":null,"total":2,"truncated":false,"groups":[]}`},
		{"a padded field is the field", `{"module":"eventos","group_by":" Tipo_Evento "}`,
			`{"module":"eventos","group_by":"Tipo_Evento","from":null,"to":null,"total":5,"truncated":false,` +
				`"groups":[{"value":"Asamblea","count":2},{"value":"Bloqueo","count":1},{"value":"Paro","count":1},{"value":null,"count":1}]}`},
		{"blank arguments are empty", `{"module":"eventos","group_by":"  ","from":" ","to":"\t"}`,
			`{"module":"eventos","group_by":null,"from":null,"to":null,"total":5,"truncated":false,"groups":[]}`},
		{"an empty range", `{"module":"eventos","from":"2027","to":"2026"}`,
			`{"module":"eventos","group_by":null,"from":"2027-01-01","to":"2026-12-31","total":0,"truncated":false,"groups":[]}`},
	} {
		if text, isError := tool(t, s, mcpCounts, "count_records", c.args); isError || text != c.want {
			t.Errorf("%s: %v %s", c.name, isError, text)
		}
	}
	before := mcpEgressRows(t, "MCP/CNT")
	for args, want := range map[string]string{
		`{"module":"otro"}`:                                           "Módulo no válido",
		`{"module":"eventos","from":"2026-13"}`:                       "Fechas no válidas: use AAAA, AAAA-MM o AAAA-MM-DD",
		`{"module":"eventos","to":"ayer"}`:                            "Fechas no válidas: use AAAA, AAAA-MM o AAAA-MM-DD",
		`{"module":"actores","from":"2026"}`:                          "El tipo de objeto actores no tiene campo de fecha",
		`{"module":"actores","group_by":"Nombre_Actor/Organizacion"}`: "No se puede agrupar por «Nombre_Actor/Organizacion»: solo campos de lista cerrada, códigos, fechas o números",
		`{"module":"eventos","group_by":"Descripcion_Hecho"}`:         "No se puede agrupar por «Descripcion_Hecho»: solo campos de lista cerrada, códigos, fechas o números",
		`{"module":"eventos","group_by":"Actor_Principal"}`:           "No se puede agrupar por «Actor_Principal»: solo campos de lista cerrada, códigos, fechas o números",
		`{"module":"actores","group_by":"Observaciones"}`:             "No se puede agrupar por «Observaciones»: solo campos de lista cerrada, códigos, fechas o números",
	} {
		if text, isError := tool(t, s, mcpCounts, "count_records", args); !isError || text != want {
			t.Errorf("%s: %v %s", args, isError, text)
		}
	}
	if got := mcpEgressRows(t, "MCP/CNT"); got != before {
		t.Errorf("%d access-log rows for refused counts", got-before)
	}
	if text, isError := tool(t, s, mcpCounts, "count_records", `{"module":"actores","group_by":"Tipo_Actor"}`); isError ||
		text != `{"module":"actores","group_by":"Tipo_Actor","from":null,"to":null,"total":1,"truncated":false,"groups":[{"value":"comunidad","count":1}]}` {
		t.Errorf("a closed-list field of actores: %s", text)
	}
	if got := mcpEgressRows(t, "MCP/CNT"); got != before+1 {
		t.Errorf("%d access-log rows after one count", got-before)
	}
}

func mcpCount(t *testing.T, query string) int {
	t.Helper()
	conn, err := pgx.Connect(t.Context(), scratch.URL)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = conn.Close(context.Background()) }()
	var n int
	if err := conn.QueryRow(t.Context(), query).Scan(&n); err != nil {
		t.Fatal(err)
	}
	return n
}

func TestMCPCreateRecordWritesInTheKeysProjectAsTheKey(t *testing.T) {
	mcpSeed(t)
	s := start(t, false) // no SIPGES_DATA_KEY: a write takes nothing out, so it needs no guard
	text, isError := tool(t, s, mcpWrite, "create_record",
		`{"module":"demandas","payload":{"ID_Demanda":"D-77","Descripcion":"Agua sintética","__proto__":"x"}}`)
	if isError || text != `{"module":"demandas","id":"D-77"}` {
		t.Fatalf("%v %s", isError, text)
	}
	if n := mcpCount(t, `SELECT count(*) FROM module_records WHERE tenant_id = 'MCP/UNO' AND module = 'Demandas' AND id = 'D-77'
	      AND payload->>'Descripcion' = 'Agua sintética' AND payload->>'Proyecto_ID' = 'UNO' AND NOT payload ? '__proto__'`); n != 1 {
		t.Error("the stored record differs")
	}
	if n := mcpCount(t, `SELECT count(*) FROM record_versions WHERE tenant_id = 'MCP/UNO' AND record_id = 'D-77' AND actor = 'api:escritura'`); n != 1 {
		t.Error("the history does not name the key")
	}
	if n := mcpCount(t, `SELECT count(*) FROM audit WHERE tenant_id = 'MCP/UNO' AND record_id = 'D-77' AND action = 'CREATE'`); n != 1 {
		t.Error("no audit entry")
	}
}

func TestMCPCreateRecordRefusals(t *testing.T) {
	mcpSeed(t)
	s := start(t, false)
	for args, want := range map[string]string{
		`{"module":"otro","payload":{}}`:                         "Módulo no válido",
		`{"module":"demandas","payload":{"Proyecto_ID":"OTRO"}}`: "No se permite escribir en otro proyecto",
		`{"module":"demandas","payload":{"project_id":"OTRO"}}`:  "No se permite escribir en otro proyecto",
	} {
		if text, isError := tool(t, s, mcpWrite, "create_record", args); !isError || text != want {
			t.Errorf("%s: %v %s", args, isError, text)
		}
	}
	if n := mcpCount(t, `SELECT count(*) FROM module_records WHERE tenant_id = 'MCP/UNO' AND module = 'Demandas' AND id <> 'D-77'`); n != 0 {
		t.Errorf("%d records from refused calls", n)
	}
	// A read key does not see the tool.
	got := s.do(t, req{method: http.MethodPost, path: "/mcp", headers: map[string]string{"Authorization": "Bearer " + mcpFull},
		body: `{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"create_record","arguments":{}}}`})
	if !strings.Contains(got.body, `"code":-32602`) {
		t.Errorf("a read key: %s", got.body)
	}
}

func TestMCPLinkRecordsWritesAsTheKey(t *testing.T) {
	mcpSeed(t)
	s := start(t, false)
	args := `{"link_type":"relacionado_con","source":{"module":"actores","id":"A-1"},"target":{"module":"eventos","id":"E-1"},"note":"  con nota  "}`
	text, isError := tool(t, s, mcpWrite, "link_records", args)
	if isError || !strings.HasPrefix(text, `{"id":`) {
		t.Fatalf("%v %s", isError, text)
	}
	if n := mcpCount(t, `SELECT count(*) FROM record_links WHERE tenant_id = 'MCP/UNO' AND link_type = 'relacionado_con'
	      AND target_id = 'E-1' AND note = 'con nota' AND created_by = 'api:escritura'`); n != 1 {
		t.Error("the stored link differs")
	}
	for name, want := range map[string]string{
		args: "Vínculo rechazado: duplicate",
		`{"link_type":"relacionado_con","source":{"module":"actores","id":"A-1"},"target":{"module":"actores","id":"A-1"}}`: "Vínculo rechazado: self_link",
		`{"link_type":"nada","source":{"module":"actores","id":"A-1"},"target":{"module":"eventos","id":"E-1"}}`:            "Vínculo rechazado: unknown_type",
		`{"link_type":"relacionado_con","source":{"module":"actores","id":"A-1"},"target":{"module":"eventos","id":"E-9"}}`: "Vínculo rechazado: missing",
	} {
		if text, isError := tool(t, s, mcpWrite, "link_records", name); !isError || text != want {
			t.Errorf("%s: %v %s", name, isError, text)
		}
	}
}
