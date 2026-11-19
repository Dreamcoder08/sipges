package pglitemove

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"net"
	"net/url"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"time"
)

// Refusal is a refusal or an error whose message is ours: safe to print.
type Refusal struct{ msg string }

func (r *Refusal) Error() string { return r.msg }

func refusef(format string, args ...any) error { return &Refusal{msg: fmt.Sprintf(format, args...)} }

// freshFor is how recently a lock must have been touched to be in use (tables.mjs FRESH_MS).
const freshFor = 120 * time.Second

// OriginalState is the original state folder of the desktop install, which the move never reads:
// the Windows installer's %LOCALAPPDATA%\SIPGES, Linux's ~/.local/share/sipges-local (install.sh).
func OriginalState(lookup func(string) (string, bool), goos, home string) string {
	if goos == "windows" {
		dir, _ := lookup("LOCALAPPDATA")
		if dir == "" {
			dir = home + `\AppData\Local`
		}
		return strings.TrimRight(dir, `\/`) + `\SIPGES`
	}
	if h, _ := lookup("HOME"); h != "" {
		home = h
	}
	return filepath.Join(home, ".local", "share", "sipges-local")
}

func fold(p string) string {
	if runtime.GOOS == "windows" {
		return strings.ToLower(p)
	}
	return p
}

// within reports whether child is parent or inside it.
func within(parent, child string) bool {
	r, err := filepath.Rel(fold(parent), fold(child))
	if err != nil {
		return false
	}
	return r == "." || (r != ".." && !strings.HasPrefix(r, ".."+string(filepath.Separator)) && !filepath.IsAbs(r))
}

// realOr is the real path of p, else its absolute form (a missing original folder).
func realOr(p string) string {
	if real, err := filepath.EvalSymlinks(p); err == nil {
		return real
	}
	abs, _ := filepath.Abs(p)
	return abs
}

// isLink reports a symbolic link, or a junction (Go reports Windows mount points as irregular).
func isLink(info fs.FileInfo) bool { return info.Mode()&(fs.ModeSymlink|fs.ModeIrregular) != 0 }

// insideAny reports the first original folder real lies in.
func insideAny(originals []string, real string) (string, bool) {
	for _, o := range originals {
		if o != "" && within(realOr(o), real) {
			return o, true
		}
	}
	return "", false
}

// checkCopy is the rule of install.sh and install.ps1 for the copy given to the move: the path
// itself must not be a link or junction, its real folder must not be an original or inside one,
// and its pglite folder must be a plain folder holding PG_VERSION. Returns the pglite folder.
func checkCopy(given string, originals []string) (string, error) {
	resolved, err := filepath.Abs(given)
	if err != nil {
		return "", refusef("--state %s does not exist", given)
	}
	info, err := os.Lstat(resolved)
	if err != nil {
		return "", refusef("--state %s does not exist", given)
	}
	if isLink(info) {
		return "", refusef("--state %s is a link or junction: pass the real folder of the copy, never a link to it", given)
	}
	if !info.IsDir() {
		return "", refusef("--state %s is not a folder", given)
	}
	real, err := filepath.EvalSymlinks(resolved)
	if err != nil {
		return "", refusef("--state %s does not exist", given)
	}
	if o, in := insideAny(originals, real); in {
		return "", refusef("--state %s is the original state folder %s or inside it: copy it first and pass the copy", given, o)
	}
	db := filepath.Join(real, "pglite")
	dbInfo, err := os.Lstat(db)
	if err == nil && isLink(dbInfo) {
		return "", refusef("--state %s holds pglite as a link or junction: pass a plain copy", given)
	}
	if err != nil || !dbInfo.IsDir() {
		return "", refusef("--state %s is not a SIPGES state folder (no pglite database)", given)
	}
	if _, err := os.Lstat(filepath.Join(db, "PG_VERSION")); err != nil {
		return "", refusef("--state %s is not a SIPGES state folder (no pglite database)", given)
	}
	if o, in := insideAny(originals, realOr(db)); in {
		return "", refusef("--state %s leads to the original state folder %s: pass a plain copy", given, o)
	}
	return db, nil
}

