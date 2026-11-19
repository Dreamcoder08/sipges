package main

import (
	"context"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"

	"github.com/Dreamcoder08/sipges/apps/api-go/internal/platform/pglitemove"
)

func TestTheMoveFormIsChosenAndParsedOnce(t *testing.T) {
	if !usesMovePGlite([]string{"--state", "x", "--move-pglite"}) || usesMovePGlite([]string{"--install", "r"}) {
		t.Fatal("usesMovePGlite does not pick the move form only")
	}
	o, err := parseMoveArgs([]string{"--move-pglite", "--state", "copy", "--to=postgres://u@127.0.0.1/x",
		"--prepared", "state", "--scratch", "tmp", "--port", "8123", "--pglite-dist", "dist", "--pg-bin", "bin"})
	if err != nil {
		t.Fatal(err)
	}
	want := moveOptions{state: "copy", to: "postgres://u@127.0.0.1/x", prepared: "state", scratch: "tmp", port: "8123", dist: "dist", bin: "bin"}
	if o != want {
		t.Fatalf("parsed %+v, want %+v", o, want)
	}
	for _, bad := range [][]string{
		{"--move-pglite", "--state", "a", "--state", "b"},
		{"--move-pglite", "--state"},
		{"--move-pglite", "--state", "--to"},
		{"--move-pglite", "--install", "root"},
		{"--move-pglite", "--move-pglite"},
		{"--move-pglite", "extra"},
	} {
		if _, err := parseMoveArgs(bad); err == nil {
			t.Errorf("accepted %q", bad)
		}
	}
}

func TestMoveHelpIsListedAndInvalidOptionsExitTwo(t *testing.T) {
	if !strings.Contains(launcherUsage, "sipges-desktop --move-pglite --state <copy of the state folder>") {
		t.Error("the launcher help does not list --move-pglite")
	}
	var out, errOut strings.Builder
	if code := runMovePGlite(context.Background(), []string{"--move-pglite", "--help"}, nil, "", &out, &errOut, pglitemove.Hooks{}); code != 0 ||
		!strings.Contains(out.String(), "Exit codes: 0 moved, no difference; 1 a difference, nothing committed; 2 refused or failed.") {
		t.Errorf("--help: exit %d\n%s", code, out.String())
	}
	out.Reset()
	if code := runMovePGlite(context.Background(), []string{"--move-pglite", "--nope", "x"}, nil, "", &out, &errOut, pglitemove.Hooks{}); code != 2 ||
		!strings.HasPrefix(errOut.String(), "Usage: SIPGES_MOVE_DATABASE_URL=") {
		t.Errorf("invalid option: exit %d\n%s", code, errOut.String())
	}
}

func TestThePendingMarkIsTheMovesOne(t *testing.T) {
	if pendingMoveName != dataFolder+".pending-move" {
		t.Fatalf("pendingMoveName %q", pendingMoveName)
	}
}

func TestMoveDefaultsComeFromTheManagedInstall(t *testing.T) {
	root, exeDir := installRoot(t)
	version := filepath.Dir(exeDir)
	state := filepath.Join(t.TempDir(), "recorded-state")
	for _, dir := range []string{filepath.Join(exeDir, "pglite"), filepath.Join(version, "postgresql", "bin")} {
		if err := os.MkdirAll(dir, 0o700); err != nil {
			t.Fatal(err)
		}
	}
	writeFile(t, filepath.Join(root, "current.json"), `{"format":1,"version":"1.0.0","path":"versions/1.0.0"}`)
	writeFile(t, filepath.Join(root, "install.json"), `{"format":1,"stateDir":`+jsonString(state)+`}`)
	env := map[string]string{"HOME": "/home/u", "SIPGES_MOVE_DATABASE_URL": "postgres://u@127.0.0.1:5/x", "SIPGES_PG_BIN": "/elsewhere"}
	m := moveDefaults(moveOptions{state: "copy"}, lookupOf(env), exeDir)
	if m.To != env["SIPGES_MOVE_DATABASE_URL"] {
		t.Errorf("target %q not taken from %s", m.To, envMoveURL)
	}
	if m.PGliteDist != filepath.Join(exeDir, "pglite") {
		t.Errorf("dist %q, want the current version's go/pglite", m.PGliteDist)
	}
	if m.PGBin != filepath.Join(version, "postgresql", "bin") {
		t.Errorf("pg bin %q, want the bundled one", m.PGBin)
	}
	if !slices.Contains(m.Originals, state) {
		t.Errorf("originals %q lack the recorded state folder", m.Originals)
	}
	if m.Port != 0 {
		t.Errorf("port %d, want the default", m.Port)
	}

	// Outside a managed install: the explicit options and the environment only.
	m = moveDefaults(moveOptions{state: "copy", dist: "d", bin: "b", port: "x"}, lookupOf(env), t.TempDir())
	if m.PGliteDist != "d" || m.PGBin != "b" || m.Port != -1 || len(m.Originals) != 1 {
		t.Errorf("explicit options: %+v", m)
	}
	env["SIPGES_PGLITE_DIST"] = "envdist"
	if m = moveDefaults(moveOptions{}, lookupOf(env), t.TempDir()); m.PGliteDist != "envdist" || m.PGBin != "/elsewhere" {
		t.Errorf("environment: %+v", m)
	}
}

// The command line refuses the state folder the managed install records, as an original, before
// reading anything; the output never carries the URL.
func TestMoveRefusesTheManagedInstallsOwnStateFolder(t *testing.T) {
	root, exeDir := installRoot(t)
	state := filepath.Join(t.TempDir(), "recorded-state")
	if err := os.MkdirAll(filepath.Join(state, "pglite"), 0o700); err != nil {
		t.Fatal(err)
	}
	writeFile(t, filepath.Join(state, "pglite", "PG_VERSION"), "18\n")
	writeFile(t, filepath.Join(root, "current.json"), `{"format":1,"version":"1.0.0","path":"versions/1.0.0"}`)
	writeFile(t, filepath.Join(root, "install.json"), `{"format":1,"stateDir":`+jsonString(state)+`}`)
	environ := []string{"HOME=" + t.TempDir(), "SIPGES_MOVE_DATABASE_URL=postgres://u:hidden@127.0.0.1:1/x"}
	var out, errOut strings.Builder
	code := runMovePGlite(context.Background(), []string{"--move-pglite", "--state", state}, environ, exeDir, &out, &errOut,
		pglitemove.Hooks{Answers: func(int) bool { return false }})
	if code != 2 || !strings.Contains(out.String(), "RESULT: not moved: --state "+state+" is the original state folder") {
		t.Fatalf("exit %d\n%s", code, out.String())
	}
	if strings.Contains(out.String()+errOut.String(), "hidden") {
		t.Error("the URL was printed")
	}
}

func jsonString(s string) string {
	return `"` + strings.ReplaceAll(strings.ReplaceAll(s, `\`, `\\`), `"`, `\"`) + `"`
}
