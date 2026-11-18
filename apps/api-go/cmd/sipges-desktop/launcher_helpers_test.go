package main

import (
	"bufio"
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/Dreamcoder08/sipges/apps/api-go/internal/platform/desktoprelease"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/platform/desktopupdate"
)

// fixture is a managed install made by the real updater from a signed synthetic release, as
// deploy/desktop/updater/launcher.test.mjs fixture() makes it. The key is a throwaway one.
type fixture struct {
	t      *testing.T
	dir    string
	root   string
	state  string
	source string
	key    ed25519.PrivateKey
	serial int
	// extra adds files to every package (the integration test puts the Go binaries there).
	extra func(pkg, version string)
}

type releaseOptions struct {
	parent string
	name   string
	notes  *string
	key    ed25519.PrivateKey
}

func newFixture(t *testing.T) *fixture {
	return newFixtureWith(t, nil)
}

func newFixtureWith(t *testing.T, extra func(pkg, version string)) *fixture {
	t.Helper()
	_, key, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	dir := t.TempDir()
	f := &fixture{
		t: t, dir: dir, root: filepath.Join(dir, "install"), state: filepath.Join(dir, "state"),
		source: filepath.Join(dir, "releases"), key: key, extra: extra,
	}
	mkdir(t, f.source)
	first := f.release("1.0.0", releaseOptions{parent: dir})
	if _, err := desktopupdate.Install(context.Background(), desktopupdate.InstallOptions{
		Root: f.root, Release: first, StateDir: f.state,
		TrustKey: []byte(publicKeyPEM(t, key.Public().(ed25519.PublicKey))), Verifier: releaseVerifier{},
	}); err != nil {
		t.Fatalf("install 1.0.0: %v", err)
	}
	return f
}

// release writes a signed release of a synthetic package: the Go port of release.mjs
// createRelease (manifest as JSON.stringify(manifest, null, 2) + "\n", then signed).
func (f *fixture) release(version string, o releaseOptions) string {
	t := f.t
	t.Helper()
	f.serial++
	parent := o.parent
	if parent == "" {
		parent = f.source
	}
	name := o.name
	if name == "" {
		name = fmt.Sprintf("sipges-%s-%d", version, f.serial)
	}
	key := o.key
	if key == nil {
		key = f.key
	}
	dir := filepath.Join(parent, name)
	pkg := filepath.Join(dir, "package")
	host := desktoprelease.HostPlatform()
	meta, _ := json.MarshalIndent(map[string]string{
		"version": version, "platform": host.OS, "arch": host.Arch, "entry": "start.mjs",
	}, "", "  ")
	put(t, filepath.Join(pkg, "metadata.json"), string(meta)+"\n")
	put(t, filepath.Join(pkg, "start.mjs"), "// synthetic entry "+version+"\n")
	put(t, filepath.Join(pkg, "web", "index.html"), "<!doctype html><title>SIPGES "+version+"</title>\n")
	put(t, filepath.Join(pkg, desktoprelease.PublicKeyName), publicKeyPEM(t, key.Public().(ed25519.PublicKey)))
	if f.extra != nil {
		f.extra(pkg, version)
	}
	files := map[string]string{}
	directories := []string{}
	err := filepath.WalkDir(pkg, func(path string, d fs.DirEntry, err error) error {
		if err != nil || path == pkg {
			return err
		}
		rel, _ := filepath.Rel(pkg, path)
		rel = filepath.ToSlash(rel)
		if d.IsDir() {
			directories = append(directories, rel)
			return nil
		}
		data, err := os.ReadFile(path)
		sum := sha256.Sum256(data)
		files[rel] = hex.EncodeToString(sum[:])
		return err
	})
	if err != nil {
		t.Fatal(err)
	}
	sort.Strings(directories)
	fields := []string{
		jsonField("format", 1), jsonField("version", version), jsonField("minimumPrevious", nil),
		jsonField("platform", host.OS), jsonField("arch", host.Arch),
	}
	if o.notes != nil {
		fields = append(fields, jsonField("notes", *o.notes))
	}
	fields = append(fields, jsonField("files", files), jsonField("links", map[string]string{}), jsonField("directories", directories))
	var manifest bytes.Buffer
	if err := json.Indent(&manifest, []byte("{"+strings.Join(fields, ",")+"}"), "", "  "); err != nil {
		t.Fatal(err)
	}
	manifest.WriteString("\n")
	put(t, filepath.Join(dir, desktoprelease.ManifestName), manifest.String())
	put(t, filepath.Join(dir, desktoprelease.SignatureName),
		base64.StdEncoding.EncodeToString(ed25519.Sign(key, manifest.Bytes()))+"\n")
	return dir
}

func jsonField(name string, value any) string {
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	_ = enc.Encode(value)
	return `"` + name + `":` + strings.TrimSpace(buf.String())
}

func publicKeyPEM(t *testing.T, pub ed25519.PublicKey) string {
	t.Helper()
	der, err := x509.MarshalPKIXPublicKey(pub)
	if err != nil {
		t.Fatal(err)
	}
	return string(pem.EncodeToMemory(&pem.Block{Type: "PUBLIC KEY", Bytes: der}))
}

func mkdir(t *testing.T, dir string) {
	t.Helper()
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatal(err)
	}
}

func (f *fixture) current() string {
	f.t.Helper()
	c, err := desktopupdate.ReadCurrent(f.root)
	if err != nil || c == nil {
		f.t.Fatalf("current: %v %v", c, err)
	}
	return c.Version
}

func (f *fixture) request(version string) {
	f.t.Helper()
	put(f.t, filepath.Join(f.root, "update-channel", "request.json"), `{"format":1,"version":"`+version+`"}`)
}

