package doctext

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"
)

// fakeOCR puts a shell script named ocrmypdf first in PATH; it records its arguments, then runs body.
func fakeOCR(t *testing.T, body string) (log string) {
	t.Helper()
	dir := t.TempDir()
	log = filepath.Join(dir, "log")
	script := "#!/bin/sh\necho \"$@\" > " + log + "\nsidecar=$6\ninput=$7\n" + body + "\n"
	if err := os.WriteFile(filepath.Join(dir, "ocrmypdf"), []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", dir+string(os.PathListSeparator)+os.Getenv("PATH"))
	return log
}

func scratch(t *testing.T) {
	t.Helper()
	t.Setenv("TMPDIR", t.TempDir())
}

func leftovers(t *testing.T) []string {
	t.Helper()
	entries, err := os.ReadDir(os.Getenv("TMPDIR"))
	if err != nil {
		t.Fatal(err)
	}
	names := []string{}
	for _, e := range entries {
		names = append(names, e.Name())
	}
	return names
}

func TestNewOCRIsOffWithoutTheBinary(t *testing.T) {
	t.Setenv("PATH", t.TempDir())
	if NewOCR(true, "spa+eng") != nil {
		t.Fatal("no binary, no OCR")
	}
}

func TestNewOCRIsOffUnlessAskedFor(t *testing.T) {
	fakeOCR(t, "")
	if NewOCR(false, "spa+eng") != nil {
		t.Fatal("the binary alone must not turn OCR on")
	}
}

func TestRecognizeRunsOcrmypdfOnAPrivateCopyAndSplitsItsSidecar(t *testing.T) {
	scratch(t)
	log := fakeOCR(t, `stat -c %a "$input" > `+os.Getenv("TMPDIR")+`-mode
printf 'uno\fdos\f' > "$sidecar"`)
	ocr := NewOCR(true, "spa")
	if ocr == nil {
		t.Fatal("the binary is present")
	}
	pages, err := ocr.Recognize(t.Context(), []byte("%PDF-scan"))
	if err != nil {
		t.Fatal(err)
	}
	if !slices.Equal(pages, []string{"uno", "dos", ""}) {
		t.Fatalf("pages=%q", pages)
	}
	args, _ := os.ReadFile(log)
	fields := strings.Fields(string(args))
	if len(fields) != 8 || !slices.Equal(fields[:5], []string{"--skip-text", "--quiet", "-l", "spa", "--sidecar"}) ||
		filepath.Base(fields[5]) != "text.txt" || filepath.Base(fields[6]) != "in.pdf" || filepath.Base(fields[7]) != "out.pdf" ||
		!strings.HasPrefix(filepath.Base(filepath.Dir(fields[6])), "sipges-ocr-") {
		t.Fatalf("args=%q", fields)
	}
	mode, _ := os.ReadFile(os.Getenv("TMPDIR") + "-mode")
	if strings.TrimSpace(string(mode)) != "600" {
		t.Fatalf("mode=%q", mode)
	}
	if rest := leftovers(t); len(rest) != 0 {
		t.Fatalf("left %v", rest)
	}
}

func TestRecognizeDecodesTheSidecarAsNodeDoes(t *testing.T) {
	scratch(t)
	fakeOCR(t, `printf 'a\377b' > "$sidecar"`)
	pages, err := NewOCR(true, "spa").Recognize(t.Context(), []byte("x"))
	if err != nil || !slices.Equal(pages, []string{"a�b"}) {
		t.Fatalf("pages=%q err=%v", pages, err)
	}
}

func TestRecognizeFailsWhenOcrmypdfFails(t *testing.T) {
	scratch(t)
	fakeOCR(t, "exit 3")
	if _, err := NewOCR(true, "spa").Recognize(t.Context(), []byte("x")); err == nil {
		t.Fatal("exit 3 must fail")
	}
	if rest := leftovers(t); len(rest) != 0 {
		t.Fatalf("left %v", rest)
	}
}

func TestRecognizeKillsTheWholeProcessGroupAtItsTimeout(t *testing.T) {
	scratch(t)
	marker := filepath.Join(t.TempDir(), "survived")
	fakeOCR(t, `(sleep 1; touch `+marker+`) &
sleep 30`)
	ocr := NewOCR(true, "spa")
	ocr.timeout = 100 * time.Millisecond
	start := time.Now()
	if _, err := ocr.Recognize(context.Background(), []byte("x")); err == nil {
		t.Fatal("a timeout must fail")
	}
	if elapsed := time.Since(start); elapsed > 3*time.Second {
		t.Fatalf("took %v", elapsed)
	}
	time.Sleep(1200 * time.Millisecond)
	if _, err := os.Stat(marker); err == nil {
		t.Fatal("a child outlived the timeout")
	}
	if rest := leftovers(t); len(rest) != 0 {
		t.Fatalf("left %v", rest)
	}
}

func TestRecognizeFailsWhenItsOutputPassesTheBuffer(t *testing.T) {
	scratch(t)
	fakeOCR(t, `head -c 1100000 /dev/zero
printf 'x' > "$sidecar"`)
	if _, err := NewOCR(true, "spa").Recognize(t.Context(), []byte("x")); err == nil {
		t.Fatal("output past 1 MiB must fail, as maxBuffer does")
	}
}

type stubReader struct {
	pages   []string
	tooMany bool
	err     error
}

func (s stubReader) read(context.Context, []byte, int) ([]string, bool, error) {
	return s.pages, s.tooMany, s.err
}

func TestWithOCR(t *testing.T) {
	scratch(t)
	fakeOCR(t, `printf 'reconocido' > "$sidecar"`)
	ocr := NewOCR(true, "spa")
	broken := errors.New("broken")
	cases := []struct {
		name    string
		reader  stubReader
		ocr     *OCR
		pages   []string
		tooMany bool
		err     error
	}{
		{name: "pages with text stay", reader: stubReader{pages: []string{"", "texto"}}, ocr: ocr, pages: []string{"", "texto"}},
		{name: "blank pages are recognized", reader: stubReader{pages: []string{" \n" + string(rune(0xfeff)), ""}}, ocr: ocr, pages: []string{"reconocido"}},
		{name: "a PDF without pages is recognized", reader: stubReader{pages: []string{}}, ocr: ocr, pages: []string{"reconocido"}},
		{name: "U+0085 is text for JavaScript trim", reader: stubReader{pages: []string{"\u0085"}}, ocr: ocr, pages: []string{"\u0085"}},
		{name: "too many pages stays refused", reader: stubReader{tooMany: true}, ocr: ocr, tooMany: true},
		{name: "an unreadable PDF stays unreadable", reader: stubReader{err: broken}, ocr: ocr, err: broken},
		{name: "off", reader: stubReader{pages: []string{""}}, pages: []string{""}},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			pages, tooMany, err := withOCR(t.Context(), c.reader.read, []byte("x"), 100, c.ocr)
			if !errors.Is(err, c.err) || tooMany != c.tooMany || !slices.Equal(pages, c.pages) {
				t.Fatalf("pages=%q tooMany=%v err=%v", pages, tooMany, err)
			}
		})
	}
}

