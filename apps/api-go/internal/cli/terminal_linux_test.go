package cli

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"
	"unsafe"
)

// openPTY returns both ends of a real terminal, with the kernel's default echo on.
func openPTY(t *testing.T) (controller, terminal *os.File) {
	t.Helper()
	controller, err := os.OpenFile("/dev/ptmx", os.O_RDWR, 0)
	if err != nil {
		t.Skipf("no pseudo-terminal: %v", err)
	}
	t.Cleanup(func() { _ = controller.Close() })
	var unlock, number int32
	const setLock, getNumber = 0x40045431, 0x80045430 // TIOCSPTLCK, TIOCGPTN
	if _, _, errno := syscall.Syscall(syscall.SYS_IOCTL, controller.Fd(), setLock, uintptr(unsafe.Pointer(&unlock))); errno != 0 {
		t.Skipf("unlock: %v", errno)
	}
	if _, _, errno := syscall.Syscall(syscall.SYS_IOCTL, controller.Fd(), getNumber, uintptr(unsafe.Pointer(&number))); errno != 0 {
		t.Skipf("number: %v", errno)
	}
	terminal, err = os.OpenFile(filepath.Join("/dev/pts", strconv.Itoa(int(number))), os.O_RDWR|syscall.O_NOCTTY, 0)
	if err != nil {
		t.Skipf("open: %v", err)
	}
	t.Cleanup(func() { _ = terminal.Close() })
	return controller, terminal
}

func echoOn(t *testing.T, terminal *os.File) bool {
	t.Helper()
	var state syscall.Termios
	if _, _, errno := syscall.Syscall(syscall.SYS_IOCTL, terminal.Fd(), syscall.TCGETS, uintptr(unsafe.Pointer(&state))); errno != 0 {
		t.Fatal(errno)
	}
	return state.Lflag&syscall.ECHO != 0
}

type lockedBuffer struct {
	mu sync.Mutex
	b  bytes.Buffer
}

func (l *lockedBuffer) Write(p []byte) (int, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.b.Write(p)
}

func (l *lockedBuffer) String() string {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.b.String()
}

func waitFor(t *testing.T, what string, done func() bool) {
	t.Helper()
	for deadline := time.Now().Add(10 * time.Second); !done(); time.Sleep(5 * time.Millisecond) {
		if time.Now().After(deadline) {
			t.Fatalf("timed out waiting for %s", what)
		}
	}
}

// loginOnTerminal runs login with stdin on a terminal, and returns the exit code's channel.
func loginOnTerminal(ctx context.Context, h *harness, terminal *os.File, stderr *lockedBuffer) <-chan int {
	exit := make(chan int, 1)
	go func() {
		exit <- Run(ctx, []string{"login", "--username", "ana"}, IO{
			Stdin: terminal, Stdout: &bytes.Buffer{}, Stderr: stderr,
			Env: func(name string) string { return h.env[name] },
		})
	}()
	return exit
}

func TestATypedPasswordDoesNotEchoAndTheTerminalComesBack(t *testing.T) {
	controller, terminal := openPTY(t)
	var form string
	h := newHarness(t, func(w http.ResponseWriter, r *http.Request) {
		_ = r.ParseForm()
		form = r.PostForm.Get("password")
		jsonAnswer(w, http.StatusOK, `{"ok":true,"name":"Ana","role":"admin"}`)
	})
	echoed := &lockedBuffer{}
	go func() {
		buffer := make([]byte, 4096)
		for {
			n, err := controller.Read(buffer)
			if err != nil {
				return
			}
			_, _ = echoed.Write(buffer[:n])
		}
	}()
	stderr := &lockedBuffer{}
	exit := loginOnTerminal(t.Context(), h, terminal, stderr)
	waitFor(t, "the prompt", func() bool { return strings.Contains(stderr.String(), "Password: ") })
	if echoOn(t, terminal) {
		t.Fatal("echo is on while the password is typed")
	}
	if _, err := controller.WriteString(syntheticPassword + "\n"); err != nil {
		t.Fatal(err)
	}
	if code := <-exit; code != ExitOK {
		t.Fatalf("exit %d: %s", code, stderr.String())
	}
	if form != syntheticPassword {
		t.Fatalf("the API got %q", form)
	}
	if strings.Contains(echoed.String()+stderr.String(), syntheticPassword) {
		t.Fatal("the password reached the terminal")
	}
	if !echoOn(t, terminal) {
		t.Fatal("the terminal stayed silent")
	}
}

func TestCtrlCDuringThePromptGivesTheTerminalBack(t *testing.T) {
	_, terminal := openPTY(t)
	h := newHarness(t, nil)
	ctx, cancel := context.WithCancel(t.Context())
	defer cancel()
	stderr := &lockedBuffer{}
	exit := loginOnTerminal(ctx, h, terminal, stderr)
	waitFor(t, "the prompt", func() bool { return strings.Contains(stderr.String(), "Password: ") })
	cancel()
	select {
	case code := <-exit:
		if code == ExitOK {
			t.Fatal("a cancelled prompt signed in")
		}
	case <-time.After(10 * time.Second):
		t.Fatal("the prompt ignored the cancellation")
	}
	if !echoOn(t, terminal) {
		t.Fatal("the terminal stayed silent")
	}
}