// statusJSON is update-channel/status.json, decoded.
func (f *fixture) statusJSON() map[string]any {
	f.t.Helper()
	data, err := os.ReadFile(filepath.Join(f.root, "update-channel", "status.json"))
	if err != nil {
		f.t.Fatal(err)
	}
	var m map[string]any
	if err := json.Unmarshal(data, &m); err != nil {
		f.t.Fatalf("status.json: %v\n%s", err, data)
	}
	return m
}

// fakeServe stands in for PostgreSQL and the API: it reads the data key as the real start does
// (an empty one fails it) and records every version it started.
type fakeServe struct {
	mu      sync.Mutex
	started []serverSpec
	running *fakeServer
}

type fakeServer struct {
	exited chan struct{}
	once   sync.Once
	code   int
}

func (s *fakeServer) Exited() <-chan struct{} { return s.exited }
func (s *fakeServer) Code() int               { return s.code }
func (s *fakeServer) end(code int) {
	s.once.Do(func() { s.code = code; close(s.exited) })
}
func (s *fakeServer) Stop(context.Context) error { s.end(0); return nil }
func (s *fakeServer) Kill()                      { s.end(137) }

func (fs *fakeServe) serve(_ context.Context, spec serverSpec) (server, error) {
	key, err := os.ReadFile(filepath.Join(spec.StateDir, "data-key"))
	if err != nil {
		return nil, err
	}
	if strings.TrimSpace(string(key)) == "" {
		return nil, errors.New("data-key is empty in the state folder")
	}
	srv := &fakeServer{exited: make(chan struct{})}
	fs.mu.Lock()
	defer fs.mu.Unlock()
	fs.started = append(fs.started, spec)
	fs.running = srv
	return srv, nil
}

func (fs *fakeServe) versions() []string {
	fs.mu.Lock()
	defer fs.mu.Unlock()
	var out []string
	for _, s := range fs.started {
		out = append(out, s.Current.Version)
	}
	return out
}

// lockedBuffer collects the launcher's JSON lines from several goroutines.
type lockedBuffer struct {
	mu  sync.Mutex
	buf bytes.Buffer
}

func (b *lockedBuffer) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.Write(p)
}

func (b *lockedBuffer) String() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.String()
}

func parseEvents(t *testing.T, text string) []map[string]any {
	t.Helper()
	var out []map[string]any
	sc := bufio.NewScanner(strings.NewReader(text))
	for sc.Scan() {
		var m map[string]any
		if err := json.Unmarshal(sc.Bytes(), &m); err != nil {
			t.Fatalf("not a JSON line: %q", sc.Text())
		}
		out = append(out, m)
	}
	return out
}

// running is a launcher started in the background with test defaults, like started() in
// launcher.test.mjs: migration and readiness do nothing unless the test sets them.
type running struct {
	t      *testing.T
	l      *launcher
	out    *lockedBuffer
	serve  *fakeServe
	cancel context.CancelFunc
	done   chan runResult
}

type runResult struct {
	code int
	err  error
}

func startLauncher(t *testing.T, f *fixture, edit func(*launchConfig)) *running {
	t.Helper()
	out := &lockedBuffer{}
	fs := &fakeServe{}
	cfg := launchConfig{
		Root: f.root, Source: f.source, Port: 18000, Log: newEventLog(out),
		CheckTimeout: 10 * time.Second, Poll: 20 * time.Millisecond,
		Find:     findUpdate,
		Migrate:  func(context.Context, desktopupdate.Target) error { return nil },
		Ready:    func(context.Context, desktopupdate.Target) error { return nil },
		Verifier: releaseVerifier{},
		Serve:    fs.serve,
	}
	if edit != nil {
		edit(&cfg)
	}
	ctx, cancel := context.WithCancel(context.Background())
	r := &running{t: t, l: newLauncher(cfg), out: out, serve: fs, cancel: cancel, done: make(chan runResult, 1)}
	go func() {
		code, err := r.l.run(ctx)
		r.done <- runResult{code, err}
	}()
	t.Cleanup(func() {
		cancel()
		select {
		case <-r.done:
		case <-time.After(10 * time.Second):
		}
	})
	return r
}

func (r *running) events() []map[string]any { return parseEvents(r.t, r.out.String()) }

func (r *running) names() []string {
	var out []string
	for _, e := range r.events() {
		out = append(out, e["event"].(string))
	}
	return out
}

// waitEvent waits for the n-th (1-based) line of this event.
func (r *running) waitEvent(name string, n int) map[string]any {
	r.t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		seen := 0
		for _, e := range r.events() {
			if e["event"] == name {
				seen++
				if seen == n {
					return e
				}
			}
		}
		time.Sleep(10 * time.Millisecond)
	}
	r.t.Fatalf("no %d× %s; events %v", n, name, r.names())
	return nil
}

// result waits for the launcher to end.
func (r *running) result(within time.Duration) (runResult, bool) {
	select {
	case res := <-r.done:
		r.done <- res
		return res, true
	case <-time.After(within):
		return runResult{}, false
	}
}

func (r *running) stop() runResult {
	r.t.Helper()
	r.cancel()
	res, ok := r.result(10 * time.Second)
	if !ok {
		r.t.Fatalf("the launcher did not stop; events %v", r.names())
	}
	return res
}

var _ io.Writer = (*lockedBuffer)(nil)

// put writes a file, creating its folders.
func put(t *testing.T, path, body string) {
	t.Helper()
	mkdir(t, filepath.Dir(path))
	writeFile(t, path, body)
}