// checkScratch refuses a scratch folder inside an original state folder or inside the copy,
// before anything is created. Returns its real path.
func checkScratch(given, copyDir string, originals []string) (string, error) {
	abs, err := filepath.Abs(given)
	if err != nil {
		return "", refusef("--scratch %s does not exist", given)
	}
	real, err := filepath.EvalSymlinks(abs)
	if err != nil {
		return "", refusef("--scratch %s does not exist", given)
	}
	if info, err := os.Stat(real); err != nil || !info.IsDir() {
		return "", refusef("--scratch %s is not a folder", given)
	}
	if o, in := insideAny(originals, real); in {
		return "", refusef("--scratch %s is inside the original state folder %s: pick a folder outside it", given, o)
	}
	if within(realOr(copyDir), real) {
		return "", refusef("--scratch %s is inside the copy given with --state: pick a folder outside it", given)
	}
	return real, nil
}

// PortAnswers reports whether something accepts a TCP connection on 127.0.0.1:port within 2 s
// (visit-kit.mjs portAnswers).
func PortAnswers(port int) bool {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	c, err := (&net.Dialer{}).DialContext(ctx, "tcp", net.JoinHostPort("127.0.0.1", strconv.Itoa(port)))
	if err != nil {
		return false
	}
	_ = c.Close()
	return true
}

// freshLock reports a lock file touched in the last freshFor: its JSON heartbeat, else its file time.
func freshLock(path string) bool {
	info, err := os.Stat(path)
	if err != nil {
		return false
	}
	when := info.ModTime()
	if data, err := os.ReadFile(path); err == nil { //nolint:gosec // a lock file inside the copy
		var lock struct {
			Heartbeat string `json:"heartbeat"`
		}
		if json.Unmarshal(data, &lock) == nil {
			if t, err := time.Parse(time.RFC3339Nano, lock.Heartbeat); err == nil {
				when = t
			}
		}
	}
	return time.Since(when) < freshFor
}

// checkStopped refuses while SIPGES answers on port, or when the copy's PGlite holds a
// postmaster.pid touched in the last two minutes (the copy was taken with the database open).
func checkStopped(db string, port int, answers func(int) bool) error {
	if answers(port) {
		return refusef("SIPGES responde en el puerto %d: cierre SIPGES por completo, copie la carpeta otra vez y vuelva a ejecutar", port)
	}
	if freshLock(filepath.Join(db, "postmaster.pid")) {
		return refusef("la copia se tomó con SIPGES abierto (pglite/postmaster.pid de hace menos de %d minutos): cierre SIPGES y copie la carpeta otra vez", int(freshFor/time.Minute))
	}
	return nil
}

// checkTarget accepts a postgres:// URL to a database on 127.0.0.1 only; it is never printed.
func checkTarget(raw string) (*url.URL, error) {
	u, err := url.Parse(raw)
	if err != nil || raw == "" {
		return nil, refusef("the target must be a postgres:// URL to 127.0.0.1 (--to or SIPGES_MOVE_DATABASE_URL)")
	}
	q := u.Query()
	local := (u.Scheme == "postgres" || u.Scheme == "postgresql") && u.Hostname() == "127.0.0.1" &&
		!q.Has("host") && !q.Has("hostaddr") && len(u.Path) > 1
	if !local {
		return nil, refusef("the target must be a postgres:// URL to a database on 127.0.0.1, with no host override")
	}
	return u, nil
}

