package main

import (
	"bytes"
	"strings"
	"testing"

	"github.com/Dreamcoder08/sipges/apps/api-go/internal/platform/desktopsnapshot"
)

// --snapshot and --compare are recognised only as the first argument, and run without starting
// PostgreSQL or the API: the rest are snapshot.mjs's and compare.mjs's own options.
func TestSnapshotModesAreTheFirstArgument(t *testing.T) {
	for _, args := range [][]string{{"--snapshot"}, {"--compare", "--help"}} {
		if !usesSnapshot(args) {
			t.Errorf("%v is not a snapshot mode", args)
		}
	}
	for _, args := range [][]string{nil, {"--state", "--snapshot"}, {"--move-pglite"}, {"--install", "x"}} {
		if usesSnapshot(args) {
			t.Errorf("%v was taken for a snapshot mode", args)
		}
	}
	term := &desktopsnapshot.Terminal{In: strings.NewReader(""), Out: &bytes.Buffer{}}
	for mode, usage := range map[string]string{"--snapshot": desktopsnapshot.SnapshotUsage, "--compare": desktopsnapshot.CompareUsage} {
		var out, errOut bytes.Buffer
		if code := runSnapshotMode([]string{mode, "--help"}, nil, term, &out, &errOut); code != 0 || out.String() != usage+"\n" {
			t.Errorf("%s --help: %d %q %q", mode, code, out.String(), errOut.String())
		}
	}
	var out, errOut bytes.Buffer
	code := runSnapshotMode([]string{"--compare", "--url", "http://127.0.0.1:9"}, nil, term, &out, &errOut)
	if code != 1 || errOut.String() != "Error: --before and --url are required\n" || out.Len() != 0 {
		t.Errorf("--compare without --before: %d %q %q", code, out.String(), errOut.String())
	}
}
