package fileinventory

import (
	"archive/zip"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"
)

// Options tunes a scan. ShowUnconfirmedHeaders lets through first rows nothing proves are headers,
// for an owner who has looked at the file. Now is for tests.
type Options struct {
	ShowUnconfirmedHeaders bool
	Now                    func() time.Time
}

// How far into a PDF to look for its markers: the head and the tail hold every trailer that
// matters, whether the file is linearized or not.
const (
	pdfMarkerWindow = 64 << 10
	magicWindow     = 1024
)

var (
	oleMagic = []byte{0xD0, 0xCF, 0x11, 0xE0}

	// An extension is a short word; anything else after a dot is part of a file's name, which
	// must not become a line of the report.
	plainExtension = regexp.MustCompile(`^[a-z0-9]{1,12}$`)
)

type family int

const (
	familyOther family = iota
	familyPDF
	familyWord
	familyLegacy
	familySpreadsheet
	familyDelimited
)

var families = map[string]family{
	"pdf": familyPDF, "docx": familyWord, "docm": familyWord, "dotx": familyWord,
	"doc": familyLegacy, "xls": familyLegacy, "ppt": familyLegacy,
	"xlsx": familySpreadsheet, "xlsm": familySpreadsheet, "xltx": familySpreadsheet,
	"csv": familyDelimited, "tsv": familyDelimited,
}

// Scan inventories the folder at root. Unreadable entries become lines of the report; only a
// root that cannot be opened, or a cancelled context, is an error. The root handle keeps every
// open inside the folder, whatever a path turns out to be by then.
func Scan(ctx context.Context, root string, opts Options) (Report, error) {
	folder, err := os.OpenRoot(root)
	if err != nil {
		return Report{}, fmt.Errorf("open the folder: %w", err)
	}
	defer func() { _ = folder.Close() }()
	files := []File{}
	tables := []Table{}
	err = fs.WalkDir(folder.FS(), ".", func(path string, entry fs.DirEntry, walkErr error) error {
		if err := ctx.Err(); err != nil {
			return err
		}
		if path == "." {
			return walkErr
		}
		name := strings.ToValidUTF8(path, "�")
		switch {
		case walkErr != nil:
			files = append(files, File{Path: name, Type: typeFolder, Status: StatusUnreadable, Reason: reasonOf(walkErr)})
			return skipEntry(entry)
		case entry.IsDir():
			return nil
		case entry.Type()&fs.ModeSymlink != 0:
			files = append(files, File{Path: name, Type: typeLink, Status: StatusUnreadable, Reason: ReasonLink})
		case !entry.Type().IsRegular():
			files = append(files, File{Path: name, Type: typeSpecial, Status: StatusUnreadable, Reason: ReasonSpecialFile})
		default:
			line, table := inspect(folder, path, name, opts)
			files = append(files, line)
			if table != nil {
				tables = append(tables, *table)
			}
		}
		return nil
	})
	if err != nil {
		return Report{}, fmt.Errorf("walk the folder: %w", err)
	}
	now := time.Now
	if opts.Now != nil {
		now = opts.Now
	}
	return newReport(now().UTC(), files, tables), nil
}

// A folder that cannot be listed is reported once, by the visit that failed to list it.
func skipEntry(entry fs.DirEntry) error {
	if entry != nil && entry.IsDir() {
		return fs.SkipDir
	}
	return nil
}

func reasonOf(err error) string {
	switch {
	case errors.Is(err, fs.ErrPermission):
		return ReasonPermissionDenied
	case errors.Is(err, errTooLarge):
		return ReasonTooLarge
	default:
		return ReasonCorrupt
	}
}

func typeOf(path string) string {
	ext := strings.TrimPrefix(strings.ToLower(filepath.Ext(path)), ".")
	switch {
	case ext == "":
		return typeNone
	case plainExtension.MatchString(ext):
		return ext
	default:
		return typeOther
	}
}

