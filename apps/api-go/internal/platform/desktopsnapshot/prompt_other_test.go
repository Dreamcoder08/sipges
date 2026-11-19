//go:build !windows

package desktopsnapshot

import (
	"bytes"
	"os"
	"syscall"
	"testing"
)

// Node's process.stdin.isTTY is isatty(0): /dev/null is a character device, not a terminal, so
// nothing is asked and the answers are empty.
func TestDevNullIsNotATerminal(t *testing.T) {
	null, err := os.Open(os.DevNull)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = null.Close() }()
	if isTerminal(null) {
		t.Fatal("/dev/null was taken for a terminal")
	}
	file, err := os.CreateTemp(t.TempDir(), "stdin")
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = file.Close() }()
	if isTerminal(file) {
		t.Fatal("a file was taken for a terminal")
	}
}

// A SIGTERM or SIGHUP while the password is typed puts the terminal back, as Ctrl+C does, and
// cancels with the signal's name.
func TestPromptSignalsRestoreTheTerminal(t *testing.T) {
	for sig, name := range map[syscall.Signal]string{syscall.SIGTERM: "SIGTERM", syscall.SIGHUP: "SIGHUP", syscall.SIGINT: "Ctrl+C"} {
		restored := false
		typing := &Terminal{
			In: blockingReader{}, Out: &bytes.Buffer{}, IsTerminal: func() bool { return true },
			HideTyping:  func() (func(), error) { return func() { restored = true }, nil },
			Interrupted: notifyPromptSignals,
		}
		done := make(chan error, 1)
		ready := make(chan struct{})
		typing.Out = signalWhenWritten{ready: ready}
		go func() {
			_, err := typing.readHidden("Contraseña: ")
			done <- err
		}()
		<-ready
		if err := syscall.Kill(os.Getpid(), sig); err != nil {
			t.Fatal(err)
		}
		err := <-done
		if err == nil || err.Error() != "Cancelado ("+name+")" || !restored {
			t.Fatalf("%s: %v, restored %v", name, err, restored)
		}
	}
}

// signalWhenWritten closes ready once the prompt is printed (the signals are then subscribed).
type signalWhenWritten struct{ ready chan struct{} }

func (s signalWhenWritten) Write(p []byte) (int, error) {
	select {
	case <-s.ready:
	default:
		if bytes.Contains(p, []byte("Contraseña")) {
			close(s.ready)
		}
	}
	return len(p), nil
}
