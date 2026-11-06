package doctext

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"time"
)

const (
	// ocrBinary is looked up in PATH at the start.
	ocrBinary = "ocrmypdf"
	// ocrTimeout: a scanned PDF of 100 pages takes minutes on one core; anything longer is abandoned.
	ocrTimeout = 5 * time.Minute
	// ocrOutputLimit is execFile's maxBuffer in ocr.ts.
	ocrOutputLimit = 1 << 20
	// ocrSidecarLimit is far above the text of the 100 pages a PDF may have.
	ocrSidecarLimit = 32 << 20
	// ocrWaitDelay bounds the wait for pipes after the process group was killed.
	ocrWaitDelay = 2 * time.Second
)

// LongestRead bounds a response that reads one document: its read, then OCR, with a margin.
const LongestRead = defaultPDFBudget + ocrTimeout + 30*time.Second

// OCR is ocrmypdfRecognizer of ocr.ts: the local ocrmypdf (Tesseract) on a private temporary copy,
// read back from its text sidecar. Nothing leaves the server. A nil *OCR is OCR turned off.
type OCR struct {
	binary    string
	languages string
	timeout   time.Duration
}

// NewOCR returns the recognizer, or nil unless it was asked for and the binary is in PATH.
func NewOCR(enabled bool, languages string) *OCR {
	if !enabled {
		return nil
	}
	binary, err := exec.LookPath(ocrBinary)
	if err != nil {
		return nil
	}
	return &OCR{binary: binary, languages: languages, timeout: ocrTimeout}
}

// boundedOutput fails the process once it writes more than the buffer of execFile.
type boundedOutput struct {
	mu      sync.Mutex
	written int
	stop    context.CancelFunc
}

func (b *boundedOutput) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.written += len(p)
	if b.written > ocrOutputLimit {
		b.stop()
		return 0, errors.New("doctext: ocrmypdf wrote too much")
	}
	return len(p), nil
}

// Recognize returns one text per page, in page order. Pages are separated by form feeds in the
// sidecar.
func (o *OCR) Recognize(ctx context.Context, data []byte) ([]string, error) {
	dir, err := os.MkdirTemp("", "sipges-ocr-")
	if err != nil {
		return nil, fmt.Errorf("doctext: OCR directory: %w", err)
	}
	defer func() { _ = os.RemoveAll(dir) }()
	input := filepath.Join(dir, "in.pdf")
	sidecar := filepath.Join(dir, "text.txt")
	if err := os.WriteFile(input, data, 0o600); err != nil { //nolint:gosec // input is a fixed name in a directory made above
		return nil, fmt.Errorf("doctext: OCR input: %w", err)
	}
	ctx, cancel := context.WithTimeout(ctx, o.timeout)
	defer cancel()
	// The binary and the languages come from the server's own settings, never from a request.
	cmd := exec.CommandContext(ctx, o.binary, //nolint:gosec // see above
		"--skip-text", "--quiet", "-l", o.languages, "--sidecar", sidecar, input, filepath.Join(dir, "out.pdf"))
	output := &boundedOutput{stop: cancel}
	cmd.Stdout, cmd.Stderr = output, output
	// Its own process group: ocrmypdf starts Tesseract and Ghostscript, which must stop with it.
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	cmd.Cancel = func() error { return syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL) }
	cmd.WaitDelay = ocrWaitDelay
	err = cmd.Run()
	if cmd.Process != nil {
		// Children may outlive a leader that exited on its own; an empty group answers ESRCH.
		_ = syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL)
	}
	if err != nil {
		return nil, fmt.Errorf("doctext: ocrmypdf: %w", err)
	}
	text, err := readSidecar(sidecar)
	if err != nil {
		return nil, err
	}
	return strings.Split(DecodeUTF8(text, false), "\f"), nil
}

// readSidecar reads the text file ocrmypdf writes. Anything else there, such as a pipe that
// would block with no process left to time out, or a link, is refused unread.
func readSidecar(path string) ([]byte, error) {
	info, err := os.Lstat(path)
	if err != nil {
		return nil, fmt.Errorf("doctext: OCR sidecar: %w", err)
	}
	if !info.Mode().IsRegular() || info.Size() > ocrSidecarLimit {
		return nil, errors.New("doctext: OCR sidecar is not a text file of a sane size")
	}
	text, err := os.ReadFile(path) //nolint:gosec // a path built by Recognize in a private directory
	if err != nil {
		return nil, fmt.Errorf("doctext: OCR sidecar: %w", err)
	}
	return text, nil
}

type pdfReader func(ctx context.Context, data []byte, maxPages int) ([]string, bool, error)

// isJSSpace is what String#trim removes, which is not unicode.IsSpace: U+FEFF is in, U+0085 out.
func isJSSpace(r rune) bool {
	switch r {
	case '\t', '\n', '\v', '\f', '\r', ' ', 0xa0, 0x1680, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000, 0xfeff:
		return true
	}
	return r >= 0x2000 && r <= 0x200a
}

func blankPages(pages []string) bool {
	for _, page := range pages {
		if strings.TrimFunc(page, isJSSpace) != "" {
			return false
		}
	}
	return true
}

// withOCR is withOcr of ocr.ts: OCR only when a PDF within the page limit has no text layer.
func withOCR(ctx context.Context, read pdfReader, data []byte, maxPages int, o *OCR) ([]string, bool, error) {
	pages, tooMany, err := read(ctx, data, maxPages)
	if err != nil || tooMany || o == nil || !blankPages(pages) {
		return pages, tooMany, err
	}
	recognized, err := o.Recognize(ctx, data)
	return recognized, false, err
}

// ReadPDF reads a PDF within timeout, as the PDF worker pool bounds a job, and falls back to OCR,
// which has its own limit, on a PDF without text. On a nil *OCR it only reads.
func (o *OCR) ReadPDF(ctx context.Context, data []byte, maxPages int, timeout time.Duration) ([]string, bool, error) {
	read := func(ctx context.Context, data []byte, maxPages int) ([]string, bool, error) {
		ctx, cancel := context.WithTimeout(ctx, timeout)
		defer cancel()
		return ReadPDF(ctx, data, maxPages)
	}
	return withOCR(ctx, read, data, maxPages, o)
}