// Anything but a terminal has no echo to hide, so it needs no stty, as before.
func TestDevNullNeedsNoStty(t *testing.T) {
	t.Setenv("PATH", "")
	null, err := os.Open(os.DevNull)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = null.Close() }()
	h := newHarness(t, nil)
	stderr := &lockedBuffer{}
	if code := <-loginOnTerminal(t.Context(), h, null, stderr); code != ExitUsage || !strings.Contains(stderr.String(), "no password") {
		t.Fatalf("exit %d: %s", code, stderr.String())
	}
}

// A terminal that cannot be silenced refuses the password instead of echoing it.
func TestATerminalWithoutSttyRefusesThePrompt(t *testing.T) {
	t.Setenv("PATH", "")
	_, terminal := openPTY(t)
	h := newHarness(t, nil)
	stderr := &lockedBuffer{}
	if code := <-loginOnTerminal(t.Context(), h, terminal, stderr); code != ExitLocal ||
		!strings.Contains(stderr.String(), "cannot hide a typed password without a working stty: set SIPGES_PASSWORD") {
		t.Fatalf("exit %d: %s", code, stderr.String())
	}
}

// password ignores SIPGES_PASSWORD, so without stty it points at stdin instead.
func TestPasswordWithoutSttyPointsAtStdin(t *testing.T) {
	t.Setenv("PATH", "")
	_, terminal := openPTY(t)
	h := newHarness(t, nil)
	stderr := &lockedBuffer{}
	if code := <-passwordOnTerminal(t.Context(), h, terminal, stderr); code != ExitLocal ||
		!strings.Contains(stderr.String(), passwordNoStty) || strings.Contains(stderr.String(), "SIPGES_PASSWORD") {
		t.Fatalf("exit %d: %s", code, stderr.String())
	}
}

// passwordOnTerminal runs password with stdin on a terminal, and returns the exit code's channel.
func passwordOnTerminal(ctx context.Context, h *harness, terminal *os.File, stderr *lockedBuffer) <-chan int {
	exit := make(chan int, 1)
	go func() {
		exit <- Run(ctx, []string{"password"}, IO{
			Stdin: terminal, Stdout: &bytes.Buffer{}, Stderr: stderr,
			Env: func(name string) string { return h.env[name] },
		})
	}()
	return exit
}

// typeAt waits for prompt to appear, then types line on the terminal.
func typeAt(t *testing.T, controller *os.File, stderr *lockedBuffer, prompt, line string) {
	t.Helper()
	waitFor(t, prompt, func() bool { return strings.Contains(stderr.String(), prompt) })
	if _, err := controller.WriteString(line + "\n"); err != nil {
		t.Fatal(err)
	}
}

// On a terminal the new password is asked twice: a match sends it, a mismatch sends nothing.
func TestPasswordOnATerminalAsksForTheNewOneTwice(t *testing.T) {
	for _, again := range []string{syntheticNewPassword, syntheticNewPassword + "-typo"} {
		controller, terminal := openPTY(t)
		go func() { _, _ = io.Copy(io.Discard, controller) }()
		var sent map[string]string
		h := newHarness(t, fakeLogin(func(w http.ResponseWriter, r *http.Request) {
			raw, _ := io.ReadAll(r.Body)
			_ = json.Unmarshal(raw, &sent)
			w.WriteHeader(http.StatusNoContent)
		}))
		h.signIn()
		stderr := &lockedBuffer{}
		exit := passwordOnTerminal(t.Context(), h, terminal, stderr)
		typeAt(t, controller, stderr, "Current password: ", syntheticPassword)
		typeAt(t, controller, stderr, "New password: ", syntheticNewPassword)
		typeAt(t, controller, stderr, "New password again: ", again)
		code := <-exit
		if again == syntheticNewPassword {
			if code != ExitOK || sent["new_password"] != syntheticNewPassword {
				t.Fatalf("match: exit %d, sent %v: %s", code, sent, stderr.String())
			}
			continue
		}
		if code != ExitUsage || sent != nil || !strings.Contains(stderr.String(), passwordMismatch) {
			t.Fatalf("mismatch: exit %d, sent %v: %s", code, sent, stderr.String())
		}
	}
}

// Every signal that ends a run reaches its context, or the prompt could not clean up.
func TestEveryEndingSignalCancelsTheRun(t *testing.T) {
	for _, sent := range []syscall.Signal{syscall.SIGINT, syscall.SIGTERM, syscall.SIGHUP, syscall.SIGQUIT} {
		ctx, stop := NotifyContext(t.Context())
		if err := syscall.Kill(syscall.Getpid(), sent); err != nil {
			t.Fatal(err)
		}
		select {
		case <-ctx.Done():
		case <-time.After(5 * time.Second):
			t.Fatalf("%v did not cancel the run", sent)
		}
		stop()
	}
}
