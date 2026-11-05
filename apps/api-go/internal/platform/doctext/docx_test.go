package doctext

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"os"
	"reflect"
	"strings"
	"testing"
	"time"
)

// docxFixture is the docx section of internal/documents/testdata/fixtures.json: Word packages
// and what readDocx of the TypeScript API read from them (generate.mjs).
type docxFixture struct {
	Docx []struct {
		Name    string `json:"name"`
		Data    string `json:"data"`
		Error   bool   `json:"error"`
		Content *struct {
			Paragraphs []string     `json:"paragraphs"`
			Tables     [][][]string `json:"tables"`
		} `json:"content"`
	} `json:"docx"`
}

func TestReadDOCXReadsLikeTheTypeScriptReader(t *testing.T) {
	raw, err := os.ReadFile("../../documents/testdata/fixtures.json")
	if err != nil {
		t.Fatal(err)
	}
	var f docxFixture
	if err := json.Unmarshal(raw, &f); err != nil {
		t.Fatal(err)
	}
	if len(f.Docx) < 20 {
		t.Fatalf("only %d recorded packages", len(f.Docx))
	}
	for _, c := range f.Docx {
		data, err := base64.StdEncoding.DecodeString(c.Data)
		if err != nil {
			t.Fatal(err)
		}
		got, err := ReadDOCX(context.Background(), data)
		if c.Error {
			if err == nil {
				t.Errorf("%s: read %+v, TypeScript refused it", c.Name, got)
			}
			continue
		}
		if err != nil {
			t.Errorf("%s: %v, TypeScript read it", c.Name, err)
			continue
		}
		if !reflect.DeepEqual(got.Paragraphs, c.Content.Paragraphs) || !reflect.DeepEqual(got.Tables, c.Content.Tables) {
			t.Errorf("%s:\n got %q %q\nwant %q %q", c.Name, got.Paragraphs, got.Tables, c.Content.Paragraphs, c.Content.Tables)
		}
	}
}

func TestReadDOCXStopsWhenTheContextEnds(t *testing.T) {
	body := make([]byte, 0, 1<<20)
	body = append(body, `<w:document><w:body>`...)
	for len(body) < 1<<20 {
		body = append(body, `<w:p><w:r><w:t>x</w:t></w:r></w:p>`...)
	}
	body = append(body, `</w:body></w:document>`...)
	ctx, cancel := context.WithDeadline(context.Background(), time.Now().Add(-time.Second))
	defer cancel()
	if _, err := parseXML(ctx, string(body)); err == nil {
		t.Fatal("an expired context did not stop the parse")
	}
}

func TestUnzipRefusesAnOversizedPart(t *testing.T) {
	// A stored entry whose central directory declares more than MaxDocumentXMLBytes is skipped,
	// as fflate's filter skips it, so the package has no body part.
	pkg := storedZip("word/document.xml", []byte("<x/>"))
	cd := centralOffset(pkg)
	size := MaxDocumentXMLBytes + 1
	pkg[cd+24], pkg[cd+25], pkg[cd+26], pkg[cd+27] = byte(size), byte(size>>8), byte(size>>16), byte(size>>24)
	if _, err := unzipPart(context.Background(), pkg); err == nil {
		t.Fatal("an oversized part was read")
	}
}

// TestHostilePackagesStopAtTheDeadline: a directory claiming 2^32-1 entries and a package of
// many entries naming the body part (each a 32 MiB deflate bomb) end within the deadline.
func TestHostilePackagesStopAtTheDeadline(t *testing.T) {
	// End of central directory (ZIP64) claiming 0xFFFFFFFF entries, with no entries at all.
	huge := make([]byte, 0, 98)
	huge = append(huge, 'P', 'K', 6, 6)                                                 // ZIP64 end of central directory at 0
	huge = append(huge, make([]byte, 28)...)                                            // up to the entry count at 32
	huge = append(huge, 0xff, 0xff, 0xff, 0xff, 0, 0, 0, 0)                             // count
	huge = append(huge, make([]byte, 16)...)                                            // offset 0 at 48
	huge = append(huge, 'P', 'K', 6, 7, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0) // locator → 0
	huge = append(huge, 'P', 'K', 5, 6)
	huge = append(huge, make([]byte, 18)...)
	start := time.Now()
	if _, err := ReadDOCX(context.Background(), huge); err == nil {
		t.Fatal("read a package without entries")
	}
	if d := time.Since(start); d > 2*time.Second {
		t.Fatalf("an entry count of 2^32-1 took %v", d)
	}

	bomb := deflatedZip(t, 20, MaxDocumentXMLBytes)
	ctx, cancel := context.WithTimeout(context.Background(), 200*time.Millisecond)
	defer cancel()
	start = time.Now()
	_, _ = ReadDOCX(ctx, bomb)
	if d := time.Since(start); d > 3*time.Second {
		t.Fatalf("20 duplicate 32 MiB parts took %v past a 200 ms deadline", d)
	}
}

func TestMarkupBeyondMaxNodesIsUnreadable(t *testing.T) {
	xml := "<w:document><w:body>" + strings.Repeat("<a/>", MaxNodes) + "</w:body></w:document>"
	if _, err := parseXML(context.Background(), xml); err == nil {
		t.Fatal("a tree over MaxNodes was read")
	}
}
