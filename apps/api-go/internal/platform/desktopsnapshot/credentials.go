package desktopsnapshot

import (
	"bufio"
	"errors"
	"fmt"
	"io"
	"math"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"syscall"
	"time"
)

// valued are client.mjs's VALUED options: each takes one value.
var valued = map[string]bool{
	"--url": true, "--user": true, "--password-file": true, "--otp": true, "--totp-secret-file": true,
	"--totp-state": true, "--out": true, "--before": true, "--probe-limit": true,
}

// parseArgs is client.mjs's parseArgs: `--name value` pairs, each at most once, from `allowed`.
func parseArgs(args, allowed []string) (map[string]string, error) {
	options := map[string]string{}
	for i := 0; i < len(args); i += 2 {
		key := args[i]
		ok := valued[key]
		if ok {
			ok = false
			for _, a := range allowed {
				ok = ok || a == key
			}
		}
		if !ok || i+1 >= len(args) || options[key] != "" {
			return nil, fmt.Errorf("Invalid option %s; use --help", key) //nolint:staticcheck // ST1005: client.mjs's message
		}
		options[key] = args[i+1]
	}
	return options, nil
}

// Terminal is where the questions go: stdin, and stderr for the prompts.
type Terminal struct {
	In  io.Reader
	Out io.Writer
	// IsTerminal reports a typing person; without one every answer is empty, as in Node.
	IsTerminal func() bool
	// HideTyping turns echo off and returns what restores it.
	HideTyping func() (restore func(), err error)
	// Interrupted delivers a Ctrl+C while a hidden answer is typed.
	Interrupted func() (<-chan os.Signal, func())
	lines       *bufio.Reader
}

// SystemTerminal is the process's own console.
func SystemTerminal() *Terminal {
	return &Terminal{
		In: os.Stdin, Out: os.Stderr,
		IsTerminal:  func() bool { return isTerminal(os.Stdin) },
		HideTyping:  func() (func(), error) { return hideTyping(os.Stdin) },
		Interrupted: notifyPromptSignals,
	}
}

func (t *Terminal) line() (string, error) {
	if t.lines == nil {
		t.lines = bufio.NewReader(t.In)
	}
	text, err := t.lines.ReadString('\n')
	if err != nil && !errors.Is(err, io.EOF) {
		return "", err
	}
	return strings.TrimRight(text, "\r\n"), nil
}

// promptSignals end a hidden prompt; the terminal is put back before the run stops.
var promptSignals = []os.Signal{os.Interrupt, syscall.SIGTERM, syscall.SIGHUP}

// notifyPromptSignals delivers promptSignals until stop.
func notifyPromptSignals() (<-chan os.Signal, func()) {
	c := make(chan os.Signal, 1)
	signal.Notify(c, promptSignals...)
	return c, func() { signal.Stop(c) }
}

// signalName names a cancelling signal as the person pressed or a supervisor sent it.
func signalName(sig os.Signal) string {
	switch sig {
	case os.Interrupt:
		return "Ctrl+C"
	case syscall.SIGTERM:
		return "SIGTERM"
	case syscall.SIGHUP:
		return "SIGHUP"
	}
	return sig.String()
}

// ask is client.mjs's ask: a visible question; no terminal answers empty.
func (t *Terminal) ask(question string) (string, error) {
	if t.IsTerminal == nil || !t.IsTerminal() {
		return "", nil
	}
	_, _ = fmt.Fprint(t.Out, question)
	answer, err := t.line()
	return Trim(answer), err
}

