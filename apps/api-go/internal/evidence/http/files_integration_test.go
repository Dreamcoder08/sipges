package http_test

import (
	"archive/zip"
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/Dreamcoder08/sipges/apps/api-go/internal/app"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/identity/infrastructure"
)

// The file routes (upload, download, preview) through the composed handler, against the
// migrated synthetic PostgreSQL and the local object storage in a temporary directory: the
// adapter context_evidence.go picks from SIPGES_UPLOAD_DIR, as apps/api does. They use a
// project of their own (LAB/SUBIDAS), so the metadata tests' lists never see these uploads.
// Expected answers are the TypeScript route's (apps/api/test/evidence/evidence-http.test.ts
// and evidence-routes.ts).

const lab = "LAB/SUBIDAS"

var (
	labOnce   sync.Once
	labErr    error
	labTokens = map[string]string{}
)

// labSeed adds the project, its accounts and records (once per run).
func labSeed(t *testing.T) {
	t.Helper()
	labOnce.Do(func() {
		ctx := context.Background()
		conn, err := pgx.Connect(ctx, scratch.URL)
		if err != nil {
			labErr = err
			return
		}
		defer func() { _ = conn.Close(ctx) }()
		if _, labErr = conn.Exec(ctx, `
			INSERT INTO tenants (company_id, project_id, label) VALUES ('LAB','SUBIDAS','Subidas') ON CONFLICT DO NOTHING;
			INSERT INTO users (username, full_name, password_hash, role, active, totp_enabled) VALUES
			  ('up-admin', 'Up Admin', 'x', 'admin', true, true),
			  ('up-reader', 'Up Reader', 'x', 'consulta', true, true),
			  ('up-coord', 'Up Coord', 'x', 'coordinador', true, true);
			INSERT INTO grants (username, tenant_id) VALUES
			  ('up-admin','LAB/SUBIDAS'), ('up-reader','LAB/SUBIDAS'), ('up-coord','LAB/SUBIDAS');
			-- Fails only the uploads that carry these notes: the "transaction fails" probe.
			ALTER TABLE attachments ADD CONSTRAINT probe_fail CHECK (notes <> 'FALLA-PROBE') NOT VALID;`); labErr != nil {
			return
		}
		labErr = tenantRows(ctx, conn, lab, `INSERT INTO module_records (tenant_id, module, id, payload, marking, created_at, updated_at) VALUES
			(current_setting('app.tenant_id'), 'Eventos', 'EV-1', '{"Titulo":"Sintético","Monto":12345678901234567890,"Cero":-0,"Grande":1e400,"Adjuntos":"no-lista"}', 'interno', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z'),
			(current_setting('app.tenant_id'), 'Fuentes', 'F-1', '{"Proyecto_ID":7,"Proyecto":"","Adjuntos":[{"id":"OLD"}]}', 'publico', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z'),
			(current_setting('app.tenant_id'), 'Alertas', 'AL-R', '{"Proyecto_ID":"PRJ-SECHURA"}', 'restringido', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z'),
			(current_setting('app.tenant_id'), 'Acciones', 'AC-1', '{"Proyecto_ID":{"a":1},"Proyecto":[1,null,"x"]}', 'interno', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z');`)
		if labErr != nil {
			return
		}
		batch := &pgx.Batch{}
		for _, user := range []string{"up-admin", "up-reader", "up-coord"} {
			var b [32]byte
			_, _ = rand.Read(b[:])
			labTokens[user] = hex.EncodeToString(b[:])
			batch.Queue(`INSERT INTO sessions (token_hash, username, expires_at) VALUES ($1, $2, $3)`,
				infrastructure.HashToken(labTokens[user]), user, t0.Add(8*time.Hour))
		}
		labErr = conn.SendBatch(ctx, batch).Close()
	})
	if labErr != nil {
		t.Fatal(labErr)
	}
}

type labServer struct {
	base string
	dir  string
	pool *pgxpool.Pool
}

