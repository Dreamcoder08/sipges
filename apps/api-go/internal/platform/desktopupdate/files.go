package desktopupdate

import (
	"bytes"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"syscall"
	"time"
)

// isLink reports a symbolic link, or a Windows junction or other reparse point, which Go 1.23+
// reports as irregular rather than as a directory.
func isLink(mode fs.FileMode) bool { return mode&(fs.ModeSymlink|fs.ModeIrregular) != 0 }

func pathExists(path string) (bool, error) {
	_, err := os.Lstat(path)
	if err == nil {
		return true, nil
	}
	if errors.Is(err, fs.ErrNotExist) {
		return false, nil
	}
	return false, err
}

// readJSON decodes a JSON file into v; it reports false when the file does not exist.
func readJSON(path string, v any) (bool, error) {
	data, err := os.ReadFile(path) //nolint:gosec // paths are the install's own files
	if errors.Is(err, fs.ErrNotExist) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	if err := json.Unmarshal(data, v); err != nil {
		return false, fmt.Errorf("%s: %w", path, err)
	}
	return true, nil
}

// marshal writes JSON as JSON.stringify does: no HTML escaping, two-space indent when pretty.
func marshal(v any, pretty bool) ([]byte, error) {
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	if pretty {
		enc.SetIndent("", "  ")
	}
	if err := enc.Encode(v); err != nil {
		return nil, err
	}
	if pretty {
		return buf.Bytes(), nil
	}
	return bytes.TrimSuffix(buf.Bytes(), []byte("\n")), nil
}

func newUUID() string {
	var b [16]byte
	_, _ = rand.Read(b[:])
	b[6] = (b[6] & 0x0f) | 0x40
	b[8] = (b[8] & 0x3f) | 0x80
	h := hex.EncodeToString(b[:])
	return h[0:8] + "-" + h[8:12] + "-" + h[12:16] + "-" + h[16:20] + "-" + h[20:]
}

// writeFileNew writes a new file (it must not exist) and flushes it.
func writeFileNew(path string, data []byte, flush bool) (err error) {
	file, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600) //nolint:gosec // install-owned path
	if err != nil {
		return err
	}
	defer func() {
		if closeErr := file.Close(); err == nil {
			err = closeErr
		}
	}()
	if _, err = file.Write(data); err != nil {
		return err
	}
	if flush {
		return file.Sync()
	}
	return nil
}

// writeJSONAtomic writes and flushes a temp file beside the target, then replaces the target
// with one rename, as JSON.stringify(value, null, 2) plus a newline.
func writeJSONAtomic(path string, value any) error {
	data, err := marshal(value, true)
	if err != nil {
		return err
	}
	temporary := path + "." + newUUID() + ".tmp"
	if err := writeFileNew(temporary, data, true); err != nil {
		_ = os.Remove(temporary)
		return err
	}
	if err := RenameRetry(temporary, path); err != nil {
		_ = os.Remove(temporary)
		return err
	}
	return syncDirectory(filepath.Dir(path))
}

func syncDirectory(path string) error {
	if runtime.GOOS == "windows" {
		return nil
	}
	dir, err := os.Open(path) //nolint:gosec // install-owned folder
	if err != nil {
		return err
	}
	defer func() { _ = dir.Close() }()
	return dir.Sync()
}

// stamp is the UTC time in copy names: 20261111T101530Z.
func stamp(t time.Time) string { return t.UTC().Format("20060102T150405Z") }

// isoTime is JavaScript's Date.toISOString.
func isoTime(t time.Time) string { return t.UTC().Format("2006-01-02T15:04:05.000Z") }

// freeName is base, or base-2, base-3… : the first name with neither it nor its .partial taken.
func freeName(base string) (string, error) {
	for n := 1; ; n++ {
		candidate := base
		if n > 1 {
			candidate = fmt.Sprintf("%s-%d", base, n)
		}
		taken, err := pathExists(candidate)
		if err != nil {
			return "", err
		}
		partial, err := pathExists(candidate + ".partial")
		if err != nil {
			return "", err
		}
		if !taken && !partial {
			return candidate, nil
		}
	}
}