// readHidden is client.mjs's readHidden: nothing typed is echoed, the terminal is always put
// back, and Ctrl+C cancels.
func (t *Terminal) readHidden(question string) (string, error) {
	if t.IsTerminal == nil || !t.IsTerminal() || t.HideTyping == nil {
		return "", nil
	}
	// The signals first: one that arrives once echo is off must find the terminal restorable.
	var interrupted <-chan os.Signal
	if t.Interrupted != nil {
		c, stop := t.Interrupted()
		defer stop()
		interrupted = c
	}
	restore, err := t.HideTyping()
	if err != nil {
		return "", err
	}
	defer func() {
		restore()
		_, _ = fmt.Fprintln(t.Out)
	}()
	_, _ = fmt.Fprint(t.Out, question)
	type result struct {
		text string
		err  error
	}
	done := make(chan result, 1)
	go func() {
		text, err := t.line()
		done <- result{text, err}
	}()
	select {
	case r := <-done:
		return Trim(r.text), r.err
	case sig := <-interrupted:
		return "", fmt.Errorf("Cancelado (%s)", signalName(sig)) //nolint:staticcheck // ST1005: client.mjs's message, the signal named
	}
}

// readText is readFile(path, 'utf8').
func readText(path string) (string, error) {
	b, err := os.ReadFile(path) //nolint:gosec // the person names their own file
	if err != nil {
		return "", err
	}
	if len(b) >= 3 && b[0] == 0xEF && b[1] == 0xBB && b[2] == 0xBF {
		return "\uFEFF" + DecodeText(b[3:]), nil
	}
	return DecodeText(b), nil
}

// credentials is client.mjs's credentials: the password from --password-file,
// SIPGES_MIGRATION_PASSWORD or a hidden prompt; the code from --otp, --totp-secret-file or a
// prompt (empty for no MFA).
func credentials(options map[string]string, lookup func(string) (string, bool), t *Terminal) (Login, error) {
	l := Login{Base: options["--url"], Username: "admin", TOTPState: options["--totp-state"]}
	if u, ok := options["--user"]; ok {
		l.Username = u
	}
	var err error
	switch file := options["--password-file"]; {
	case file != "":
		if l.Password, err = readText(file); err != nil {
			return Login{}, err
		}
		l.Password = Trim(l.Password)
	default:
		var set bool
		if l.Password, set = lookup("SIPGES_MIGRATION_PASSWORD"); !set {
			if l.Password, err = t.readHidden("Contraseña: "); err != nil {
				return Login{}, err
			}
		}
	}
	if file := options["--totp-secret-file"]; file != "" {
		if l.TOTPSecret, err = readText(file); err != nil {
			return Login{}, err
		}
		l.TOTPSecret = Trim(l.TOTPSecret)
	}
	if otp, ok := options["--otp"]; ok {
		l.OTP = otp
	} else if l.TOTPSecret == "" {
		if l.OTP, err = t.ask("Código MFA (vacío si no tiene): "); err != nil {
			return Login{}, err
		}
	}
	return l, nil
}

const stepSeconds = 30

func stepNow() int64 { return time.Now().Unix() / stepSeconds }

// nextStep is client.mjs's nextStep: the server refuses a step at or before the last one it
// accepted, so stateFile (synthetic rehearsals only) remembers the last one across processes.
func nextStep(stateFile string) (int64, error) {
	last := -1.0
	if stateFile != "" {
		text, err := readText(stateFile)
		switch {
		case err == nil:
			v, perr := ParseJSON(text)
			if perr != nil {
				return 0, fmt.Errorf("%s is not valid JSON", stateFile)
			}
			o, _ := v.(*Object)
			last = ToNumber(o.Get("lastStep"))
		case !errors.Is(err, os.ErrNotExist):
			return 0, err
		}
	}
	if math.IsNaN(last) || math.IsInf(last, 0) {
		return 0, errors.New("The last TOTP step in --totp-state is not a number") //nolint:staticcheck // a sentence for the person
	}
	step := int64(math.Max(float64(stepNow()), last+1))
	for step > stepNow()+1 {
		time.Sleep(time.Second)
	}
	if stateFile != "" {
		if err := os.WriteFile(stateFile, []byte(`{"lastStep":`+strconv.FormatInt(step, 10)+`}`), 0o600); err != nil {
			return 0, err
		}
	}
	return step, nil
}

var errNoHiddenPrompt = errors.New("No se puede ocultar la contraseña en esta terminal: use --password-file o SIPGES_MIGRATION_PASSWORD") //nolint:staticcheck // a sentence for the person