// startLab builds the handler with the local object storage in a fresh directory.
func startLab(t *testing.T, env map[string]string) labServer {
	t.Helper()
	if scratch == nil {
		t.Skip("SIPGES_TEST_DATABASE_URL is not set")
	}
	labSeed(t)
	dir := t.TempDir()
	t.Setenv("SIPGES_STORAGE", "local")
	t.Setenv("SIPGES_UPLOAD_DIR", dir)
	for k, v := range env {
		t.Setenv(k, v)
	}
	pool, err := pgxpool.New(t.Context(), scratch.URL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	h, err := app.NewHandler(pool, app.Options{
		Logger: slog.New(slog.DiscardHandler),
		Now:    func() time.Time { return t0.Add(1234567 * time.Microsecond) },
	})
	if err != nil {
		t.Fatal(err)
	}
	srv := httptest.NewServer(h)
	t.Cleanup(srv.Close)
	return labServer{base: srv.URL, dir: dir, pool: pool}
}

type response struct {
	status int
	header http.Header
	body   []byte
}

func (s labServer) do(t *testing.T, method, path, user string, body io.Reader, headers map[string]string) response {
	t.Helper()
	r, err := http.NewRequestWithContext(t.Context(), method, s.base+path, body)
	if err != nil {
		t.Fatal(err)
	}
	if user != "" {
		r.Header.Set("Cookie", "sipges_session="+labTokens[user])
	}
	if method == http.MethodPost {
		r.Header.Set("Origin", s.base)
	}
	for k, v := range headers {
		if v == "" {
			r.Header.Del(k)
			continue
		}
		r.Header.Set(k, v)
	}
	res, err := http.DefaultClient.Do(r)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = res.Body.Close() }()
	b, _ := io.ReadAll(res.Body)
	// The shared gates and the 500 write a trailing newline (JSON-equal to Hono's body).
	if strings.HasPrefix(res.Header.Get("Content-Type"), "application/json") {
		b = bytes.TrimSuffix(b, []byte("\n"))
	}
	return response{status: res.StatusCode, header: res.Header, body: b}
}