// checkPrepared returns the pending-move mark of the prepared (real) state folder, a plain file.
func checkPrepared(folder string) (string, error) {
	abs, err := filepath.Abs(folder)
	mark := filepath.Join(abs, PendingMoveName)
	info, lerr := os.Lstat(mark)
	if err != nil || lerr != nil || !info.Mode().IsRegular() {
		return "", refusef("--prepared names no folder that sipges-desktop --prepare-only prepared (no %s)", PendingMoveName)
	}
	return mark, nil
}

type entry struct {
	rel  string
	path string
	dir  bool
	size int64
}

// entries lists a folder in name order; it refuses links, junctions and special files.
func entries(root string) ([]entry, error) {
	var out []entry
	var walk func(dir string) error
	walk = func(dir string) error {
		list, err := os.ReadDir(dir)
		if err != nil {
			return err
		}
		sort.Slice(list, func(i, j int) bool { return list[i].Name() < list[j].Name() })
		for _, e := range list {
			p := filepath.Join(dir, e.Name())
			rel, _ := filepath.Rel(root, p)
			rel = filepath.ToSlash(rel)
			info, err := os.Lstat(p)
			if err != nil {
				return err
			}
			switch {
			case isLink(info):
				return refusef("%s holds a link, junction or special file (%s); pass a plain copy", root, rel)
			case info.IsDir():
				out = append(out, entry{rel: rel, dir: true})
				if err := walk(p); err != nil {
					return err
				}
			case info.Mode().IsRegular():
				out = append(out, entry{rel: rel, path: p, size: info.Size()})
			default:
				return refusef("%s holds a link, junction or special file (%s); pass a plain copy", root, rel)
			}
		}
		return nil
	}
	return out, walk(root)
}

// treeDigest is tables.mjs treeDigest: names, sizes and bytes of a folder as one digest.
func treeDigest(root string) (string, error) {
	list, err := entries(root)
	if err != nil {
		return "", err
	}
	h := sha256.New()
	for _, e := range list {
		if e.dir {
			_, _ = fmt.Fprintf(h, "d %s\n", e.rel)
			continue
		}
		sum, err := hashFile(e.path)
		if err != nil {
			return "", err
		}
		_, _ = fmt.Fprintf(h, "f %s %d %s\n", e.rel, e.size, sum)
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}

func hashFile(path string) (string, error) {
	f, err := os.Open(path) //nolint:gosec // a file of the copy being hashed
	if err != nil {
		return "", err
	}
	defer func() { _ = f.Close() }()
	h := sha256.New()
	if _, err := io.Copy(h, f); err != nil {
		return "", err
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}

// copyTree copies a plain folder (no links: entries refused them) into a new target.
func copyTree(source, target string) error {
	list, err := entries(source)
	if err != nil {
		return err
	}
	if err := os.Mkdir(target, 0o700); err != nil {
		return err
	}
	for _, e := range list {
		dst := filepath.Join(target, filepath.FromSlash(e.rel))
		if e.dir {
			if err := os.Mkdir(dst, 0o700); err != nil {
				return err
			}
			continue
		}
		if err := copyFile(e.path, dst); err != nil {
			return err
		}
	}
	return nil
}

func copyFile(src, dst string) (err error) {
	in, err := os.Open(src) //nolint:gosec // a file of the copy
	if err != nil {
		return err
	}
	defer func() { _ = in.Close() }()
	out, err := os.OpenFile(dst, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600) //nolint:gosec // inside the run's own scratch folder
	if err != nil {
		return err
	}
	defer func() {
		if cerr := out.Close(); err == nil {
			err = cerr
		}
	}()
	_, err = io.Copy(out, in)
	return err
}

// removeAll removes the scratch folder, retrying as fs.rm's maxRetries does (Windows may hold a
// file a moment after it was closed), and reports whether it is gone.
func removeAll(dir string) bool {
	for range 6 {
		_ = os.RemoveAll(dir)
		if _, err := os.Lstat(dir); errors.Is(err, fs.ErrNotExist) {
			return true
		}
		time.Sleep(100 * time.Millisecond)
	}
	return false
}
