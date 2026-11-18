package desktopupdate

// Synthetic fixtures shared by the tests: packages, releases, state folders and a fake verifier.
// Every key, package, release and state folder is generated in a t.TempDir().

import (
	"bufio"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"testing"
	"time"
)

func put(t *testing.T, path, content string, mode os.FileMode) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if mode == 0 {
		mode = 0o644
	}
	if err := os.WriteFile(path, []byte(content), mode); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(path, mode); err != nil {
		t.Fatal(err)
	}
}

// makePackage writes a synthetic package shaped like the builder output, with one internal
// directory link.
func makePackage(t *testing.T, dir, version string) {
	t.Helper()
	metadata := fmt.Sprintf("{\n  \"version\": %q,\n  \"platform\": %q,\n  \"arch\": %q,\n  \"node\": \">=24\",\n  \"entry\": \"start.mjs\"\n}\n",
		version, nodePlatform(), nodeArch())
	put(t, filepath.Join(dir, "metadata.json"), metadata, 0)
	put(t, filepath.Join(dir, ".sipges-desktop-package"), "Generated package; failed builds are retained.\n", 0)
	put(t, filepath.Join(dir, "start.mjs"), "// synthetic entry "+version+"\n", 0)
	put(t, filepath.Join(dir, "api/src/main.js"), "export const version = '"+version+"';\n", 0)
	put(t, filepath.Join(dir, "web/index.html"), "<!doctype html><title>SIPGES "+version+"</title>\n", 0)
	put(t, filepath.Join(dir, "api/node_modules/.pnpm/dep@1.0.0/node_modules/dep/index.js"), "export {};\n", 0)
	if err := os.MkdirAll(filepath.Join(dir, "references"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(".pnpm/dep@1.0.0/node_modules/dep", filepath.Join(dir, "api/node_modules/dep")); err != nil {
		t.Fatal(err)
	}
}

func nodePlatform() string {
	if runtime.GOOS == "windows" {
		return "win32"
	}
	return runtime.GOOS
}

func nodeArch() string {
	if runtime.GOARCH == "amd64" {
		return "x64"
	}
	return runtime.GOARCH
}

// makeState writes a synthetic state folder with the four entries a real one holds.
func makeState(t *testing.T, dir string) {
	t.Helper()
	page := make([]byte, 8192)
	for i := range page {
		page[i] = byte((i * 31) % 251)
	}
	put(t, filepath.Join(dir, "pglite/PG_VERSION"), "17\n", 0)
	put(t, filepath.Join(dir, "pglite/base/1/16384"), string(page), 0)
	put(t, filepath.Join(dir, "uploads/synthetic-project/evidence.pdf"), "%PDF-synthetic\n", 0)
	put(t, filepath.Join(dir, "data-key"), "c3ludGhldGljLWtleS1mb3ItdGVzdHMtb25seS0wMDA=\n", 0o600)
	put(t, filepath.Join(dir, "admin-password"), "synthetic-admin-password\n", 0o600)
}

// snapshot maps every path of a tree to its type, mode and content hash (or link target),
// without following links.
func snapshot(t *testing.T, root string) map[string]string {
	t.Helper()
	out := map[string]string{}
	var walk func(dir, prefix string)
	walk = func(dir, prefix string) {
		entries, err := os.ReadDir(dir)
		if err != nil {
			t.Fatal(err)
		}
		for _, entry := range entries {
			path := filepath.Join(dir, entry.Name())
			rel := entry.Name()
			if prefix != "" {
				rel = prefix + "/" + entry.Name()
			}
			info, err := os.Lstat(path)
			if err != nil {
				t.Fatal(err)
			}
			mode := strconv.FormatUint(uint64(info.Mode().Perm()), 8)
			switch {
			case info.Mode()&os.ModeSymlink != 0:
				target, _ := os.Readlink(path)
				out[rel] = "link " + target
			case info.IsDir():
				out[rel] = "dir " + mode
				walk(path, rel)
			case !info.Mode().IsRegular():
				out[rel] = "other " + info.Mode().String()
			default:
				data, err := os.ReadFile(path)
				if err != nil {
					t.Fatal(err)
				}
				sum := sha256.Sum256(data)
				out[rel] = "file " + mode + " " + hex.EncodeToString(sum[:])
			}
		}
	}
	walk(root, "")
	return out
}

func sameMap(a, b map[string]string) bool {
	if len(a) != len(b) {
		return false
	}
	for k, v := range a {
		if b[k] != v {
			return false
		}
	}
	return true
}

func assertSnapshot(t *testing.T, got, want map[string]string, label string) {
	t.Helper()
	if !sameMap(got, want) {
		t.Fatalf("%s: tree differs\n got: %v\nwant: %v", label, got, want)
	}
}

// siblings lists the names beside a state folder that start with its name and a dot.
func siblings(t *testing.T, state string) []string {
	t.Helper()
	entries, err := os.ReadDir(filepath.Dir(state))
	if err != nil {
		t.Fatal(err)
	}
	out := []string{}
	for _, entry := range entries {
		if strings.HasPrefix(entry.Name(), filepath.Base(state)+".") {
			out = append(out, entry.Name())
		}
	}
	sort.Strings(out)
	return out
}

func names(t *testing.T, dir string) []string {
	t.Helper()
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	out := []string{}
	for _, entry := range entries {
		out = append(out, entry.Name())
	}
	sort.Strings(out)
	return out
}

func logLines(t *testing.T, root string) []map[string]any {
	t.Helper()
	data, err := os.ReadFile(filepath.Join(root, "update.log"))
	if err != nil {
		t.Fatal(err)
	}
	var out []map[string]any
	scanner := bufio.NewScanner(bytes.NewReader(data))
	for scanner.Scan() {
		var line map[string]any
		if err := json.Unmarshal(scanner.Bytes(), &line); err != nil {
			t.Fatalf("log line %q: %v", scanner.Text(), err)
		}
		out = append(out, line)
	}
	return out
}

func lastLog(t *testing.T, root string) map[string]any {
	t.Helper()
	lines := logLines(t, root)
	if len(lines) == 0 {
		t.Fatal("empty update.log")
	}
	return lines[len(lines)-1]
}

const badSignature = "bad"

// writeRelease builds a release directory with a package and an unsigned manifest in the shape
// release.mjs writes. The fake verifier reads it without checking any signature.
func writeRelease(t *testing.T, release, version string) {
	t.Helper()
	pkg := filepath.Join(release, "package")
	makePackage(t, pkg, version)
	put(t, filepath.Join(pkg, "update-public-key.pem"), "-----BEGIN PUBLIC KEY-----\nsynthetic\n-----END PUBLIC KEY-----\n", 0)
	scan, err := scanTree(pkg)
	if err != nil {
		t.Fatal(err)
	}
	files := map[string]string{}
	for rel, path := range scan.files {
		hash, err := hashFile(path)
		if err != nil {
			t.Fatal(err)
		}
		files[rel] = hash
	}
	links := map[string]string{}
	for rel, path := range scan.links {
		target, err := os.Readlink(path)
		if err != nil {
			t.Fatal(err)
		}
		links[rel] = target
	}
	dirs := append([]string{}, scan.directories...)
	sort.Strings(dirs)
	manifest := map[string]any{
		"format": 1, "version": version, "minimumPrevious": nil, "platform": nodePlatform(),
		"arch": nodeArch(), "files": files, "links": links, "directories": dirs,
	}
	data, err := json.MarshalIndent(manifest, "", "  ")
	if err != nil {
		t.Fatal(err)
	}
	put(t, filepath.Join(release, "release.json"), string(data)+"\n", 0)
	put(t, filepath.Join(release, "release.sig"), base64.StdEncoding.EncodeToString(make([]byte, 64))+"\n", 0)
}

// fakeVerifier reads release.json without a signature check. It refuses a release whose
// release.sig says "bad", and one that is not newer than the installed version.
type fakeVerifier struct{ calls []VerifyRequest }

func (f *fakeVerifier) Verify(_ context.Context, req VerifyRequest) (Release, error) {
	f.calls = append(f.calls, req)
	data, err := os.ReadFile(filepath.Join(req.ReleaseDir, "release.json"))
	if err != nil {
		return Release{}, fmt.Errorf("%w: No release.json in the release directory", ErrRefused)
	}
	sig, err := os.ReadFile(filepath.Join(req.ReleaseDir, "release.sig"))
	if err != nil {
		return Release{}, fmt.Errorf("%w: No release.sig in the release directory", ErrRefused)
	}
	text := strings.TrimSpace(string(sig))
	if text == badSignature {
		return Release{}, refusedError{"The release signature does not match the trusted update key"}
	}
	var manifest struct {
		Version     string            `json:"version"`
		Files       map[string]string `json:"files"`
		Links       map[string]string `json:"links"`
		Directories []string          `json:"directories"`
	}
	if err := json.Unmarshal(data, &manifest); err != nil {
		return Release{}, err
	}
	if req.Installed != nil && !newer(manifest.Version, req.Installed.Version) {
		return Release{}, refusedError{fmt.Sprintf("Version %s is not newer than the installed %s", manifest.Version, req.Installed.Version)}
	}
	return Release{
		Version: manifest.Version, PackageDir: filepath.Join(req.ReleaseDir, "package"),
		Files: manifest.Files, Links: manifest.Links, Directories: manifest.Directories,
		Manifest: data, Signature: []byte(text + "\n"),
	}, nil
}

// refusedError is how a real verifier adapter reports a refusal: its message, matching ErrRefused.
type refusedError struct{ msg string }

func (e refusedError) Error() string        { return e.msg }
func (e refusedError) Is(target error) bool { return target == ErrRefused }

// newer compares plain x.y.z versions, enough for the synthetic releases of these tests.
func newer(a, b string) bool {
	pa, pb := strings.Split(a, "."), strings.Split(b, ".")
	for i := 0; i < 3; i++ {
		x, _ := strconv.Atoi(pa[i])
		y, _ := strconv.Atoi(pb[i])
		if x != y {
			return x > y
		}
	}
	return false
}

type fixtureT struct {
	t        *testing.T
	dir      string
	root     string
	state    string
	verifier *fakeVerifier
	serial   int
}

func (f *fixtureT) release(version string) string {
	f.serial++
	release := filepath.Join(f.dir, fmt.Sprintf("release-%d", f.serial))
	writeRelease(f.t, release, version)
	return release
}

// newFixture installs 1.0.0 over a synthetic state folder at <dir>/state.
func newFixture(t *testing.T, dir string) *fixtureT {
	t.Helper()
	return newFixtureAt(t, dir, filepath.Join(dir, "state"), true)
}

func newFixtureAt(t *testing.T, dir, state string, withState bool) *fixtureT {
	t.Helper()
	f := &fixtureT{t: t, dir: dir, root: filepath.Join(dir, "install"), state: state, verifier: &fakeVerifier{}}
	if withState {
		makeState(t, state)
	}
	_, err := Install(context.Background(), InstallOptions{
		Root: f.root, Release: f.release("1.0.0"), StateDir: state,
		TrustKey: []byte("synthetic trust key"), Verifier: f.verifier,
	})
	if err != nil {
		t.Fatal(err)
	}
	return f
}

func (f *fixtureT) update(release string, migrate, ready Hook) (UpdateResult, error) {
	return Update(context.Background(), UpdateOptions{
		Root: f.root, Release: release, Verifier: f.verifier, Migrate: migrate, Ready: ready,
	})
}

func noop(context.Context, Target) error { return nil }

func codeOf(err error) Code {
	var e *Error
	if errors.As(err, &e) {
		return e.Code
	}
	return ""
}

func wantCode(t *testing.T, err error, code Code, label string) *Error {
	t.Helper()
	var e *Error
	if !errors.As(err, &e) || e.Code != code {
		t.Fatalf("%s: want %s, got %v (%T)", label, code, err, err)
	}
	return e
}

func exists(t *testing.T, path string) bool {
	t.Helper()
	_, err := os.Lstat(path)
	return err == nil
}

func readText(t *testing.T, path string) string {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return string(data)
}

func isoAgo(d time.Duration) string {
	return time.Now().Add(-d).UTC().Format("2006-01-02T15:04:05.000Z")
}
