package pglitewasm

import (
	"bufio"
	"bytes"
	"context"
	"testing"
	"time"
)

// slowResetBackend answers like fakeBackend but takes a while over DISCARD ALL, the last step of
// the session reset between clients.
type slowResetBackend struct{ fakeBackend }

func (f *slowResetBackend) Exchange(ctx context.Context, msg []byte) ([]byte, error) {
	if msg[0] == 'Q' && bytes.Contains(msg, []byte("DISCARD ALL")) {
		time.Sleep(300 * time.Millisecond)
	}
	return f.fakeBackend.Exchange(ctx, msg)
}

// A client that connects right after the previous one left waits for the session reset instead
// of being refused: pg_dump disconnects and the move connects at once.
func TestServerHandsTheSessionToTheNextClientAfterItsReset(t *testing.T) {
	s, err := serve(context.Background(), &slowResetBackend{})
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = s.Close() }()
	startup := startupPacket(3<<16, []byte("user\x00postgres\x00\x00"))

	first := dial(t, s)
	r := bufio.NewReader(first)
	if _, err := first.Write(startup); err != nil {
		t.Fatal(err)
	}
	if typ, _ := readMessage(t, r); typ != 'Z' {
		t.Fatalf("first startup reply %q", typ)
	}
	if _, err := first.Write(frontendMessage('X', nil)); err != nil {
		t.Fatal(err)
	}
	_ = first.Close()

	next := dial(t, s)
	if _, err := next.Write(startup); err != nil {
		t.Fatal(err)
	}
	if typ, body := readMessage(t, bufio.NewReader(next)); typ != 'Z' {
		t.Fatalf("the next client got %q %q, want the session once reset", typ, body)
	}
}
