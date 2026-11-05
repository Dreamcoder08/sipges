package infrastructure

import (
	"testing"

	"github.com/Dreamcoder08/sipges/apps/api-go/internal/intelligence/application"
)

func TestDedupKeyOfASourceRecordIsTheOneTypeScriptComputes(t *testing.T) {
	territory := "Sechura"
	got := dedupKey(application.NewAlert{
		SHA256: "ab12", SourceURL: "https://example.org/ñ", SourceType: "Documento", Territory: &territory,
		SourceRecord: &application.SourceRecord{Module: "Narrativas", ID: "NAR-1·ñ"}, //nolint:misspell // the Spanish module name
	})
	if want := "e95eb95f2b5bd0624fac31751a645c8f105dda6edb903e6415388560f19e01e5"; got != want {
		t.Fatalf("got %s, want %s", got, want)
	}
}
