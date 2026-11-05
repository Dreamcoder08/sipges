package app_test

import (
	"bufio"
	"context"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5"
)

// maxBody mirrors httpx.MaxRequestBody: TypeScript has no global limit, so this one is SIPGES Go's.
const maxBody = 16 << 20

const bodyTooLarge = `{"detail":"Cuerpo demasiado grande"}`

// sendBody posts a body with a declared Content-Length, or chunked when chunked is set.
func (s *server) sendBody(t *testing.T, path, user, contentType, body string, chunked bool, headers ...string) reply {
	t.Helper()
	var payload io.Reader = strings.NewReader(body)
	if chunked {
		payload = struct{ io.Reader }{payload} // hides the length from the client
	}
	r, err := http.NewRequestWithContext(t.Context(), http.MethodPost, s.url+path, payload)
	if err != nil {
		t.Fatal(err)
	}
	r.Header.Set("Origin", s.url)
	r.Header.Set("Content-Type", contentType)
	if user != "" {
		r.Header.Set("Cookie", "sipges_session="+tokens[user])
	}
	for i := 0; i+1 < len(headers); i += 2 {
		r.Header.Set(headers[i], headers[i+1])
	}
	res, err := http.DefaultClient.Do(r)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = res.Body.Close() }()
	got, _ := io.ReadAll(res.Body)
	return reply{res.StatusCode, string(got)}
}

func TestRefusesOversizeBodiesOnRoutesWithoutALimitOfTheirOwn(t *testing.T) {
	s := start(t, false)
	over := `{"project_id":"NORTE","x":"` + strings.Repeat("x", maxBody) + `"}`
	for _, path := range []string{"/system/import/hechos", "/system/irsa/config", "/system/graph/neighbourhood"} {
		for name, chunked := range map[string]bool{"declared": false, "chunked": true} {
			t.Run(path+" "+name, func(t *testing.T) {
				// 413 and not the scope's 403: the body is refused before the project check reads it.
				expect(t, s.sendBody(t, path, "solo", "application/json", over, chunked), http.StatusRequestEntityTooLarge, bodyTooLarge)
			})
		}
	}
	t.Run("a body of exactly the limit reaches the route", func(t *testing.T) {
		exact := `{"x":"` + strings.Repeat("x", maxBody-len(`{"x":""}`)) + `"}`
		for name, chunked := range map[string]bool{"declared": false, "chunked": true} {
			if got := s.sendBody(t, "/system/nothing-here", "solo", "application/json", exact, chunked); got.status != http.StatusNotFound {
				t.Fatalf("%s: status %d: %.200s", name, got.status, got.body)
			}
		}
	})
	t.Run("the session gate still answers first", func(t *testing.T) {
		if got := s.sendBody(t, "/system/import/hechos", "", "application/json", over, false); got.status != http.StatusUnauthorized {
			t.Fatalf("status %d: %.200s", got.status, got.body)
		}
	})
	t.Run("a smaller route limit keeps its own answer", func(t *testing.T) {
		expect(t, s.sendBody(t, "/system/geography/query", "solo", "application/json", over, false),
			http.StatusRequestEntityTooLarge, `{"detail":"Consulta demasiado extensa"}`)
	})
}

// Routes that bound the body themselves keep their limit and their answer past the global one.
func TestRoutesWithTheirOwnLimitIgnoreTheGlobalOne(t *testing.T) {
	t.Setenv("SIPGES_MAX_UPLOAD_BYTES", "20971520") // 20 MiB: over the global limit
	s := start(t, false)
	over := strings.Repeat("x", maxBody+1)
	formInvalid := `{"detail":[{"type":"value_error","loc":["body"],"msg":"Invalid form body"}]}`
	jsonInvalid := `{"detail":[{"type":"json_invalid","loc":["body"],"msg":"JSON decode error"}]}`

	t.Run("login", func(t *testing.T) {
		expect(t, s.sendBody(t, "/login", "", "application/x-www-form-urlencoded", "password="+over, false), http.StatusUnprocessableEntity, formInvalid)
	})
	t.Run("account creation", func(t *testing.T) {
		expect(t, s.sendBody(t, "/system/auth/accounts", "multi", "text/plain", over, false, "X-SIPGES-Scope", "SIPGES/PRJ-SECHURA"), http.StatusUnprocessableEntity, jsonInvalid)
	})
	for _, path := range []string{"/system/uploads", "/system/document-lab/analyze", "/system/document-lab/report.docx", "/system/document-lab/compare"} {
		t.Run(path, func(t *testing.T) {
			if got := s.sendBody(t, path, "solo", "text/plain", over, false); got.status == http.StatusRequestEntityTooLarge {
				t.Fatalf("a body under the route's own limit was refused: %s", got.body)
			}
		})
	}
}

