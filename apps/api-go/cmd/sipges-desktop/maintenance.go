package main

// The recovery and maintenance commands of deploy/desktop/updater/update.mjs, so a Go install
// needs no Node to finish an interrupted update or clean old copies: --recover,
// --recover --accept-restored-state, --copies and --remove-copies-older-than <days>. Same
// arguments, output, refusals and exit codes as update.mjs.

import (
	"context"
	"errors"
	"fmt"
	"io"
	"regexp"
	"strconv"

	"github.com/Dreamcoder08/sipges/apps/api-go/internal/platform/desktopupdate"
)

// maxCopyAgeDays bounds --remove-copies-older-than: an older limit removes nothing either way,
// and a larger one would overflow the age as a time.Duration.
const maxCopyAgeDays = 100000

// maintenanceRunningNotice: another launcher holds the install's lock; nothing was changed.
const maintenanceRunningNotice = "SIPGES está en ejecución en este equipo: ciérrelo antes de recuperar o borrar copias."

// maintenanceOrphanNotice: a PostgreSQL left running could not be stopped; nothing was changed.
const maintenanceOrphanNotice = "No se cambió nada: un PostgreSQL de un inicio anterior sigue en ejecución sobre la carpeta de datos y no se pudo detener. No borre nada. Reinicie el equipo y vuelva a intentarlo, o contacte con soporte."

var wholeDays = regexp.MustCompile(`^\d+$`)

// maintenanceFlags are the maintenance options that take no value.
func maintenanceFlags(o *launcherOptions) map[string]*bool {
	return map[string]*bool{"--recover": &o.recover, "--accept-restored-state": &o.accept, "--copies": &o.copies}
}

// maintenance reports whether the options ask for a maintenance form.
func maintenance(o launcherOptions) bool {
	return o.recover || o.accept || o.copies || o.olderThan != ""
}

// checkMaintenanceForm follows update.mjs parse, copies and main: each form takes only --install
// (and --pg-bin, for the leftover PostgreSQL stop), with update.mjs's messages.
func checkMaintenanceForm(o *launcherOptions, seen map[string]bool) error {
	if o.accept && !o.recover {
		return errors.New("--accept-restored-state goes with --recover")
	}
	others := o.prepareOnly || o.trustRelease
	for key := range seen {
		if key != "--install" && key != "--pg-bin" && key != "--remove-copies-older-than" {
			others = true
		}
	}
	if o.copies || o.olderThan != "" {
		if others || o.recover || (o.copies && o.olderThan != "") {
			return errors.New("--copies and --remove-copies-older-than take only --install")
		}
		if o.olderThan == "" {
			return nil
		}
		days, err := strconv.Atoi(o.olderThan)
		if !wholeDays.MatchString(o.olderThan) || (err == nil && days < 1) {
			return errors.New("--remove-copies-older-than takes a whole number of days, 1 or more")
		}
		if err != nil || days > maxCopyAgeDays {
			days = maxCopyAgeDays // only digits: too large for an int
		}
		o.olderThanDays = days
		return nil
	}
	if others {
		return errors.New("--recover takes only --install and --accept-restored-state")
	}
	return nil
}

// runMaintenance runs one maintenance form and returns its exit code. Listing the copies only
// reads. Recovery and removal take the launcher lock first, so they never run while SIPGES runs
// on this install, then stop a PostgreSQL a killed launcher left running on the state folder or
// a copy (stopOrphans), as the managed start does before Recover. They start nothing.
func runMaintenance(ctx context.Context, root string, o launcherOptions, stdout, stderr io.Writer, stopOrphans func(context.Context, []string) error) int {
	fail := func(err error) int {
		_, _ = fmt.Fprintln(stderr, "Error: "+err.Error())
		return desktopupdate.ExitCode(err)
	}
	if o.copies {
		return listCopies(root, stdout, fail)
	}
	lock, err := acquireLauncherLock(root)
	if errors.Is(err, errLauncherRunning) {
		_, _ = fmt.Fprintln(stderr, maintenanceRunningNotice)
	}
	if err != nil {
		return fail(err)
	}
	defer func() { _ = lock.Close() }()
	if err := stopOrphans(ctx, stateFolders(root)); err != nil {
		_, _ = fmt.Fprintln(stderr, maintenanceOrphanNotice)
		return fail(err)
	}
	if o.olderThan != "" {
		return removeCopies(ctx, root, o.olderThanDays, stdout, fail)
	}
	if o.accept {
		accepted, err := desktopupdate.AcceptRestoredState(ctx, root)
		if err != nil {
			return fail(err)
		}
		if accepted.Accepted {
			_, _ = fmt.Fprintf(stdout, "Accepted the restored state folder; current version %s.\n", versionOf(accepted.Current))
		} else {
			_, _ = fmt.Fprintf(stdout, "Nothing to recover; current version %s.\n", versionOf(accepted.Current))
		}
		return 0
	}
	result, err := desktopupdate.Recover(ctx, root)
	if err != nil {
		return fail(err)
	}
	if result.Recovered {
		_, _ = fmt.Fprintf(stdout, "Recovered: rolled back to %s.\n", versionOf(result.Current))
	} else {
		_, _ = fmt.Fprintf(stdout, "Nothing to recover; current version %s.\n", versionOf(result.Current))
	}
	return 0
}

// versionOf is the current version's name, "none" when nothing is installed.
func versionOf(c *desktopupdate.Current) string {
	if c == nil {
		return "none"
	}
	return c.Version
}

func listCopies(root string, stdout io.Writer, fail func(error) int) int {
	listed, err := desktopupdate.ListStateCopies(root)
	if err != nil {
		return fail(err)
	}
	_, _ = fmt.Fprintf(stdout, "Copies beside %s: %d, %d bytes\n", listed.StateDir, listed.Count, listed.Bytes)
	for _, c := range listed.Copies {
		_, _ = fmt.Fprintf(stdout, "  %s %s %d bytes %s\n", c.Kind, c.At.UTC().Format("2006-01-02T15:04:05Z"), c.Bytes, c.Path)
	}
	return 0
}

func removeCopies(ctx context.Context, root string, days int, stdout io.Writer, fail func(error) int) int {
	result, err := desktopupdate.RemoveStateCopies(ctx, desktopupdate.RemoveOptions{Root: root, OlderThanDays: days})
	if err != nil {
		return fail(err)
	}
	var bytes int64
	for _, c := range result.Removed {
		_, _ = fmt.Fprintf(stdout, "Removed %s (%d bytes)\n", c.Path, c.Bytes)
		bytes += c.Bytes
	}
	if result.Kept != "" {
		_, _ = fmt.Fprintf(stdout, "Kept %s: the newest pre-update copy is never removed.\n", result.Kept)
	}
	switch n := len(result.Removed); n {
	case 0:
		_, _ = fmt.Fprintln(stdout, "Nothing removed.")
	case 1:
		_, _ = fmt.Fprintf(stdout, "Removed 1 copy (%d bytes); %d left beside the state folder.\n", bytes, result.Left)
	default:
		_, _ = fmt.Fprintf(stdout, "Removed %d copies (%d bytes); %d left beside the state folder.\n", n, bytes, result.Left)
	}
	return 0
}
