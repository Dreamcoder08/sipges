package main

import (
	"bytes"
	"strings"
	"testing"
)

const syntheticImportReport = `{"mode":"dry-run","applied":false,"ok":false,
"identity":{"users":{"source":2,"mapped":1,"written":0},"tenants":{"source":1,"mapped":1,"written":0},
"grants":{"source":1,"mapped":1,"written":0},"sessionsSkipped":3},
"problems":[{"code":"user_invalid","severity":"error"}],
"tenants":[{"tenantId":"SIPGES/PRJ-SECHURA",
"source":{"audit":7,"attachments":1},"mapped":{"audit":7,"attachments":0},
"written":{"audit":0,"attachments":0},"target":{"audit":0,"attachments":0},
"objects":{"expected":1,"copied":0,"verified":0},
"problems":[{"code":"attachment_object_missing","severity":"error"},{"code":"attachment_object_missing","severity":"error"}]}]}`

func TestImportReportPrintsOneLinePerTable(t *testing.T) {
	var out bytes.Buffer
	if err := importReport(strings.NewReader(syntheticImportReport), &out); err != nil {
		t.Fatal(err)
	}
	for _, line := range []string{
		"mode dry-run, nothing written",
		"users 2 1 0",
		"SIPGES/PRJ-SECHURA",
		"attachments 1 0 0 0",
		"audit 7 7 0 0",
		"files 1 expected, 0 copied, 0 verified",
		"problem user_invalid x1",
		"problem attachment_object_missing x2",
	} {
		if !strings.Contains(strings.Join(strings.Fields(out.String()), " "), line) {
			t.Errorf("no %q in:\n%s", line, out.String())
		}
	}
}

func TestImportReportRefusesWhatIsNotAReport(t *testing.T) {
	if err := importReport(strings.NewReader("not json"), &bytes.Buffer{}); err == nil {
		t.Fatal("no error")
	}
}

func TestImportReportCommand(t *testing.T) {
	err := dispatch(t.Context(), []string{"import-report", "extra"}, lookup(map[string]string{}), &bytes.Buffer{}, nil)
	if err == nil {
		t.Fatal("extra argument accepted")
	}
}