func inspect(folder *os.Root, path, name string, opts Options) (File, *Table) {
	line := File{Path: name, Type: typeOf(path), Status: StatusUnreadable}
	f, err := folder.Open(path)
	if err != nil {
		line.Reason = reasonOf(err)
		return line, nil
	}
	defer func() { _ = f.Close() }()
	hash := sha256.New()
	if line.Bytes, err = io.Copy(hash, f); err != nil {
		line.Reason = reasonOf(err)
		return line, nil
	}
	line.SHA256 = hex.EncodeToString(hash.Sum(nil))
	if line.Bytes == 0 {
		line.Reason = ReasonEmpty
		return line, nil
	}
	var table *Table
	reason, known := "", true
	switch families[line.Type] {
	case familyPDF:
		reason = inspectPDF(f, line.Bytes)
	case familyWord:
		reason = inspectWord(f, line.Bytes)
	case familyLegacy:
		reason = ReasonCorrupt
		if bytes.HasPrefix(head(f, magicWindow), oleMagic) {
			reason = ReasonLegacyFormat
		}
	case familySpreadsheet:
		table, reason = inspectSpreadsheet(f, line.Bytes, opts)
	case familyDelimited:
		table, reason = inspectDelimited(f, line.Bytes, opts)
	case familyOther:
		known = false
	}
	switch {
	case !known:
		line.Status = StatusNotInspected
	case reason == "":
		line.Status = StatusReadable
	default:
		line.Reason = reason
	}
	if table != nil {
		table.Path = name
	}
	return line, table
}

func inspectSpreadsheet(f io.ReaderAt, size int64, opts Options) (*Table, string) {
	if bytes.HasPrefix(head(f, magicWindow), oleMagic) {
		return nil, ReasonEncrypted
	}
	sheets, err := readWorkbook(f, size, opts.ShowUnconfirmedHeaders)
	if err != nil {
		return nil, reasonOf(err)
	}
	return &Table{Format: "xlsx", Sheets: sheets}, ""
}

func inspectDelimited(f io.ReaderAt, size int64, opts Options) (*Table, string) {
	table, err := readCSV(f, size, opts.ShowUnconfirmedHeaders)
	if err != nil {
		return nil, reasonOf(err)
	}
	return &table, ""
}

func head(f io.ReaderAt, n int) []byte {
	buf := make([]byte, n)
	read, _ := f.ReadAt(buf, 0)
	return buf[:read]
}

func tail(f io.ReaderAt, size int64, n int) []byte {
	from := max(size-int64(n), 0)
	buf := make([]byte, size-from)
	read, _ := f.ReadAt(buf, from)
	return buf[:read]
}

func inspectPDF(f io.ReaderAt, size int64) string {
	if !bytes.Contains(head(f, magicWindow), []byte("%PDF-")) ||
		!bytes.Contains(tail(f, size, magicWindow), []byte("%%EOF")) {
		return ReasonCorrupt
	}
	encrypt := []byte("/Encrypt")
	if bytes.Contains(head(f, pdfMarkerWindow), encrypt) || bytes.Contains(tail(f, size, pdfMarkerWindow), encrypt) {
		return ReasonEncrypted
	}
	return ""
}

// inspectWord proves the document body inflates, and throws it away: nothing of it is kept. A
// password turns an Office file into a compound file, the same container as the old formats.
func inspectWord(f io.ReaderAt, size int64) string {
	if bytes.HasPrefix(head(f, magicWindow), oleMagic) {
		return ReasonEncrypted
	}
	archive, err := zip.NewReader(f, size)
	if err != nil {
		return ReasonCorrupt
	}
	body, err := archive.Open("word/document.xml")
	if err != nil {
		return ReasonCorrupt
	}
	defer func() { _ = body.Close() }()
	budget := unpackLimit
	if _, err := io.Copy(io.Discard, bounded(body, &budget, 0, 0)); err != nil {
		return reasonOf(err)
	}
	return ""
}