// copyFile copies one file to a new name with its mode and times.
func copyFile(source, target string, info fs.FileInfo) (err error) {
	in, err := os.Open(source) //nolint:gosec // install-owned or state path
	if err != nil {
		return err
	}
	defer func() { _ = in.Close() }()
	out, err := os.OpenFile(target, os.O_WRONLY|os.O_CREATE|os.O_EXCL, info.Mode().Perm()) //nolint:gosec // see above
	if err != nil {
		return err
	}
	if _, err = io.Copy(out, in); err != nil {
		_ = out.Close()
		return err
	}
	if err = out.Close(); err != nil {
		return err
	}
	if err = os.Chmod(target, info.Mode().Perm()); err != nil {
		return err
	}
	return os.Chtimes(target, info.ModTime(), info.ModTime())
}

// copyDir copies a folder to a new name, as fs.cp with errorOnExist, preserveTimestamps and
// verbatimSymlinks: modes and times kept, links copied as links, never followed.
func copyDir(source, target string) error {
	info, err := os.Lstat(source)
	if err != nil {
		return err
	}
	if err := os.Mkdir(target, 0o700); err != nil {
		return err
	}
	entries, err := os.ReadDir(source)
	if err != nil {
		return err
	}
	for _, entry := range entries {
		from, to := filepath.Join(source, entry.Name()), filepath.Join(target, entry.Name())
		child, err := os.Lstat(from)
		if err != nil {
			return err
		}
		switch {
		case child.Mode()&fs.ModeSymlink != 0:
			link, err := os.Readlink(from)
			if err != nil {
				return err
			}
			if err := os.Symlink(link, to); err != nil {
				return err
			}
		case child.IsDir():
			if err := copyDir(from, to); err != nil {
				return err
			}
		case child.Mode().IsRegular():
			if err := copyFile(from, to, child); err != nil {
				return err
			}
		default:
			return fmt.Errorf("cannot copy the special file %s", from)
		}
	}
	if err := os.Chmod(target, info.Mode().Perm()); err != nil {
		return err
	}
	return os.Chtimes(target, info.ModTime(), info.ModTime())
}

// copyTree makes a complete copy or nothing at the target name: copy under .partial, then rename.
func copyTree(source, target string) error {
	// Copying a link would copy the link, not the data: the "copy" would follow the live folder.
	info, err := os.Lstat(source)
	if err != nil {
		return err
	}
	if !info.IsDir() || isLink(info.Mode()) {
		return refuse("The state folder %s is a link; record the real folder instead", source)
	}
	partial := target + ".partial"
	if err := os.RemoveAll(partial); err != nil {
		return err
	}
	if err := copyDir(source, partial); err != nil {
		// A partial copy (a full disk) is the updater's own; the source was only read.
		_ = os.RemoveAll(partial)
		return err
	}
	return RenameRetry(partial, target)
}

func hashFile(path string) (string, error) {
	file, err := os.Open(path) //nolint:gosec // install-owned or release path
	if err != nil {
		return "", err
	}
	defer func() { _ = file.Close() }()
	hash := sha256.New()
	if _, err := io.Copy(hash, file); err != nil {
		return "", err
	}
	return hex.EncodeToString(hash.Sum(nil)), nil
}

type tree struct {
	files       map[string]string // POSIX relative path -> path
	links       map[string]string
	directories []string
}

// scanTree lists a tree without following links: files, directory links and directories.
func scanTree(root string) (tree, error) {
	out := tree{files: map[string]string{}, links: map[string]string{}}
	var walk func(dir, prefix string) error
	walk = func(dir, prefix string) error {
		entries, err := os.ReadDir(dir)
		if err != nil {
			return err
		}
		for _, entry := range entries {
			rel := entry.Name()
			if prefix != "" {
				rel = prefix + "/" + entry.Name()
			}
			path := filepath.Join(dir, entry.Name())
			mode := entry.Type()
			switch {
			case isLink(mode):
				out.links[rel] = path
			case mode.IsDir():
				out.directories = append(out.directories, rel)
				if err := walk(path, rel); err != nil {
					return err
				}
			case mode.IsRegular():
				out.files[rel] = path
			default:
				return refuse("Unsupported file type in package: %s", rel)
			}
		}
		return nil
	}
	return out, walk(root, "")
}

