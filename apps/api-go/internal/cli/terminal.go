package cli

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"os/signal"
	"strings"
	"syscall"
)

// NotifyContext ends a run on every signal a terminal or a supervisor sends, so a run can still put
// the terminal back and remove a reserved secret file.
func NotifyContext(parent context.Context) (context.Context, context.CancelFunc) {
	return signal.NotifyContext(parent, os.Interrupt, syscall.SIGTERM, syscall.SIGHUP, syscall.SIGQUIT)
}

// stty runs on the terminal itself. It stands in for golang.org/x/term because this package imports
// the standard library alone, and the standard library cannot turn echo off.
func stty(terminal *os.File, args ...string) (string, error) {
	command := exec.Command("stty", args...) //nolint:noctx,gosec // restoring the terminal must outlive a cancelled run; the arguments are ours or stty's own
	command.Stdin = terminal
	out, err := command.Output()
	return strings.TrimSpace(string(out)), err
}

// typedPassword reads one password line after prompt. On a terminal the kernel would echo it, so
// echo goes off until the line arrives, or until the command is interrupted. Anything else echoes
// nothing. A terminal that cannot be silenced refuses with noStty, which says how else to send it.
func (a *app) typedPassword(ctx context.Context, prompt, noStty string, readLine func() string) (string, error) {
	terminal, ok := a.stdin.(*os.File)
	if !ok || !a.stdinIsTerminal() {
		return readLine(), nil
	}
	saved, err := stty(terminal, "-g")
	if err == nil {
		_, err = stty(terminal, "-echo")
	}
	if err != nil {
		return "", localError("%s", noStty)
	}
	defer func() { _, _ = stty(terminal, saved) }()
	_, _ = fmt.Fprint(a.stderr, prompt)
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