// sendBrokenChunk posts a valid chunk followed by a bad size line: a read error with the client
// still connected for the answer.
func (s *server) sendBrokenChunk(t *testing.T, path, user, body string) reply {
	t.Helper()
	conn, err := net.Dial("tcp", s.addr)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = conn.Close() }()
	_, err = fmt.Fprintf(conn, "POST %s HTTP/1.1\r\nHost: %s\r\nOrigin: %s\r\nCookie: sipges_session=%s\r\n"+
		"X-SIPGES-Scope: SIPGES/PRJ-SECHURA\r\nContent-Type: application/json\r\nTransfer-Encoding: chunked\r\n\r\n%x\r\n%s\r\nZZ\r\n",
		path, s.addr, s.url, tokens[user], len(body), body)
	if err != nil {
		t.Fatal(err)
	}
	res, err := http.ReadResponse(bufio.NewReader(conn), nil)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = res.Body.Close() }()
	got, _ := io.ReadAll(res.Body)
	return reply{res.StatusCode, string(got)}
}

// The routes with a limit of their own read an unreadable body as empty, as they did before the
// shared limit: bytes received before the failure must not be parsed as the whole body.
func TestRouteLimitsReadAnUnreadableBodyAsEmpty(t *testing.T) {
	s := start(t, false)
	t.Run("geography", func(t *testing.T) {
		got := s.sendBrokenChunk(t, "/system/geography/query", "solo", `{}`)
		if got.status != http.StatusUnprocessableEntity || got.body != `{"detail":"JSON inválido"}` {
			t.Fatalf("%d %s", got.status, got.body)
		}
	})
	t.Run("sources", func(t *testing.T) {
		expect(t, s.sendBrokenChunk(t, "/system/v4/media/feeds", "multi", `{}`), http.StatusUnprocessableEntity,
			`{"detail":[{"type":"json_invalid","loc":["body"],"msg":"JSON decode error"}]}`)
	})
}

// The project check reads every JSON write, exempt paths too: past the limit it stops reading
// and the route's own limit decides, with the rest of the body intact.
func TestTheProjectCheckStopsReadingAtTheLimit(t *testing.T) {
	t.Setenv("SIPGES_MAX_UPLOAD_BYTES", "20971520") // 20 MiB: over the global limit
	s := start(t, false)
	over := `{"project_id":"NORTE","x":"` + strings.Repeat("x", maxBody) + `"}`
	for name, chunked := range map[string]bool{"declared": false, "chunked": true} {
		t.Run(name, func(t *testing.T) {
			got := s.sendBody(t, "/system/uploads", "solo", "application/json", over, chunked)
			if got.status != http.StatusUnprocessableEntity {
				t.Fatalf("%d %.200s", got.status, got.body)
			}
		})
	}
}

// databaseState is the rows of every table but the sessions, read past row-level security, so
// comparing two states proves no write landed in any tenant.
func databaseState(ctx context.Context, t *testing.T) map[string]string {
	t.Helper()
	conn, err := pgx.Connect(ctx, scratch.URL)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = conn.Close(ctx) }()
	rows, err := conn.Query(ctx, `SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> 'sessions'`)
	if err != nil {
		t.Fatal(err)
	}
	tables, err := pgx.CollectRows(rows, pgx.RowTo[string])
	if err != nil {
		t.Fatal(err)
	}
	state := make(map[string]string, len(tables))
	for _, table := range tables {
		name := pgx.Identifier{"public", table}.Sanitize()
		var count, digest string
		query := `SELECT count(*)::text, coalesce(md5(string_agg(row.r, '|' ORDER BY row.r)), '') FROM (SELECT t::text AS r FROM ` + name + ` t) row`
		if err := conn.QueryRow(ctx, query).Scan(&count, &digest); err != nil {
			t.Fatal(err)
		}
		state[table] = count + ":" + digest
	}
	return state
}

func storedFiles(t *testing.T, dir string) int {
	t.Helper()
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	return len(entries)
}

