package main

import (
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
)

// installRoot lays out a managed install as the installers do: current.json and install.json in
// the root, the version's Go mode in versions/<version>/go. Synthetic content only.
func installRoot(t *testing.T) (root, exeDir string) {
	t.Helper()
	root = t.TempDir()
	exeDir = filepath.Join(root, "versions", "1.0.0", "go")
	if err := os.MkdirAll(exeDir, 0o700); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"current.json", "install.json"} {
		if err := os.WriteFile(filepath.Join(root, name), []byte("{}\n"), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	return root, exeDir
}

func TestTheUpdateChannelIsTheInstallRootsOne(t *testing.T) {
	root, exeDir := installRoot(t)
	env := map[string]string{"HOME": "/home/u", "SIPGES_PG_BIN": "/pg/bin"}
	s, err := parseSettings(nil, lookupOf(env), exeDir)
	if err != nil {
		t.Fatal(err)
	}
	// deploy/desktop/updater/launcher.mjs: join(root, CHANNEL), CHANNEL = 'update-channel'.
	if want := filepath.Join(root, "update-channel"); s.updateChannel != want {
		t.Fatalf("update channel %q, want %q", s.updateChannel, want)
	}
	env["SIPGES_DESKTOP_UPDATE_DIR"] = filepath.Join(root, "env-channel")
	if s, _ = parseSettings(nil, lookupOf(env), exeDir); s.updateChannel != env["SIPGES_DESKTOP_UPDATE_DIR"] {
		t.Fatalf("the environment must win: %q", s.updateChannel)
	}
	flagged := filepath.Join(root, "flag-channel")
	if s, _ = parseSettings([]string{"--update-channel", flagged}, lookupOf(env), exeDir); s.updateChannel != flagged {
		t.Fatalf("the flag must win: %q", s.updateChannel)
	}
}

func TestOutsideAManagedInstallThereIsNoUpdateChannel(t *testing.T) {
	exeDir := filepath.Join(t.TempDir(), "bin")
	s, err := parseSettings(nil, lookupOf(map[string]string{"HOME": "/home/u", "SIPGES_PG_BIN": "/pg/bin"}), exeDir)
	if err != nil {
		t.Fatal(err)
	}
	if s.updateChannel != "" {
		t.Fatalf("update channel %q outside an install root", s.updateChannel)
	}
	// Only one of the two root files is not a managed install either.
	root, exeDir := installRoot(t)
	if err := os.Remove(filepath.Join(root, "install.json")); err != nil {
		t.Fatal(err)
	}
	if s, _ = parseSettings(nil, lookupOf(map[string]string{"HOME": "/home/u", "SIPGES_PG_BIN": "/pg/bin"}), exeDir); s.updateChannel != "" {
		t.Fatalf("update channel %q without install.json", s.updateChannel)
	}
}

func TestTheAPIGetsTheUpdateChannelOnlyWhenThereIsOne(t *testing.T) {
	sec := secrets{dataKey: "key", adminPassword: "pw"}
	with := apiEnv([]string{"PATH=/bin"}, settings{state: "/state", updateChannel: "/root/update-channel"}, sec, "u")
	if !slices.Contains(with, "SIPGES_DESKTOP_UPDATE_DIR=/root/update-channel") {
		t.Fatalf("env %v", with)
	}
	// An inherited empty value would stop the API («must be an absolute path»): it never passes.
	without := apiEnv([]string{"PATH=/bin", "SIPGES_DESKTOP_UPDATE_DIR="}, settings{state: "/state"}, sec, "u")
	for _, kv := range without {
		if strings.HasPrefix(strings.ToUpper(kv), "SIPGES_DESKTOP_UPDATE_DIR=") {
			t.Fatalf("env %v", without)
		}
	}
}