func TestReadScannedPDFAsksTheRecognizerOnlyWhenBlank(t *testing.T) {
	scratch(t)
	fakeOCR(t, `printf 'acta reconocida' > "$sidecar"`)
	scan, err := os.ReadFile("testdata/pdf/30-scanned-image-only.pdf")
	if err != nil {
		t.Fatal(err)
	}
	ocr := NewOCR(true, "spa")
	pages, tooMany, err := ocr.ReadPDF(t.Context(), scan, 100, time.Minute)
	if err != nil || tooMany || !slices.Equal(pages, []string{"acta reconocida"}) {
		t.Fatalf("pages=%q tooMany=%v err=%v", pages, tooMany, err)
	}
	var off *OCR
	pages, _, err = off.ReadPDF(t.Context(), scan, 100, time.Minute)
	if err != nil || len(pages) != 1 || strings.TrimSpace(pages[0]) != "" {
		t.Fatalf("off: pages=%q err=%v", pages, err)
	}
}

// Runs only where ocrmypdf is installed; no CI image has it (ADR 0033).
func TestRecognizeWithTheRealOcrmypdf(t *testing.T) {
	ocr := NewOCR(true, "spa+eng")
	if ocr == nil {
		t.Skip("ocrmypdf is not installed")
	}
	path := os.Getenv("SIPGES_OCR_TEST_PDF")
	if path == "" {
		t.Skip("SIPGES_OCR_TEST_PDF names a legible scan")
	}
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	start := time.Now()
	pages, tooMany, err := ocr.ReadPDF(t.Context(), data, 100, time.Minute)
	if err != nil || tooMany || !strings.Contains(strings.Join(pages, ""), "reunión") {
		t.Fatalf("pages=%q tooMany=%v err=%v", pages, tooMany, err)
	}
	t.Logf("%d pages in %v", len(pages), time.Since(start))
}

func TestRecognizeRefusesASidecarThatIsNotAPlainFile(t *testing.T) {
	for name, body := range map[string]string{
		"a pipe":    `mkfifo "$sidecar"`,
		"a symlink": `ln -s /etc/hostname "$sidecar"`,
		"too large": `truncate -s 64M "$sidecar"`,
	} {
		t.Run(name, func(t *testing.T) {
			scratch(t)
			fakeOCR(t, body)
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			if _, err := NewOCR(true, "spa").Recognize(ctx, []byte("x")); err == nil {
				t.Fatal("the sidecar must be refused")
			}
			if ctx.Err() != nil {
				t.Fatal("the refusal must not wait for a limit")
			}
			if rest := leftovers(t); len(rest) != 0 {
				t.Fatalf("left %v", rest)
			}
		})
	}
}

func TestRecognizeLeavesNoChildBehindWhenOcrmypdfExits(t *testing.T) {
	scratch(t)
	marker := filepath.Join(t.TempDir(), "survived")
	fakeOCR(t, `(sleep 1; touch `+marker+`) >/dev/null 2>&1 &
printf 'texto' > "$sidecar"`)
	if _, err := NewOCR(true, "spa").Recognize(t.Context(), []byte("x")); err != nil {
		t.Fatal(err)
	}
	time.Sleep(1200 * time.Millisecond)
	if _, err := os.Stat(marker); err == nil {
		t.Fatal("a child outlived ocrmypdf")
	}
}