// Past the limit the project check stops reading on routes that bound the body themselves, so a
// JSON body naming another project is not refused with the project's 403. These bodies must
// still write nothing, in any tenant; the last subtest proves the same bytes can write.
func TestAnExemptRouteWritesNothingForAnOversizeBodyNamingAnotherProject(t *testing.T) {
	uploads := t.TempDir()
	t.Setenv("SIPGES_MAX_UPLOAD_BYTES", "20971520") // 20 MiB: over the global limit
	t.Setenv("SIPGES_STORAGE", "local")
	t.Setenv("SIPGES_UPLOAD_DIR", uploads)
	s := start(t, false)
	const scope, own, other = "X-SIPGES-Scope", "SIPGES/PRJ-SECHURA", "NORTE"
	padding := strings.Repeat("x", maxBody)
	account := func(project, pad string) string {
		return `{"username":"intruso","full_name":"Intruso","password":"Clave-Sintetica-2026!","role":"admin","project_id":"` + project + `","x":"` + pad + `"}`
	}
	const boundary = "limite"
	upload := "--" + boundary + "\r\nContent-Disposition: form-data; name=\"linked_module\"\r\n\r\neventos\r\n" +
		"--" + boundary + "\r\nContent-Disposition: form-data; name=\"linked_record_id\"\r\n\r\nsouth\r\n" +
		"--" + boundary + "\r\nContent-Disposition: form-data; name=\"project_id\"\r\n\r\nPRJ-SECHURA\r\n" +
		"--" + boundary + "\r\nContent-Disposition: form-data; name=\"file\"; filename=\"intruso.txt\"\r\nContent-Type: text/plain\r\n\r\n" +
		padding + "\r\n--" + boundary + "--\r\n"
	before := databaseState(t.Context(), t)

	jsonInvalid := `{"detail":[{"type":"json_invalid","loc":["body"],"msg":"JSON decode error"}]}`
	missingFile := `{"detail":[{"type":"missing","loc":["body","file"],"msg":"Field required"}]}`
	missingFileA := `{"detail":[{"type":"missing","loc":["body","file_a"],"msg":"Field required"}]}`
	for _, c := range []struct {
		path, contentType, body, want string
	}{
		{"/system/uploads", "application/json", account(other, padding), missingFile},
		{"/system/uploads", "application/json; boundary=" + boundary, upload, missingFile},
		{"/system/document-lab/analyze", "application/json", account(other, padding), missingFile},
		{"/system/document-lab/report.docx", "application/json", account(other, padding), missingFile},
		{"/system/document-lab/compare", "application/json", account(other, padding), missingFileA},
		{"/system/auth/accounts", "application/json", account(other, padding), jsonInvalid},
		{"/system/auth/accounts/solo/google", "application/json", `{"email":"intruso@example.com","project_id":"` + other + `","x":"` + padding + `"}`, jsonInvalid},
	} {
		for name, chunked := range map[string]bool{"declared": false, "chunked": true} {
			t.Run(c.path+" "+c.contentType+" "+name, func(t *testing.T) {
				expect(t, s.sendBody(t, c.path, "multi", c.contentType, c.body, chunked, scope, own), http.StatusUnprocessableEntity, c.want)
			})
		}
	}
	t.Run("under the limit the project check still refuses it", func(t *testing.T) {
		expect(t, s.sendBody(t, "/system/auth/accounts", "multi", "application/json", account(other, ""), false, scope, own),
			http.StatusForbidden, `{"detail":"No se permite escribir en otro proyecto"}`)
	})

	after := databaseState(t.Context(), t)
	for table, state := range before {
		if after[table] != state {
			t.Errorf("%s changed: %s, then %s", table, state, after[table])
		}
	}
	if len(after) != len(before) {
		t.Errorf("tables: %d, then %d", len(before), len(after))
	}
	if n := storedFiles(t, uploads); n != 0 {
		t.Errorf("%d objects stored by refused requests", n)
	}

	t.Run("the same payloads write when sent as the route expects, in the scope's tenant only", func(t *testing.T) {
		got := s.sendBody(t, "/system/uploads", "multi", "multipart/form-data; boundary="+boundary, upload, false, scope, own)
		if got.status != http.StatusOK {
			t.Fatalf("upload: %d %.300s", got.status, got.body)
		}
		got = s.sendBody(t, "/system/auth/accounts", "multi", "application/json", account("PRJ-SECHURA", ""), false, scope, own)
		if got.status != http.StatusOK {
			t.Fatalf("account: %d %.300s", got.status, got.body)
		}
		conn, err := pgx.Connect(t.Context(), scratch.URL)
		if err != nil {
			t.Fatal(err)
		}
		defer func() { _ = conn.Close(context.Background()) }()
		var tenants string
		if err := conn.QueryRow(t.Context(), `SELECT string_agg(tenant_id, ',') FROM attachments WHERE original_name = 'intruso.txt'`).Scan(&tenants); err != nil {
			t.Fatal(err)
		}
		if tenants != own {
			t.Fatalf("attachment tenants: %q", tenants)
		}
		if n := storedFiles(t, uploads); n == 0 {
			t.Fatal("the accepted upload stored no object")
		}
	})
}
