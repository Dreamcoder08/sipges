package cli

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"strings"
)

// stty runs on the terminal itself. It stands in for golang.org/x/term because this package imports
// the standard library alone, and the standard library cannot turn echo off.
func stty(terminal *os.File, args ...string) (string, error) {
	command := exec.Command("stty", args...) //nolint:noctx,gosec // restoring the terminal must outlive a cancelled run; the arguments are ours or stty's own
	command.Stdin = terminal
	out, err := command.Output()
	return strings.TrimSpace(string(out)), err
}

// typedPassword reads the password line. On a terminal the kernel would echo it, so echo goes off
// until the line arrives, or until the command is interrupted. Anything else echoes nothing.
func (a *app) typedPassword(ctx context.Context, readLine func() string) (string, error) {
	terminal, ok := a.stdin.(*os.File)
	if !ok || !a.stdinIsTerminal() {
		return readLine(), nil
	}
	saved, err := stty(terminal, "-g")
	if errors.Is(err, exec.ErrNotFound) {
		return "", localError("cannot hide a typed password without stty: set SIPGES_PASSWORD")
	}
	if err != nil { // a character device that is no terminal, such as /dev/null
		return readLine(), nil //nolint:nilerr // that device has no echo to turn off
	}
	if _, err := stty(terminal, "-echo"); err != nil {
		return "", localError("cannot hide a typed password: set SIPGES_PASSWORD")
	}
	defer func() { _, _ = stty(terminal, saved) }()
	_, _ = fmt.Fprint(a.stderr, "Password: ")
	defer func() { _, _ = fmt.Fprintln(a.stderr) }() // the Enter key was not echoed either
	line := make(chan string, 1)
	go func() { line <- readLine() }()
	select {
	case password := <-line:
		return password, nil
	case <-ctx.Done():
		return "", usageError("no password: the prompt was interrupted")
	}
}
