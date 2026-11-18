package infrastructure_test

import (
	"encoding/json"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/Dreamcoder08/sipges/apps/api-go/internal/system/application"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/system/infrastructure"
)

// Twin of apps/api/src/contexts/system/infrastructure/file-desktop-update-channel.ts, through the
// cases of apps/api/test/desktop/desktop-update*.test.ts. Synthetic versions only.

const okStatus = `{"format":1,"installed":"1.0.0","available":{"version":"1.1.0","notes":null}}`

func channelWith(t *testing.T, status string) string {
	t.Helper()
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "status.json"), []byte(status), 0o600); err != nil {
		t.Fatal(err)
	}
	return dir
}

func read(t *testing.T, dir string) application.DesktopUpdateCheck {
	t.Helper()
	check, err := infrastructure.NewFileDesktopUpdateChannel(dir, time.Now).Read(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	return check
}

func TestReadsWhatTheLauncherVerified(t *testing.T) {
	notes := "Corrige el filtro de registros.\nNuevo resumen semanal."
	status, _ := json.Marshal(map[string]any{
		"format": 1, "installed": "1.0.0", "checkedAt": "2026-11-11T00:00:00Z",
		"available": map[string]any{"version": "1.1.0", "notes": notes},
	})
	got := read(t, channelWith(t, string(status)))
	if got.Installed == nil || *got.Installed != "1.0.0" || got.Available == nil ||
		got.Available.Version != "1.1.0" || got.Available.Notes == nil || *got.Available.Notes != notes {
		t.Fatalf("got %+v", got)
	}
}

func TestAcceptsWhatZodAccepts(t *testing.T) {
	for name, status := range map[string]string{
		"format written 1.0":          `{"format":1.0,"installed":"1.0.0","available":{"version":"1.1.0","notes":null}}`,
		"format written 1e0":          `{"format":1e0,"installed":"1.0.0","available":{"version":"1.1.0","notes":null}}`,
		"extra keys":                  `{"format":1,"installed":"1.0.0","x":[1],"available":{"version":"1.1.0","notes":null,"y":2}}`,
		"duplicate key, last wins":    `{"format":2,"format":1,"installed":"1.0.0","available":{"version":"1.1.0","notes":null}}`,
		"version of 256 UTF-16 units": `{"format":1,"installed":"1.0.0","available":{"version":"` + strings.Repeat("x", 254) + `😀","notes":null}}`,
		"surrounding whitespace":      " \n" + okStatus + "\n\t",
	} {
		t.Run(name, func(t *testing.T) {
			if got := read(t, channelWith(t, status)); got.Available == nil {
				t.Fatalf("offered nothing for %s", status)
			}
		})
	}
}

// A status the launcher did not write in the expected shape offers nothing (boundaries test).
func TestAMalformedStatusOffersNothing(t *testing.T) {
	cases := map[string]string{
		"format 2":                  `{"format":2,"installed":"1.0.0","available":{"version":"1.1.0","notes":null}}`,
		"format as text":            `{"format":"1","installed":"1.0.0","available":{"version":"1.1.0","notes":null}}`,
		"empty version":             `{"format":1,"installed":"1.0.0","available":{"version":"","notes":null}}`,
		"version of 300":            `{"format":1,"installed":"1.0.0","available":{"version":"` + strings.Repeat("x", 300) + `","notes":null}}`,
		"version of 257 UTF-16":     `{"format":1,"installed":"1.0.0","available":{"version":"` + strings.Repeat("x", 255) + `😀","notes":null}}`,
		"notes of 4001":             `{"format":1,"installed":"1.0.0","available":{"version":"1.1.0","notes":"` + strings.Repeat("n", 4001) + `"}}`,
		"available as text":         `{"format":1,"installed":"1.0.0","available":"1.1.0"}`,
		"notes missing":             `{"format":1,"installed":"1.0.0","available":{"version":"1.1.0"}}`,
		"installed missing":         `{"format":1,"available":{"version":"1.1.0","notes":null}}`,
		"available missing":         `{"format":1,"installed":"1.0.0"}`,
		"installed empty":           `{"format":1,"installed":"","available":{"version":"1.1.0","notes":null}}`,
		"keys in another case":      `{"Format":1,"Installed":"1.0.0","Available":{"Version":"1.1.0","Notes":null}}`,
		"an array":                  `[` + okStatus + `]`,
		"null":                      `null`,
		"empty":                     ``,
		"cut short":                 `{"format":1,"installed":`,
		"a byte order mark":         "\ufeff" + okStatus,
		"trailing text":             okStatus + "x",
		"format as true":            `{"format":true,"installed":"1.0.0","available":{"version":"1.1.0","notes":null}}`,
		"version as number":         `{"format":1,"installed":"1.0.0","available":{"version":1,"notes":null}}`,
		"notes as number":           `{"format":1,"installed":"1.0.0","available":{"version":"1.1.0","notes":1}}`,
		"installed as object":       `{"format":1,"installed":{},"available":{"version":"1.1.0","notes":null}}`,
		"available as empty object": `{"format":1,"installed":"1.0.0","available":{}}`,
	}
	for name, status := range cases {
		t.Run(name, func(t *testing.T) {
			got := read(t, channelWith(t, status))
			if got.Installed != nil || got.Available != nil {
				t.Fatalf("got %+v for %s", got, status)
			}
		})
	}
}

func TestAMissingStatusOffersNothing(t *testing.T) {
	got := read(t, t.TempDir())
	if got.Installed != nil || got.Available != nil {
		t.Fatalf("got %+v", got)
	}
	// A folder where the file should be reads as nothing too, as EISDIR does in Node.
	dir := t.TempDir()
	if err := os.Mkdir(filepath.Join(dir, "status.json"), 0o700); err != nil {
		t.Fatal(err)
	}
	if got := read(t, dir); got.Available != nil {
		t.Fatalf("got %+v", got)
	}
}

func TestWritesTheRequestWholeThenRenamesIt(t *testing.T) {
	dir := channelWith(t, okStatus)
	at := time.Date(2026, 11, 18, 3, 4, 5, 6_000_000, time.UTC)
	channel := infrastructure.NewFileDesktopUpdateChannel(dir, func() time.Time { return at })
	if err := channel.Request(t.Context(), "1.1.0"); err != nil {
		t.Fatal(err)
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	var names []string
	for _, e := range entries {
		names = append(names, e.Name())
	}
	if !slices.Equal(names, []string{"request.json", "status.json"}) {
		t.Fatalf("files %v", names)
	}
	body, err := os.ReadFile(filepath.Join(dir, "request.json"))
	if err != nil {
		t.Fatal(err)
	}
	// JSON.stringify of { format, version, requestedAt: toISOString() } and a newline.
	if want := `{"format":1,"version":"1.1.0","requestedAt":"2026-11-18T03:04:05.006Z"}` + "\n"; string(body) != want {
		t.Fatalf("request %q\nwant    %q", body, want)
	}
	info, err := os.Stat(filepath.Join(dir, "request.json"))
	if err != nil {
		t.Fatal(err)
	}
	if perm := info.Mode().Perm(); perm&0o077 != 0 && !isWindows() {
		t.Fatalf("mode %v", perm)
	}
	// A second click replaces the first request.
	if err := channel.Request(t.Context(), "1.1.0"); err != nil {
		t.Fatal(err)
	}
}

func TestARequestToAMissingFolderFails(t *testing.T) {
	channel := infrastructure.NewFileDesktopUpdateChannel(filepath.Join(t.TempDir(), "gone"), time.Now)
	if err := channel.Request(t.Context(), "1.1.0"); err == nil {
		t.Fatal("no error")
	}
}
