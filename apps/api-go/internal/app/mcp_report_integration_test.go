package app_test

import (
	"encoding/json"
	"net/http"
	"strings"
	"testing"
	"time"
)

// report_period against PostgreSQL (odd/tasks/reporting-mcp.md S7–S9): period words become Lima days
// in code, the answer names the range, and only what the guard lets through is counted.
func TestMCPReportPeriod(t *testing.T) {
	mcpSeed(t)
	t.Setenv("SIPGES_DATA_KEY", dataKey)
	s := start(t, false)
	// 10:00 in Lima on Sunday 15 March 2026.
	s.clock.set(time.Date(2026, 3, 15, 15, 0, 0, 0, time.UTC))
	for _, c := range []struct{ name, args, want string }{
		{"este año, by month: the restricted C-5 and the undated are not counted", `{"module":"eventos","period":"este año","by":"mes"}`,
			`{"module":"eventos","period":{"label":"este año","from":"2026-01-01","to":"2026-12-31"},"group_by":null,"by":"mes",` +
				`"total":2,"truncated":false,"groups":[],"series":[{"period":"2026-01","count":1},{"period":"2026-03","count":1}]}`},
		{"este mes, grouped", `{"module":"eventos","period":"Este Mes","group_by":"Tipo_Evento"}`,
			`{"module":"eventos","period":{"label":"este mes","from":"2026-03-01","to":"2026-03-31"},"group_by":"Tipo_Evento","by":null,` +
				`"total":1,"truncated":false,"groups":[{"value":"Asamblea","count":1}],"series":[]}`},
		{"año pasado, by day", `{"module":"eventos","period":"año pasado","by":"dia"}`,
			`{"module":"eventos","period":{"label":"año pasado","from":"2025-01-01","to":"2025-12-31"},"group_by":null,"by":"dia",` +
				`"total":1,"truncated":false,"groups":[],"series":[{"period":"2025-12-31","count":1}]}`},
		{"hoy has nothing", `{"module":"eventos","period":"hoy"}`,
			`{"module":"eventos","period":{"label":"hoy","from":"2026-03-15","to":"2026-03-15"},"group_by":null,"by":null,` +
				`"total":0,"truncated":false,"groups":[],"series":[]}`},
		{"explicit dates, as count_records takes them", `{"module":"eventos","from":"2026-01","to":"2026-02"}`,
			`{"module":"eventos","period":{"label":"2026-01 a 2026-02","from":"2026-01-01","to":"2026-02-31"},"group_by":null,"by":null,` +
				`"total":1,"truncated":false,"groups":[],"series":[]}`},
		{"a blank format is json, as every blank argument is empty", `{"module":"eventos","period":"hoy","format":"  "}`,
			`{"module":"eventos","period":{"label":"hoy","from":"2026-03-15","to":"2026-03-15"},"group_by":null,"by":null,` +
				`"total":0,"truncated":false,"groups":[],"series":[]}`},
		{"no period is the whole record", `{"module":"actores","group_by":"Tipo_Actor"}`,
			`{"module":"actores","period":null,"group_by":"Tipo_Actor","by":null,` +
				`"total":1,"truncated":false,"groups":[{"value":"comunidad","count":1}],"series":[]}`},
	} {
		if text, isError := tool(t, s, mcpCounts, "report_period", c.args); isError || text != c.want {
			t.Errorf("%s: %v\n got %s\nwant %s", c.name, isError, text, c.want)
		}
	}
	before := mcpEgressRows(t, "MCP/CNT")
	for args, want := range map[string]string{
		`{"module":"otro","period":"hoy"}`:                         "Módulo no válido",
		`{"module":"eventos","period":"mañana"}`:                   "Período no válido: use hoy, ayer, esta semana, (la) semana pasada, este mes, (el) mes pasado, este año, (el) año pasado, (los) últimos N días (1 a 366)",
		`{"module":"eventos","period":"hoy","from":"2026"}`:        "Use un período o fechas, no ambos",
		`{"module":"eventos","group_by":"Tipo_Evento","by":"mes"}`: "Use group_by o by, no ambos",
		`{"module":"eventos","by":"semana"}`:                       "by debe ser «dia» o «mes»",
		`{"module":"actores","period":"este mes"}`:                 "El tipo de objeto actores no tiene campo de fecha",
		`{"module":"actores","by":"mes"}`:                          "El tipo de objeto actores no tiene campo de fecha",
		`{"module":"eventos","group_by":"Descripcion_Hecho"}`:      "No se puede agrupar por «Descripcion_Hecho»: solo campos de lista cerrada, códigos, fechas o números",
		`{"module":"eventos","from":"2026-13"}`:                    "Fechas no válidas: use AAAA, AAAA-MM o AAAA-MM-DD",
		`{"module":"eventos","period":"hoy","format":"pdf"}`:       "format debe ser «json» o «csv»",
	} {
		if text, isError := tool(t, s, mcpCounts, "report_period", args); !isError || text != want {
			t.Errorf("%s: %v %s", args, isError, text)
		}
	}
	if got := mcpEgressRows(t, "MCP/CNT"); got != before {
		t.Errorf("%d access-log rows for refused reports", got-before)
	}
	if _, isError := tool(t, s, mcpCounts, "report_period", `{"module":"eventos","period":"este año"}`); isError {
		t.Fatal("a report was refused")
	}
	if got := mcpEgressRows(t, "MCP/CNT"); got != before+1 {
		t.Errorf("%d access-log rows after one report", got-before)
	}
}

