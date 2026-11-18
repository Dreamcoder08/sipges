package main

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/Dreamcoder08/sipges/apps/api-go/internal/platform/desktoprelease"
)

// installCLI runs the install form of the command line (update.mjs --install … --release …).
func installCLI(t *testing.T, args ...string) (code int, stdout, stderr string) {
	t.Helper()
	var out, errOut bytes.Buffer
	code = runLauncherCLI(context.Background(), args, os.Environ(), &out, &errOut, nil)
	return code, out.String(), errOut.String()
}

func readJSONFile(t *testing.T, path string) map[string]any {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var v map[string]any
	if err := json.Unmarshal(data, &v); err != nil {
		t.Fatal(err)
	}
	return v
}

// A fresh signed release and empty install root and state folder, outside the fixture's install.
func freshInstall(t *testing.T) (f *fixture, release, root, state string) {
	t.Helper()
	f = newFixture(t)
	release = f.release("2.0.0", releaseOptions{})
	return f, release, filepath.Join(f.dir, "new-install"), filepath.Join(f.dir, "new-state")
}

func TestInstallTrustsTheReleaseKeyAndRecordsTheStateFolder(t *testing.T) {
	f, release, root, state := freshInstall(t)
	mkdir(t, state)
	code, stdout, stderr := installCLI(t, "--install", root, "--release", release, "--state", state, "--trust-release-key")
	if code != 0 {
		t.Fatalf("exit %d, stderr %q", code, stderr)
	}
	fp := desktoprelease.KeyFingerprint(f.key.Public().(ed25519.PublicKey))
	want := "Trusting the update key that signed this release (SHA-256 " + fp + ").\nInstalled 2.0.0\n"
	if stdout != want {
		t.Fatalf("stdout %q, want %q", stdout, want)
	}
	if v := readJSONFile(t, filepath.Join(root, "current.json"))["version"]; v != "2.0.0" {
		t.Fatalf("current.json version %v", v)
	}
	real, err := filepath.EvalSymlinks(state)
	if err != nil {
		t.Fatal(err)
	}
	if got := readJSONFile(t, filepath.Join(root, "install.json"))["stateDir"]; got != real {
		t.Fatalf("install.json stateDir %v, want %s", got, real)
	}
}

func TestInstallRecordsTheRealPathOfALinkedParent(t *testing.T) {
	_, release, root, _ := freshInstall(t)
	realParent := filepath.Join(t.TempDir(), "real")
	mkdir(t, realParent)
	link := filepath.Join(t.TempDir(), "link")
	if err := os.Symlink(realParent, link); err != nil {
		t.Skip("symlinks unavailable:", err)
	}
	code, _, stderr := installCLI(t, "--install", root, "--release", release, "--state", filepath.Join(link, "state"), "--trust-release-key")
	if code != 0 {
		t.Fatalf("exit %d, stderr %q", code, stderr)
	}
	resolved, _ := filepath.EvalSymlinks(realParent)
	if got := readJSONFile(t, filepath.Join(root, "install.json"))["stateDir"]; got != filepath.Join(resolved, "state") {
		t.Fatalf("install.json stateDir %v", got)
	}
}

func TestInstallTrustsAnOperatorKeyFile(t *testing.T) {
	f, release, root, state := freshInstall(t)
	keyFile := filepath.Join(f.dir, "public.pem")
	put(t, keyFile, publicKeyPEM(t, f.key.Public().(ed25519.PublicKey)))
	code, stdout, stderr := installCLI(t, "--install", root, "--release", release, "--state", state, "--trust-key", keyFile)
	if code != 0 || stdout != "Installed 2.0.0\n" {
		t.Fatalf("exit %d, stdout %q, stderr %q", code, stdout, stderr)
	}
}

func TestInstallRefusesAReleaseSignedByAnotherKey(t *testing.T) {
	f, _, root, state := freshInstall(t)
	_, other, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	release := f.release("2.0.0", releaseOptions{key: other})
	keyFile := filepath.Join(f.dir, "public.pem")
	put(t, keyFile, publicKeyPEM(t, f.key.Public().(ed25519.PublicKey)))
	code, _, stderr := installCLI(t, "--install", root, "--release", release, "--state", state, "--trust-key", keyFile)
	if code != 1 || !strings.HasPrefix(stderr, "Error: ") {
		t.Fatalf("exit %d, stderr %q", code, stderr)
	}
	if _, err := os.Stat(filepath.Join(root, "current.json")); !os.IsNotExist(err) {
		t.Fatalf("current.json was written: %v", err)
	}
}

func TestInstallRefusesAnInstalledRoot(t *testing.T) {
	f, release, _, state := freshInstall(t)
	before := f.current()
	code, _, stderr := installCLI(t, "--install", f.root, "--release", release, "--state", state, "--trust-release-key")
	if code != 1 || stderr != "Error: --trust-release-key is only for a first install\n" {
		t.Fatalf("exit %d, stderr %q", code, stderr)
	}
	if f.current() != before {
		t.Fatal("the installed version changed")
	}
}

func TestInstallOptionErrors(t *testing.T) {
	_, release, root, state := freshInstall(t)
	cases := []struct {
		args []string
		want string
	}{
		{[]string{"--install", root, "--release", release, "--trust-release-key"}, "Error: Missing --state for the first install\n"},
		{[]string{"--install", root, "--release", release, "--state", state}, "Error: The first install needs --trust-key\n"},
		{[]string{"--install", root, "--release", release, "--state", state, "--trust-release-key", "--trust-key", "k"}, "Error: Use either --trust-key or --trust-release-key\n"},
		{[]string{"--install", root, "--state", state}, "Error: Missing --release\n"},
		{[]string{"--install", root, "--trust-release-key"}, "Error: Missing --release\n"},
		{[]string{"--install", root, "--release", release, "--state", state, "--trust-release-key", "--releases", release}, "Error: Invalid options; use --help\n"},
		{[]string{"--install", root, "--release", release, "--state", state, "--trust-release-key", "--prepare-only"}, "Error: Invalid options; use --help\n"},
		{[]string{"--install", root, "--release", release, "--state", state, "--trust-release-key", "--trust-release-key"}, "Error: Invalid options; use --help\n"},
	}
	for _, c := range cases {
		code, stdout, stderr := installCLI(t, c.args...)
		if code != 1 || stdout != "" || stderr != c.want {
			t.Errorf("%v: exit %d, stdout %q, stderr %q, want %q", c.args, code, stdout, stderr, c.want)
		}
	}
	if _, err := os.Stat(root); !os.IsNotExist(err) {
		t.Fatalf("the install root was created: %v", err)
	}
}

// The launcher's own options parse as before the install form existed.
func TestLauncherOptionsStillParseWithoutTheInstallForm(t *testing.T) {
	o, err := parseLauncherArgs([]string{"--install", "r", "--releases", "s", "--port", "8123"}, lookupOf(nil))
	if err != nil || o.install != "r" || o.releases != "s" || o.port != 8123 || o.release != "" {
		t.Fatalf("%+v, %v", o, err)
	}
	if _, err := parseLauncherArgs([]string{"--install", "r", "--state", "s"}, lookupOf(nil)); err == nil {
		t.Fatal("--state without --release was accepted")
	}
}
