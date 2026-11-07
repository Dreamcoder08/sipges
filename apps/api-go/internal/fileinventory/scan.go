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
	"slices"
	"strings"
	"time"
)

// Options tunes a scan. Now is for tests.
type Options struct {
	Now func() time.Time
}

// How far into a PDF to look for its markers: the head and the tail hold every trailer that
// matters, whether the file is linearized or not.
const (
	pdfMarkerWindow = 64 << 10
	magicWindow     = 1024
)

var (
	oleMagic = []byte{0xD0, 0xCF, 0x11, 0xE0}

	// What may name a type. Anything else after a dot is part of a file's name ("Juan.Perez",
	// "dni.12345678"), which must not become a line of the summary.
	knownExtensions = extensionSet("pdf doc docx docm dotx xls xlsx xlsm xltx xlsb csv tsv txt rtf " +
		"ppt pptx odt ods odp jpg jpeg png gif tif tiff bmp webp heic zip rar 7z gz tar msg eml " +
		"html htm xml json db sqlite sql mp3 mp4 mov wav dwg dxf shp kml kmz")
)

func extensionSet(list string) map[string]bool {
	set := map[string]bool{}
	for _, ext := range strings.Fields(list) {
		set[ext] = true
	}
	return set
}

type family int

const (
	familyOther family = iota
	familyPDF
	familyWord
	familyLegacy
)

var families = map[string]family{
	"pdf": familyPDF, "docx": familyWord, "docm": familyWord, "dotx": familyWord,
	"doc": familyLegacy, "xls": familyLegacy, "ppt": familyLegacy,
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
	walk := walker{folder: folder, files: []File{}}
	if err := walk.dir(ctx, "."); err != nil {
		return Report{}, fmt.Errorf("walk the folder: %w", err)
	}
	now := time.Now
	if opts.Now != nil {
		now = opts.Now
	}
	return newReport(now().UTC(), walk.files), nil
}

type walker struct {
	folder *os.Root
	files  []File
}

// dir lists with the file itself and not with fs.WalkDir: the fs.FS of a root refuses a name that
// is not UTF-8, and an old USB is full of Latin-1 folders whose files must still be counted.
func (w *walker) dir(ctx context.Context, path string) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	entries, err := w.list(path)
	if err != nil {
		if path == "." {
			return err
		}
		w.files = append(w.files, File{Path: printable(path), Type: typeFolder, Status: StatusUnreadable, Reason: reasonOf(err)})
		return nil
	}
	slices.SortFunc(entries, func(a, b os.DirEntry) int { return strings.Compare(a.Name(), b.Name()) })
	for _, entry := range entries {
		child := entry.Name()
		if path != "." {
			child = path + "/" + child
		}
		name := printable(child)
		switch {
		case entry.IsDir():
			if err := w.dir(ctx, child); err != nil {
				return err
			}
		case entry.Type()&fs.ModeSymlink != 0:
			w.files = append(w.files, File{Path: name, Type: typeLink, Status: StatusUnreadable, Reason: ReasonLink})
		case !entry.Type().IsRegular():
			w.files = append(w.files, File{Path: name, Type: typeSpecial, Status: StatusUnreadable, Reason: ReasonSpecialFile})
		default:
			if err := ctx.Err(); err != nil {
				return err
			}
			w.files = append(w.files, inspect(w.folder, child, name))
		}
	}
	return nil
}

func (w *walker) list(path string) ([]os.DirEntry, error) {
	f, err := w.folder.Open(path)
	if err != nil {
		return nil, err
	}
	defer func() { _ = f.Close() }()
	return f.ReadDir(-1)
}

func printable(path string) string { return strings.ToValidUTF8(path, "\uFFFD") }

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
	case knownExtensions[ext]:
		return ext
	default:
		return typeOther
	}
}

func inspect(folder *os.Root, path, name string) File {
	line := File{Path: name, Type: typeOf(path), Status: StatusUnreadable}
	f, err := folder.Open(path)
	if err != nil {
		line.Reason = reasonOf(err)
		return line
	}
	defer func() { _ = f.Close() }()
	hash := sha256.New()
	if line.Bytes, err = io.Copy(hash, f); err != nil {
		line.Reason = reasonOf(err)
		return line
	}
	line.SHA256 = hex.EncodeToString(hash.Sum(nil))
	if line.Bytes == 0 {
		line.Reason = ReasonEmpty
		return line
	}
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
	return line
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
	if _, err := io.Copy(io.Discard, bounded(body, maxPartBytes, 0, 0)); err != nil {
		return reasonOf(err)
	}
	return ""
}