// treeShape lists every entry of a tree with its kind and, for a file, the SHA-256 of its
// content; links are not followed. Two trees with the same shape hold the same bytes by name.
func treeShape(root string) (string, error) {
	var shape []string
	var walk func(dir, prefix string) error
	walk = func(dir, prefix string) error {
		entries, err := os.ReadDir(dir) // sorted by name
		if err != nil {
			return err
		}
		for _, entry := range entries {
			rel := entry.Name()
			if prefix != "" {
				rel = prefix + "/" + entry.Name()
			}
			full := filepath.Join(dir, entry.Name())
			mode := entry.Type()
			switch {
			case mode.IsDir() && !isLink(mode):
				shape = append(shape, rel+"/")
				if err := walk(full, rel); err != nil {
					return err
				}
			case mode.IsRegular():
				hash, err := hashFile(full)
				if err != nil {
					return err
				}
				shape = append(shape, rel+" "+hash)
			default:
				shape = append(shape, rel+" (other)")
			}
		}
		return nil
	}
	if err := walk(root, ""); err != nil {
		return "", err
	}
	return strings.Join(shape, "\n"), nil
}

func treeBytes(root string) (int64, error) {
	var total int64
	entries, err := os.ReadDir(root)
	if err != nil {
		return 0, err
	}
	for _, entry := range entries {
		full := filepath.Join(root, entry.Name())
		if entry.IsDir() {
			n, err := treeBytes(full)
			if err != nil {
				return 0, err
			}
			total += n
			continue
		}
		info, err := os.Lstat(full)
		if err != nil {
			return 0, err
		}
		total += info.Size()
	}
	return total, nil
}

// inside reports whether child is parent or below it (case-insensitive on Windows, as Node's
// path.relative is there).
func inside(parent, child string) bool {
	if runtime.GOOS == "windows" {
		parent, child = strings.ToLower(parent), strings.ToLower(child)
	}
	rel, err := filepath.Rel(parent, child)
	if err != nil {
		return false
	}
	return rel == "." || (rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator)) && !filepath.IsAbs(rel))
}

// field is one key of a log line; lines keep their key order, as JSON.stringify does.
type field struct {
	key   string
	value any
}

func logLine(fields []field) ([]byte, error) {
	var buf bytes.Buffer
	buf.WriteByte('{')
	for i, f := range fields {
		if i > 0 {
			buf.WriteByte(',')
		}
		key, err := marshal(f.key, false)
		if err != nil {
			return nil, err
		}
		value, err := marshal(f.value, false)
		if err != nil {
			return nil, err
		}
		buf.Write(key)
		buf.WriteByte(':')
		buf.Write(value)
	}
	buf.WriteString("}\n")
	return buf.Bytes(), nil
}

// logEvent appends one JSON line to update.log, time first.
func logEvent(root string, fields ...field) error {
	line, err := logLine(append([]field{{"time", isoTime(time.Now())}}, fields...))
	if err != nil {
		return err
	}
	file, err := os.OpenFile(filepath.Join(root, logName), os.O_WRONLY|os.O_CREATE|os.O_APPEND, 0o600) //nolint:gosec // install-owned
	if err != nil {
		return err
	}
	_, err = file.Write(line)
	if closeErr := file.Close(); err == nil {
		err = closeErr
	}
	return err
}

// errCode names an I/O error the way Node's error.code does, for the log; "" when unknown.
func errCode(err error) any {
	var e *Error
	switch {
	case errors.As(err, &e):
		return string(e.Code)
	case errors.Is(err, fs.ErrPermission):
		return "EACCES"
	case errors.Is(err, fs.ErrNotExist):
		return "ENOENT"
	case errors.Is(err, fs.ErrExist):
		return "EEXIST"
	case errors.Is(err, syscall.ENOSPC):
		return "ENOSPC"
	}
	return nil
}

func sortedKeys(m map[string]string) []string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	return keys
}