// The tool is listed to read keys, and refused like every read while external AI is off.
func TestMCPReportPeriodIsListedAndGuarded(t *testing.T) {
	mcpSeed(t)
	t.Setenv("SIPGES_DATA_KEY", dataKey)
	s := start(t, false)
	got := s.do(t, req{method: http.MethodPost, path: "/mcp", headers: map[string]string{"Authorization": "Bearer " + mcpCounts},
		body: `{"jsonrpc":"2.0","id":1,"method":"tools/list"}`})
	if !strings.Contains(got.body, `"name":"report_period"`) || !strings.Contains(got.body, `"readOnlyHint":true`) {
		t.Fatalf("tools/list: %s", got.body)
	}
	if text, isError := tool(t, s, mcpOff, "report_period", `{"module":"eventos","period":"hoy"}`); !isError || text != disabled {
		t.Errorf("switch off: %v %s", isError, text)
	}
}

// format «csv» adds the same rows as CSV text, with a header and the total, ready to save: a byte
// order mark and CRLF so a spreadsheet opens it in UTF-8 (odd/tasks/reporting-mcp.md S6, T8).
func TestMCPReportPeriodAsCSV(t *testing.T) {
	mcpSeed(t)
	t.Setenv("SIPGES_DATA_KEY", dataKey)
	s := start(t, false)
	s.clock.set(time.Date(2026, 3, 15, 15, 0, 0, 0, time.UTC))
	csvOf := func(args string) string {
		t.Helper()
		text, isError := tool(t, s, mcpCounts, "report_period", args)
		if isError {
			t.Fatalf("%s: %s", args, text)
		}
		var answer struct {
			CSV *string `json:"csv"`
		}
		if err := json.Unmarshal([]byte(text), &answer); err != nil || answer.CSV == nil {
			t.Fatalf("%s: no csv in %s", args, text)
		}
		return *answer.CSV
	}
	const bom = "\uFEFF"
	for args, want := range map[string]string{
		`{"module":"eventos","group_by":"Tipo_Evento","format":"csv"}`:       bom + "Tipo_Evento,cantidad\r\nAsamblea,2\r\nBloqueo,1\r\nParo,1\r\n(sin valor),1\r\nTotal,5\r\n",
		`{"module":"eventos","period":"este año","by":"mes","format":"CSV"}`: bom + "mes,cantidad\r\n2026-01,1\r\n2026-03,1\r\nTotal,2\r\n",
		`{"module":"eventos","period":"hoy","format":"csv"}`:                 bom + "Total\r\n0\r\n",
	} {
		if got := csvOf(args); got != want {
			t.Errorf("%s:\n got %q\nwant %q", args, got, want)
		}
	}
	if text, _ := tool(t, s, mcpCounts, "report_period", `{"module":"eventos","period":"hoy"}`); strings.Contains(text, `"csv"`) {
		t.Errorf("json carries a csv: %s", text)
	}
}