// form builds a multipart body; a nil file leaves the file part out.
func form(t *testing.T, fields map[string]string, fileName string, data []byte) (io.Reader, string) {
	t.Helper()
	var b bytes.Buffer
	w := multipart.NewWriter(&b)
	keys := make([]string, 0, len(fields))
	for k := range fields {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	for _, k := range keys {
		if err := w.WriteField(k, fields[k]); err != nil {
			t.Fatal(err)
		}
	}
	if data != nil {
		part, err := w.CreateFormFile("file", fileName)
		if err != nil {
			t.Fatal(err)
		}
		_, _ = part.Write(data)
	}
	if err := w.Close(); err != nil {
		t.Fatal(err)
	}
	return &b, w.FormDataContentType()
}

// upload posts as the project's administrator (other roles go through do, in TestUploadGates).
func (s labServer) upload(t *testing.T, fields map[string]string, fileName string, data []byte) response {
	t.Helper()
	body, ct := form(t, fields, fileName, data)
	return s.do(t, http.MethodPost, "/system/uploads", "up-admin", body, map[string]string{"Content-Type": ct})
}

var pdf = []byte("%PDF-1.7\nsynthetic evidence\n")

func link(extra ...string) map[string]string {
	m := map[string]string{"linked_module": "eventos", "linked_record_id": "EV-1"}
	for i := 0; i+1 < len(extra); i += 2 {
		m[extra[i]] = extra[i+1]
	}
	return m
}

type uploaded struct {
	OK         bool           `json:"ok"`
	Attachment map[string]any `json:"attachment"`
}

func decode(t *testing.T, r response) uploaded {
	t.Helper()
	var u uploaded
	if err := json.Unmarshal(r.body, &u); err != nil {
		t.Fatalf("%d %s: %v", r.status, r.body, err)
	}
	return u
}

func (s labServer) objects(t *testing.T) []string {
	t.Helper()
	var keys []string
	err := filepath.WalkDir(s.dir, func(path string, d os.DirEntry, err error) error {
		if err == nil && !d.IsDir() {
			rel, _ := filepath.Rel(s.dir, path)
			keys = append(keys, filepath.ToSlash(rel))
		}
		return err
	})
	if err != nil {
		t.Fatal(err)
	}
	return keys
}

func (s labServer) query(t *testing.T, sql string, args ...any) string {
	t.Helper()
	var out string
	tx, err := s.pool.Begin(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = tx.Rollback(t.Context()) }()
	if _, err := tx.Exec(t.Context(), `SELECT set_config('app.tenant_id', $1, true)`, lab); err != nil {
		t.Fatal(err)
	}
	if err := tx.QueryRow(t.Context(), sql, args...).Scan(&out); err != nil {
		t.Fatal(err)
	}
	return out
}

func TestUploadStoresTheFileLinksItAndAuditsIt(t *testing.T) {
	s := startLab(t, nil)
	res := s.upload(t, link("notes", "Acta de campo", "author", "Equipo <b>&</b>"), "Informe Final ñ.PDF", pdf)
	if res.status != 200 {
		t.Fatalf("%d %s", res.status, res.body)
	}
	if ct := res.header.Get("Content-Type"); ct != "application/json" {
		t.Errorf("content-type %q", ct)
	}
	u := decode(t, res)
	id, _ := u.Attachment["id"].(string)
	if !u.OK || !regexp.MustCompile(`^ADJ-[0-9A-F]{12}$`).MatchString(id) {
		t.Fatalf("%s", res.body)
	}
	sum := sha256.Sum256(pdf)
	want := fmt.Sprintf(`{"ok":true,"attachment":{"id":%q,"original_name":"Informe-Final-n.pdf","content_type":"application/pdf","size_bytes":%d,`+
		`"sha256":%q,"linked_module":"eventos","linked_record_id":"EV-1","document_type":"Reporte / evidencia","author":"Equipo <b>&</b>",`+
		`"verification":"E - No verificada","notes":"Acta de campo","project_id":"LAB-PROBE","project_name":"","Proyecto_ID":"LAB-PROBE","Proyecto":"",`+
		`"created_at":"2026-11-03T11:00:01Z","download_url":"/system/uploads/%s/download"}}`, id, len(pdf), hex.EncodeToString(sum[:]), id)
	// The scope's project id is SUBIDAS: the record has no Proyecto_ID of its own.
	want = strings.ReplaceAll(want, "LAB-PROBE", "SUBIDAS")
	if string(res.body) != want {
		t.Errorf("got  %s\nwant %s", res.body, want)
	}
	// Key layout: sha256(tenant)[:24] / 32 lower hex _ safe name.
	keys := s.objects(t)
	prefix := hex.EncodeToString(func() []byte { h := sha256.Sum256([]byte(lab)); return h[:] }())[:24]
	if len(keys) != 1 || !regexp.MustCompile(`^`+prefix+`/[0-9a-f]{32}_Informe-Final-n\.pdf$`).MatchString(keys[0]) {
		t.Fatalf("objects %v", keys)
	}
	if got := s.query(t, `SELECT storage_key FROM attachments WHERE id = $1`, id); got != keys[0] {
		t.Errorf("storage_key %q, object %q", got, keys[0])
	}
	// The record gained the link (Adjuntos was not a list, so it starts over) and the numbers
	// went through JavaScript doubles: 2^64-ish rounds, -0 is 0, 1e400 is null.
	payload := s.query(t, `SELECT payload::text FROM module_records WHERE tenant_id = 'LAB/SUBIDAS' AND module = 'Eventos' AND id = 'EV-1'`)
	wantPayload := fmt.Sprintf(
		`{"Cero": 0, "Monto": 12345678901234567000, "Grande": null, "Titulo": "Sintético", "Adjuntos": [{"id": %q, "tipo": "Reporte / evidencia", "archivo": "Informe-Final-n.pdf", "verificacion": "E - No verificada"}], "Evidencia/Resultado": "Informe-Final-n.pdf"}`, id) //nolint:misspell // Spanish fields of app.py
	if payload != wantPayload {
		t.Errorf("payload\ngot  %s\nwant %s", payload, wantPayload)
	}
	if got := s.query(t, `SELECT to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US') FROM module_records WHERE tenant_id = 'LAB/SUBIDAS' AND module = 'Eventos' AND id = 'EV-1'`); got != "2026-11-03T11:00:01.234000" {
		t.Errorf("updated_at %s (milliseconds, as a JavaScript Date)", got)
	}
	audit := s.query(t, `SELECT concat_ws('|', module, record_id, action, detail, to_char(ts AT TIME ZONE 'UTC', 'HH24:MI:SS.US')) FROM audit WHERE tenant_id = 'LAB/SUBIDAS' ORDER BY id DESC LIMIT 1`)
	if want := fmt.Sprintf("Eventos|EV-1|UPLOAD|Evidencia adjunta: Informe-Final-n.pdf (%d bytes)|11:00:01.234000", len(pdf)); audit != want {
		t.Errorf("audit %q, want %q", audit, want)
	}
	if actor := s.query(t, `SELECT actor FROM record_versions WHERE tenant_id = 'LAB/SUBIDAS' AND module = 'Eventos' AND record_id = 'EV-1' ORDER BY id DESC LIMIT 1`); actor != "up-admin" {
		t.Errorf("record history actor %q", actor)
	}

	// Download: the bytes and the TypeScript headers.
	dl := s.do(t, http.MethodGet, "/system/uploads/"+id+"/download", "up-admin", nil, nil)
	if dl.status != 200 || !bytes.Equal(dl.body, pdf) ||
		dl.header.Get("Content-Type") != "application/pdf" ||
		dl.header.Get("Content-Length") != fmt.Sprint(len(pdf)) ||
		dl.header.Get("Content-Disposition") != `attachment; filename="Informe-Final-n.pdf"` {
		t.Errorf("download %d %v %q", dl.status, dl.header, dl.body)
	}
	// HEAD: the same headers, no body.
	head := s.do(t, http.MethodHead, "/system/uploads/"+id+"/download", "up-admin", nil, nil)
	if head.status != 200 || len(head.body) != 0 || head.header.Get("Content-Length") != fmt.Sprint(len(pdf)) {
		t.Errorf("HEAD %d %v", head.status, head.header)
	}
	// The read-only role sees a file of an "interno" record.
	if r := s.do(t, http.MethodGet, "/system/uploads/"+id+"/download", "up-reader", nil, nil); r.status != 200 {
		t.Errorf("reader download %d", r.status)
	}
}

func TestUploadReadsTheProjectAndLinkFromTheRecord(t *testing.T) {
	s := startLab(t, nil)
	// A verification cut inside a surrogate pair reaches the record's JSON as "\ud83d", which
	// jsonb refuses: the TypeScript upload fails with 500 and leaves nothing behind.
	res := s.upload(t, map[string]string{"linked_module": "fuentes", "linked_record_id": "F-1", "verification": strings.Repeat("v", 79) + "\U0001F600"}, "a.csv", []byte("a,b\n1,2\n"))
	if res.status != 500 || len(s.objects(t)) != 0 {
		t.Fatalf("cut verification: %d %s %v", res.status, res.body, s.objects(t))
	}
	// Notes and author only reach the row, where the driver writes the lone surrogate as U+FFFD.
	res = s.upload(t, map[string]string{"linked_module": "\u00a0FUENTES ", "linked_record_id": "F-1", "document_type": "", "notes": strings.Repeat("n", 999) + "\U0001F600", "author": strings.Repeat("a", 159) + "\U0001F600"}, "a.csv", []byte("a,b\n1,2\n"))
	u := decode(t, res)
	if res.status != 200 || u.Attachment["project_id"] != "7" || u.Attachment["project_name"] != "" ||
		u.Attachment["linked_module"] != "fuentes" || u.Attachment["document_type"] != "" ||
		u.Attachment["notes"] != strings.Repeat("n", 999)+"\ufffd" || u.Attachment["author"] != strings.Repeat("a", 159)+"\ufffd" ||
		u.Attachment["content_type"] != "text/csv" {
		t.Fatalf("%d %s", res.status, res.body)
	}
	payload := s.query(t, `SELECT payload->'Adjuntos'->>0 || '|' || jsonb_array_length(payload->'Adjuntos') || '|' || (payload->>'Archivo_Fuente') FROM module_records WHERE tenant_id = 'LAB/SUBIDAS' AND module = 'Fuentes' AND id = 'F-1'`)
	if payload != `{"id": "OLD"}|2|a.csv` {
		t.Errorf("payload %s", payload)
	}
	// An object Proyecto_ID reads as "[object Object]", an array Proyecto joins with commas.
	res = s.upload(t, map[string]string{"linked_module": "acciones", "linked_record_id": "AC-1"}, "b.txt", []byte("hola"))
	u = decode(t, res)
	if u.Attachment["project_id"] != "[object Object]" || u.Attachment["project_name"] != "1,,x" {
		t.Errorf("%s", res.body)
	}
	// The restricted record takes uploads from full clearance; its project names the legacy one.
	res = s.upload(t, map[string]string{"linked_module": "alertas", "linked_record_id": "AL-R"}, "c.txt", []byte("hola"))
	u = decode(t, res)
	if u.Attachment["project_id"] != "PRJ-SECHURA" || u.Attachment["project_name"] != "Proyecto Sechura" {
		t.Errorf("%s", res.body)
	}
}

func TestUploadRefusalsStoreNothing(t *testing.T) {
	s := startLab(t, map[string]string{"SIPGES_MAX_UPLOAD_BYTES": "1048576"})
	before := s.query(t, `SELECT count(*)::text FROM attachments WHERE tenant_id = 'LAB/SUBIDAS'`)
	big := make([]byte, 1048576+1)
	copy(big, "%PDF-")
	for _, c := range []struct {
		name   string
		fields map[string]string
		file   string
		data   []byte
		status int
		body   string
	}{
		{"unknown module", link("linked_module", "planetas"), //nolint:misspell // Spanish
			"a.pdf", pdf, 400, `{"detail":"Módulo de vínculo no válido"}`},
		{"executable", link(), "script.exe", pdf, 415, `{"detail":"Tipo de archivo no permitido. Use PDF, Office, CSV, TXT o imágenes JPG/PNG/WEBP."}`},
		{"renamed content", link(), "falso.pdf", []byte("MZ not a pdf"), 415, `{"detail":"El contenido del archivo no corresponde a su extensión"}`},
		{"html as text", link(), "page.txt", []byte("<html>\x00"), 415, `{"detail":"El contenido del archivo no corresponde a su extensión"}`},
		{"empty", link(), "vacio.pdf", []byte{}, 400, `{"detail":"El archivo está vacío"}`},
		{"missing record", link("linked_record_id", "EV-404"), "a.pdf", pdf, 404, `{"detail":"No existe el registro al que se desea vincular el archivo"}`},
		{"record id with NUL", link("linked_record_id", "EV\x001"), "a.pdf", pdf, 404, `{"detail":"No existe el registro al que se desea vincular el archivo"}`},
		{"record id of 201 units", link("linked_record_id", strings.Repeat("x", 201)), "a.pdf", pdf, 404, `{"detail":"No existe el registro al que se desea vincular el archivo"}`},
		{"over the limit", link(), "grande.pdf", big, 413, `{"detail":"El archivo supera el límite de 1 MB"}`},
		{"no linked_record_id", map[string]string{"linked_module": "eventos"}, "a.pdf", pdf, 422, `{"detail":[{"type":"missing","loc":["body","linked_record_id"],"msg":"Field required"}]}`},
		{"no linked_module", map[string]string{"linked_record_id": "EV-1"}, "a.pdf", pdf, 422, `{"detail":[{"type":"missing","loc":["body","linked_module"],"msg":"Field required"}]}`},
		{"no file", link(), "", nil, 422, `{"detail":[{"type":"missing","loc":["body","file"],"msg":"Field required"}]}`},
		// Malicious names: only the extension decides, and the stored name is sanitized.
		{"path traversal to an executable", link(), "../../etc/cron.d/x.sh", pdf, 415, `{"detail":"Tipo de archivo no permitido. Use PDF, Office, CSV, TXT o imágenes JPG/PNG/WEBP."}`},
		{"double extension", link(), "factura.pdf.exe", pdf, 415, `{"detail":"Tipo de archivo no permitido. Use PDF, Office, CSV, TXT o imágenes JPG/PNG/WEBP."}`},
	} {
		res := s.upload(t, c.fields, c.file, c.data)
		if res.status != c.status || string(res.body) != c.body {
			t.Errorf("%s: got %d %s, want %d %s", c.name, res.status, res.body, c.status, c.body)
		}
	}
	// A Content-Length over the limit plus the multipart slack is refused unread.
	huge := s.do(t, http.MethodPost, "/system/uploads", "up-admin", bytes.NewReader(make([]byte, 1048576+64*1024+1)), map[string]string{"Content-Type": "multipart/form-data; boundary=x"})
	if huge.status != 413 || string(huge.body) != `{"detail":"El archivo supera el límite de 1 MB"}` {
		t.Errorf("huge: %d %s", huge.status, huge.body)
	}
	// Not a form: parseBody reads {} for another media type, then the file is missing.
	for ct, want := range map[string]string{
		"text/plain":                        `{"detail":[{"type":"missing","loc":["body","file"],"msg":"Field required"}]}`,
		"multipart/form-data":               `{"detail":[{"type":"value_error","loc":["body"],"msg":"Invalid form body"}]}`,
		"application/x-www-form-urlencoded": `{"detail":[{"type":"missing","loc":["body","file"],"msg":"Field required"}]}`,
	} {
		r := s.do(t, http.MethodPost, "/system/uploads", "up-admin", strings.NewReader("file=x"), map[string]string{"Content-Type": ct})
		if r.status != 422 || string(r.body) != want {
			t.Errorf("%s: %d %s", ct, r.status, r.body)
		}
	}
	if objects := s.objects(t); len(objects) != 0 {
		t.Errorf("objects left behind: %v", objects)
	}
	if after := s.query(t, `SELECT count(*)::text FROM attachments WHERE tenant_id = 'LAB/SUBIDAS'`); after != before {
		t.Errorf("attachments %s → %s", before, after)
	}
}

func TestUploadMaliciousNamesAreSanitizedInKeyAndHeaders(t *testing.T) {
	s := startLab(t, nil)
	for name, safe := range map[string]string{
		`..\..\Windows\evil name.txt`:   "evil-name.txt",
		"/etc/passwd%00.txt":            "passwd-00.txt",
		"a\r\nX-Injected: 1.txt":        "a-X-Injected-1.txt",
		"<script>alert(1)</script>.txt": "script.txt",
		"%22quoted%22.txt":              "quoted.txt",
		"....txt":                       "archivo.txt",
	} {
		raw := fmt.Sprintf("--B0undary0123456789abcdefghij\r\nContent-Disposition: form-data; name=\"linked_module\"\r\n\r\neventos\r\n"+
			"--B0undary0123456789abcdefghij\r\nContent-Disposition: form-data; name=\"linked_record_id\"\r\n\r\nEV-1\r\n"+
			"--B0undary0123456789abcdefghij\r\nContent-Disposition: form-data; name=\"file\"; filename=\"%s\"\r\n\r\nhola\r\n"+
			"--B0undary0123456789abcdefghij--\r\n", strings.NewReplacer("\r", "%0D", "\n", "%0A").Replace(name))
		res := s.do(t, http.MethodPost, "/system/uploads", "up-admin", strings.NewReader(raw), map[string]string{"Content-Type": "multipart/form-data; boundary=B0undary0123456789abcdefghij"})
		u := decode(t, res)
		if res.status != 200 || u.Attachment["original_name"] != safe {
			t.Errorf("%q: %d %s", name, res.status, res.body)
			continue
		}
		id := u.Attachment["id"].(string)
		dl := s.do(t, http.MethodGet, "/system/uploads/"+id+"/download", "up-admin", nil, nil)
		if dl.header.Get("Content-Disposition") != `attachment; filename="`+safe+`"` || dl.header.Get("X-Injected") != "" || string(dl.body) != "hola" {
			t.Errorf("%q: download %v", name, dl.header)
		}
	}
	for _, key := range s.objects(t) {
		if !regexp.MustCompile(`^[0-9a-f]{24}/[0-9a-f]{32}_[A-Za-z0-9._-]+$`).MatchString(key) {
			t.Errorf("object key %q", key)
		}
	}
}

func TestUploadDeletesTheObjectWhenTheTransactionFails(t *testing.T) {
	s := startLab(t, nil)
	res := s.upload(t, link("notes", "FALLA-PROBE"), "a.pdf", pdf)
	if res.status != 500 || string(res.body) != `{"detail":"Internal Server Error"}` {
		t.Errorf("%d %s", res.status, res.body)
	}
	if objects := s.objects(t); len(objects) != 0 {
		t.Errorf("objects left behind: %v", objects)
	}
}

func TestUploadGates(t *testing.T) {
	s := startLab(t, nil)
	body, ct := form(t, link(), "a.pdf", pdf)
	if r := s.do(t, http.MethodPost, "/system/uploads", "up-reader", body, map[string]string{"Content-Type": ct}); r.status != 403 || string(r.body) != `{"detail":"Rol de consulta: solo lectura"}` {
		t.Errorf("reader: %d %s", r.status, r.body)
	}
	body, ct = form(t, link(), "a.pdf", pdf)
	if r := s.do(t, http.MethodPost, "/system/uploads", "up-coord", body, map[string]string{"Content-Type": ct}); r.status != 403 {
		t.Errorf("coordinador: %d %s", r.status, r.body)
	}
	body, ct = form(t, link(), "a.pdf", pdf)
	if r := s.do(t, http.MethodPost, "/system/uploads", "up-admin", body, map[string]string{"Content-Type": ct, "Origin": "https://evil.example"}); r.status != 403 {
		t.Errorf("cross-origin: %d %s", r.status, r.body)
	}
	body, ct = form(t, link(), "a.pdf", pdf)
	if r := s.do(t, http.MethodPost, "/system/uploads", "", body, map[string]string{"Content-Type": ct}); r.status != 401 {
		t.Errorf("no session: %d %s", r.status, r.body)
	}
	body, ct = form(t, link(), "a.pdf", pdf)
	if r := s.do(t, http.MethodPost, "/system/uploads?project_id=OTRO", "up-admin", body, map[string]string{"Content-Type": ct}); r.status != 403 || string(r.body) != `{"detail":"Proyecto fuera de alcance"}` {
		t.Errorf("project_id: %d %s", r.status, r.body)
	}
	if objects := s.objects(t); len(objects) != 0 {
		t.Errorf("objects left behind: %v", objects)
	}
}

func TestDownloadAndPreviewStayInsideTheTenantAndClearance(t *testing.T) {
	s := startLab(t, nil)
	res := s.upload(t, map[string]string{"linked_module": "alertas", "linked_record_id": "AL-R"}, "reservado.txt", []byte("secreto"))
	restricted := decode(t, res).Attachment["id"].(string)
	notFound := `{"detail":"Archivo no encontrado"}`
	for _, c := range []struct{ name, path, user, body string }{
		// A restricted record's file: the read-only role gets the 404 of a missing file.
		{"restricted download as consulta", "/system/uploads/" + restricted + "/download", "up-reader", notFound},
		{"restricted preview as consulta", "/system/uploads/" + restricted + "/preview", "up-reader", notFound},
		// Another project's attachment (ACME/NORTE) by id, from this project.
		{"other project's download", "/system/uploads/ADJ-N/download", "up-admin", notFound},
		{"other project's preview", "/system/uploads/ADJ-N/preview", "up-admin", notFound},
		{"missing id", "/system/uploads/ADJ-NOPE/download", "up-admin", notFound},
		{"id with NUL", "/system/uploads/a%00b/download", "up-admin", notFound},
		{"id of 65 characters", "/system/uploads/" + strings.Repeat("A", 65) + "/preview", "up-admin", notFound},
		{"encoded slash", "/system/uploads/a%2Fb/download", "up-admin", notFound},
		{"traversal id", "/system/uploads/..%2F..%2Fetc/download", "up-admin", notFound},
	} {
		r := s.do(t, http.MethodGet, c.path, c.user, nil, nil)
		if r.status != 404 || string(r.body) != c.body {
			t.Errorf("%s: %d %s", c.name, r.status, r.body)
		}
	}
	if r := s.do(t, http.MethodGet, "/system/uploads/"+restricted+"/download", "up-admin", nil, nil); r.status != 200 || string(r.body) != "secreto" || r.header.Get("Content-Type") != "text/plain" {
		t.Errorf("restricted download as admin: %d %v %s", r.status, r.header, r.body)
	}
	// Another tenant's stored object is never reachable: the same key prefix rule and RLS.
	if r := s.do(t, http.MethodGet, "/system/uploads/"+restricted+"/download", "up-admin", nil, map[string]string{"X-SIPGES-Scope": "ACME/NORTE"}); r.status != 403 {
		t.Errorf("ungranted scope: %d %s", r.status, r.body)
	}
}

func TestPreviewKinds(t *testing.T) {
	s := startLab(t, nil)
	up := func(name string, data []byte) string {
		t.Helper()
		res := s.upload(t, map[string]string{"linked_module": "acciones", "linked_record_id": "AC-1"}, name, data)
		if res.status != 200 {
			t.Fatalf("%s: %d %s", name, res.status, res.body)
		}
		return decode(t, res).Attachment["id"].(string)
	}
	preview := func(id string) (int, map[string]any) {
		t.Helper()
		r := s.do(t, http.MethodGet, "/system/uploads/"+id+"/preview", "up-admin", nil, nil)
		var out map[string]any
		if err := json.Unmarshal(r.body, &out); err != nil {
			t.Fatalf("%s", r.body)
		}
		return r.status, out
	}
	txt := up("nota.txt", []byte("\xef\xbb\xbf\xef\xbb\xbfhola\nmundo"))
	status, out := preview(txt)
	if status != 200 || out["kind"] != "text" || out["format"] != "txt" || out["truncated"] != false ||
		fmt.Sprint(out["pages"]) != "[hola\nmundo]" || out["attachment"].(map[string]any)["id"] != txt {
		t.Errorf("txt: %d %v", status, out)
	}
	blank := up("blanco.csv", []byte(" \t\n"))
	if status, out := preview(blank); status != 200 || out["kind"] != "no_text" {
		t.Errorf("blank: %d %v", status, out)
	}
	long := up("largo.txt", []byte(strings.Repeat("a", 199_999)+"😀b"))
	r := s.do(t, http.MethodGet, "/system/uploads/"+long+"/preview", "up-admin", nil, nil)
	// The cut falls inside the emoji: JSON.stringify writes the lone high surrogate.
	if !bytes.Contains(r.body, []byte(`a\ud83d"],"truncated":true`)) {
		t.Errorf("long: %d %.200s", r.status, r.body[len(r.body)-min(len(r.body), 400):])
	}
	img := up("foto.png", []byte("\x89PNG\r\n\x1a\nxx"))
	if status, out := preview(img); status != 200 || out["kind"] != "image" || len(out) != 2 {
		t.Errorf("image: %d %v", status, out)
	}
	xlsx := up("tabla.xlsx", []byte("PK\x03\x04xx"))
	if status, out := preview(xlsx); status != 200 || out["kind"] != "unsupported" {
		t.Errorf("xlsx: %d %v", status, out)
	}
	pdfID := up("informe.pdf", pdf)
	if status, out := preview(pdfID); status != 501 || out["detail"] != "La vista previa de PDF aún no está disponible en este servidor" {
		t.Errorf("pdf: %d %v", status, out)
	}
	// DOCX through the document lab's reader: paragraphs, then table rows with tab-joined cells,
	// one page joined by line feeds (preview of evidence-service.ts).
	docxID := up("acta.docx", wordPackage(t, `<w:p><w:r><w:t>Uno</w:t></w:r></w:p><w:p/>`+
		`<w:tbl><w:tr><w:tc><w:p><w:r><w:t>a</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>b</w:t></w:r></w:p></w:tc></w:tr></w:tbl>`))
	if status, out := preview(docxID); status != 200 || out["kind"] != "text" || out["format"] != "docx" ||
		fmt.Sprint(out["pages"]) != "[Uno\n\na\tb]" {
		t.Errorf("docx: %d %v", status, out)
	}
	broken := up("roto.docx", []byte("PK\x03\x04 not a package"))
	if status, out := preview(broken); status != 200 || out["kind"] != "no_text" {
		t.Errorf("unreadable docx: %d %v", status, out)
	}
	// Objects gone from storage: 410 for text formats, while images and unsupported formats
	// answer without reading the object.
	if err := os.RemoveAll(s.dir); err != nil {
		t.Fatal(err)
	}
	gone := `{"detail":"El archivo ya no está disponible en este almacenamiento"}`
	for _, id := range []string{txt, pdfID} {
		if r := s.do(t, http.MethodGet, "/system/uploads/"+id+"/preview", "up-admin", nil, nil); r.status != 410 || string(r.body) != gone {
			t.Errorf("gone preview: %d %s", r.status, r.body)
		}
	}
	if r := s.do(t, http.MethodGet, "/system/uploads/"+txt+"/download", "up-admin", nil, nil); r.status != 410 || string(r.body) != gone {
		t.Errorf("gone download: %d %s", r.status, r.body)
	}
	if status, out := preview(img); status != 200 || out["kind"] != "image" {
		t.Errorf("image after removal: %d %v", status, out)
	}
}

// wordPackage is a minimal Word package whose body holds the given markup.
func wordPackage(t *testing.T, body string) []byte {
	t.Helper()
	var b bytes.Buffer
	w := zip.NewWriter(&b)
	f, err := w.Create("word/document.xml")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.Write([]byte(`<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>` + body + `</w:body></w:document>`)); err != nil {
		t.Fatal(err)
	}
	if err := w.Close(); err != nil {
		t.Fatal(err)
	}
	return b.Bytes()
}
