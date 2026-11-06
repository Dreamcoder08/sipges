//nolint:misspell // Spanish file names and titles kept verbatim from the TypeScript API.
package http_test

import (
	"archive/zip"
	"bytes"
	"io"
	"net/http"
	"strings"
	"testing"
)

const docxType = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"

var reports = []struct{ path, filename, firstLine string }{
	{"/system/situational-report.docx", "SIPGES_Analisis_Situacional.docx", "INFORME DE ANÁLISIS SITUACIONAL"},
	{"/system/strategic-report.docx", "SIPGES_Informe_Estrategico.docx", "SIPGES | Informe estratégico territorial"},
	{"/system/integrated-analysis.docx", "SIPGES_RC19_Analisis_Integrado.docx", "SIPGES | Análisis integrado RC 1.9"},
	{"/system/consensus-engine.docx", "SIPGES_Motor_Valor_Consenso.docx", "SIPGES | Motor de valor y consenso"},
}

// download fetches a report and answers its status, disposition and word/document.xml.
func download(t *testing.T, base, path, user string, headers map[string]string) (int, string, string) {
	t.Helper()
	r, err := http.NewRequestWithContext(t.Context(), http.MethodGet, base+path, nil)
	if err != nil {
		t.Fatal(err)
	}
	r.Header.Set("Cookie", "sipges_session="+tokens[user])
	for k, v := range headers {
		r.Header.Set(k, v)
	}
	res, err := http.DefaultClient.Do(r)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = res.Body.Close() }()
	body, err := io.ReadAll(res.Body)
	if err != nil {
		t.Fatal(err)
	}
	if res.StatusCode != http.StatusOK {
		return res.StatusCode, "", strings.TrimSpace(string(body))
	}
	if ct, cache := res.Header.Get("Content-Type"), res.Header.Get("Cache-Control"); ct != docxType || cache != "no-store" {
		t.Fatalf("content-type %q, cache-control %q", ct, cache)
	}
	archive, err := zip.NewReader(bytes.NewReader(body), int64(len(body)))
	if err != nil {
		t.Fatal(err)
	}
	part, err := archive.Open("word/document.xml")
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = part.Close() }()
	document, err := io.ReadAll(part)
	if err != nil {
		t.Fatal(err)
	}
	return res.StatusCode, res.Header.Get("Content-Disposition"), string(document)
}

func TestReportsAreWordFilesOfTheResolvedProject(t *testing.T) {
	base := start(t)
	for _, report := range reports {
		t.Run(report.filename, func(t *testing.T) {
			status, disposition, document := download(t, base, report.path, "solo", nil)
			if status != http.StatusOK || disposition != `attachment; filename="`+report.filename+`"` {
				t.Fatalf("%d %q", status, disposition)
			}
			if !strings.Contains(document, report.firstLine) {
				t.Fatalf("no %q in\n%s", report.firstLine, document)
			}
			if strings.Contains(document, "AJENA") {
				t.Fatalf("another project's rows reached the report:\n%s", document)
			}
		})
	}
}

func TestTheSituationalReportFollowsTheProjectAndTheClearance(t *testing.T) {
	base := start(t)
	const path = "/system/situational-report.docx"
	_, _, full := download(t, base, path, "solo", nil)
	if !strings.Contains(full, "Zona sintética reservada") {
		t.Fatalf("the analyst lost a restricted record:\n%s", full)
	}
	_, _, limited := download(t, base, path, "reader", nil)
	if strings.Contains(limited, "Zona sintética reservada") {
		t.Fatalf("a restricted record reached the read-only role:\n%s", limited)
	}
	_, _, other := download(t, base, path, "multi", map[string]string{"X-SIPGES-Scope": "PARITY/OTRO"})
	if !strings.Contains(other, "AJENA") || strings.Contains(other, "Caleta sintética") {
		t.Fatalf("the report did not follow the project:\n%s", other)
	}
}

func TestReportsRefuseRequestsOutsideTheScope(t *testing.T) {
	base := start(t)
	for _, report := range reports {
		status, _, body := download(t, base, report.path, "solo", map[string]string{"X-SIPGES-Scope": "PARITY/OTRO"})
		expect(t, status, body, http.StatusForbidden, chooseSolo)
		status, _, body = download(t, base, report.path+"?project_id=OTRO", "solo", nil)
		expect(t, status, body, http.StatusForbidden, outOfScope)
	}
}
