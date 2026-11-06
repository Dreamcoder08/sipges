package doctext

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"slices"
	"strconv"
	"testing"
	"time"
)

// golden is what pdf.js gives on Node for each file of testdata/pdf (spikes/pdf-text builds them).
type golden struct {
	Outcome string   `json:"outcome"`
	Pages   []string `json:"pages"`
}

func TestReadPDFGivesThePagesOfPdfJsOnNode(t *testing.T) {
	raw, err := os.ReadFile("testdata/pdf/expected.json")
	if err != nil {
		t.Fatal(err)
	}
	var want map[string]golden
	if err := json.Unmarshal(raw, &want); err != nil {
		t.Fatal(err)
	}
	if len(want) < 20 {
		t.Fatalf("only %d files in the golden", len(want))
	}
	for name, expected := range want {
		t.Run(name, func(t *testing.T) {
			data, err := os.ReadFile(filepath.Join("testdata/pdf", name))
			if err != nil {
				t.Fatal(err)
			}
			ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
			defer cancel()
			pages, tooMany, err := ReadPDF(ctx, data, 100)
			switch expected.Outcome {
			case "too_many_pages":
				if err != nil || !tooMany || pages != nil {
					t.Fatalf("pages=%d tooMany=%v err=%v", len(pages), tooMany, err)
				}
			case "unreadable":
				if !errors.Is(err, ErrPDFUnreadable) || tooMany {
					t.Fatalf("tooMany=%v err=%v", tooMany, err)
				}
			default:
				if err != nil || tooMany {
					t.Fatalf("tooMany=%v err=%v", tooMany, err)
				}
				if !slices.Equal(pages, expected.Pages) {
					t.Fatalf("got %q\nwant %q", pages, expected.Pages)
				}
			}
		})
	}
}

func TestReadPDFRefusesBeforeReadingPastThePageLimit(t *testing.T) {
	data, err := os.ReadFile("testdata/pdf/05-two-columns.pdf")
	if err != nil {
		t.Fatal(err)
	}
	_, tooMany, err := ReadPDF(t.Context(), data, 1)
	if err != nil || !tooMany {
		t.Fatalf("tooMany=%v err=%v", tooMany, err)
	}
}

func TestReadPDFStopsAtTheContextDeadline(t *testing.T) {
	data, err := os.ReadFile("testdata/pdf/71-large-101-pages.pdf")
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 200*time.Millisecond)
	defer cancel()
	start := time.Now()
	_, _, err = ReadPDF(ctx, data, 200)
	if !errors.Is(err, ErrPDFUnreadable) {
		t.Fatalf("err=%v", err)
	}
	if elapsed := time.Since(start); elapsed > 5*time.Second {
		t.Fatalf("took %v", elapsed)
	}
}

func TestReadPDFOfAnExpiredContextReadsNothing(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, _, err := ReadPDF(ctx, []byte("%PDF-1.7"), 100); !errors.Is(err, ErrPDFUnreadable) {
		t.Fatalf("err=%v", err)
	}
}

func TestReadPDFSurvivesConcurrentReads(t *testing.T) {
	data, err := os.ReadFile("testdata/pdf/01-plain-helvetica.pdf")
	if err != nil {
		t.Fatal(err)
	}
	broken := []byte("%PDF-1.4\nnot a document")
	done := make(chan error, 12)
	for i := range 12 {
		go func() {
			if i%3 == 0 {
				_, _, err := ReadPDF(t.Context(), broken, 100)
				if !errors.Is(err, ErrPDFUnreadable) {
					done <- err
					return
				}
				done <- nil
				return
			}
			_, _, err := ReadPDF(t.Context(), data, 100)
			done <- err
		}()
	}
	for range 12 {
		if err := <-done; err != nil {
			t.Fatal(err)
		}
	}
}

// formChain is a PDF of few megabytes whose form XObjects each draw the next one: deep recursion
// inside the guest, which once took a read past 1 GiB (ADR 0033).
func formChain(depth int) []byte {
	var out bytes.Buffer
	out.WriteString("%PDF-1.7\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n")
	out.WriteString("2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n")
	out.WriteString("3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]/Contents 4 0 R/Resources<</XObject<</N 10 0 R>>>>>>endobj\n")
	out.WriteString("4 0 obj<</Length 5>>stream\n/N Do\nendstream endobj\n")
	for i := range depth {
		fmt.Fprintf(&out, "%d 0 obj<</Type/XObject/Subtype/Form/BBox[0 0 200 200]/Resources<</XObject<</N %d 0 R>>>>/Length 5>>stream\n/N Do\nendstream endobj\n", 10+i, 11+i)
	}
	fmt.Fprintf(&out, "trailer<</Root 1 0 R/Size %d>>\n", 11+depth)
	return out.Bytes()
}

// The peak is the whole process's, so the read runs in a child of its own.
func TestReadPDFKeepsMemoryBoundedOnDeepRecursion(t *testing.T) {
	if raceDetector {
		t.Skip("the race detector's shadow memory hides the peak")
	}
	const child = "SIPGES_PDF_MEMORY_CHILD"
	if os.Getenv(child) == "1" {
		ctx, cancel := context.WithTimeout(context.Background(), 12*time.Second)
		defer cancel()
		_, _, _ = ReadPDF(ctx, formChain(20000), 100)
		status, err := os.ReadFile("/proc/self/status")
		if err != nil {
			t.Skip("no /proc")
		}
		fmt.Println(regexp.MustCompile(`VmHWM:\s+\d+`).FindString(string(status)))
		return
	}
	cmd := exec.Command(os.Args[0], "-test.run=^TestReadPDFKeepsMemoryBoundedOnDeepRecursion$", "-test.v")
	cmd.Env = append(os.Environ(), child+"=1", "GOMEMLIMIT=800MiB")
	output, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("%v\n%s", err, output)
	}
	match := regexp.MustCompile(`VmHWM:\s+(\d+)`).FindSubmatch(output)
	if match == nil {
		t.Skip("no peak reported")
	}
	peak, _ := strconv.Atoi(string(match[1]))
	if peak > 550*1024 {
		t.Fatalf("peak %d MiB", peak/1024)
	}
	t.Logf("peak %d MiB", peak/1024)
}
