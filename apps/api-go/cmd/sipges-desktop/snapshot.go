package main

import (
	"io"

	"github.com/Dreamcoder08/sipges/apps/api-go/internal/platform/desktopsnapshot"
)

// snapshotModes are the visit's before-photo and comparison (deploy/desktop/migration's
// snapshot.mjs and compare.mjs, without Node): the mode is the first argument, and the rest are
// the scripts' own options.
var snapshotModes = map[string]func([]string, desktopsnapshot.Env) int{
	"--snapshot": desktopsnapshot.RunSnapshot,
	"--compare":  desktopsnapshot.RunCompare,
}

// usesSnapshot reports whether the arguments ask for --snapshot or --compare.
func usesSnapshot(args []string) bool {
	return len(args) > 0 && snapshotModes[args[0]] != nil
}

// runSnapshotMode runs --snapshot or --compare and returns the exit code.
func runSnapshotMode(args, environ []string, term *desktopsnapshot.Terminal, stdout, stderr io.Writer) int {
	return snapshotModes[args[0]](args[1:], desktopsnapshot.Env{
		Lookup: lookupIn(environ), Terminal: term, Stdout: stdout, Stderr: stderr,
	})
}
