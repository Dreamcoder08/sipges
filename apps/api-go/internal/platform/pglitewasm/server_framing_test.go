package pglitewasm

import (
	"bufio"
	"context"
	"encoding/binary"
	"io"
	"net"
	"strings"
	"sync"
	"testing"
	"time"
)

// fakeBackend records each batch it receives and answers ReadyForQuery.
type fakeBackend struct {
	mu      sync.Mutex
	batches [][]byte
}

func (f *fakeBackend) Exchange(_ context.Context, msg []byte) ([]byte, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.batches = append(f.batches, append([]byte(nil), msg...))
	if msg[0] == 'Q' {
		return append(frontendMessage('C', []byte("SELECT 0\x00")), frontendMessage('Z', []byte{'I'})...), nil
	}
	return frontendMessage('Z', []byte{'I'}), nil
}

func (f *fakeBackend) types() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	var out []string
	for _, b := range f.batches {
		var ts []byte
		if b[0] == 0 {
			out = append(out, "startup")
			continue
		}
		for len(b) >= 5 {
			ts = append(ts, b[0])
			b = b[1+binary.BigEndian.Uint32(b[1:5]):]
		}
		out = append(out, string(ts))
	}
	return out
}

func startupPacket(code uint32, body []byte) []byte {
	pkt := binary.BigEndian.AppendUint32(nil, uint32(8+len(body)))
	return append(binary.BigEndian.AppendUint32(pkt, code), body...)
}

func dial(t *testing.T, s *Server) net.Conn {
	t.Helper()
	c, err := net.DialTimeout("tcp", s.Addr().String(), 5*time.Second)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	_ = c.SetDeadline(time.Now().Add(10 * time.Second))
	t.Cleanup(func() { _ = c.Close() })
	return c
}

func readMessage(t *testing.T, r *bufio.Reader) (byte, []byte) {
	t.Helper()
	var head [5]byte
	if _, err := io.ReadFull(r, head[:]); err != nil {
		t.Fatalf("read: %v", err)
	}
	body := make([]byte, binary.BigEndian.Uint32(head[1:])-4)
	if _, err := io.ReadFull(r, body); err != nil {
		t.Fatalf("read body: %v", err)
	}
	return head[0], body
}

func TestServerFramesWholeMessagesAndNegotiatesEncryption(t *testing.T) {
	fake := &fakeBackend{}
	s, err := serve(context.Background(), fake)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = s.Close() }()

	// A cancel request is read and dropped; it never counts as the connection.
	cancel := dial(t, s)
	if _, err := cancel.Write(startupPacket(cancelRequest, make([]byte, 8))); err != nil {
		t.Fatal(err)
	}
	if n, err := cancel.Read(make([]byte, 1)); n != 0 || err == nil {
		t.Fatalf("cancel request answered: %d %v", n, err)
	}

	c := dial(t, s)
	r := bufio.NewReader(c)
	for _, code := range []uint32{gssencRequest, sslRequest} {
		if _, err := c.Write(startupPacket(code, nil)); err != nil {
			t.Fatal(err)
		}
		if b, err := r.ReadByte(); err != nil || b != 'N' {
			t.Fatalf("encryption request %d answered %q %v, want N", code, b, err)
		}
	}
	if _, err := c.Write(startupPacket(3<<16, []byte("user\x00postgres\x00\x00"))); err != nil {
		t.Fatal(err)
	}
	if typ, _ := readMessage(t, r); typ != 'Z' {
		t.Fatalf("startup reply %q", typ)
	}

	// A second client is refused while the first is connected.
	sc := dial(t, s)
	if _, err := sc.Write(startupPacket(3<<16, []byte("user\x00postgres\x00\x00"))); err != nil {
		t.Fatal(err)
	}
	if typ, body := readMessage(t, bufio.NewReader(sc)); typ != 'E' || !strings.Contains(string(body), ErrOneConnection) || !strings.Contains(string(body), "53300") {
		t.Fatalf("second client got %q %q", typ, body)
	}

	// A message split over several writes reaches the backend whole; Parse+Sync sent together
	// arrive as one batch.
	q := frontendMessage('Q', []byte("select 1\x00"))
	for _, part := range [][]byte{q[:3], q[3:7], q[7:]} {
		if _, err := c.Write(part); err != nil {
			t.Fatal(err)
		}
		time.Sleep(20 * time.Millisecond)
	}
	readMessage(t, r)
	if typ, _ := readMessage(t, r); typ != 'Z' {
		t.Fatalf("query reply %q", typ)
	}
	ext := append(frontendMessage('P', []byte("\x00select 1\x00\x00\x00")), frontendMessage('S', nil)...)
	if _, err := c.Write(ext); err != nil {
		t.Fatal(err)
	}
	if typ, _ := readMessage(t, r); typ != 'Z' {
		t.Fatalf("extended reply %q", typ)
	}
	if _, err := c.Write(frontendMessage('X', nil)); err != nil {
		t.Fatal(err)
	}
	if _, err := r.ReadByte(); err == nil {
		t.Fatal("connection still open after Terminate")
	}

	// Terminate is not forwarded; the session is reset for the next client.
	deadline := time.Now().Add(5 * time.Second)
	want := "startup|Q|PS|S|Q|Q"
	for strings.Join(fake.types(), "|") != want && time.Now().Before(deadline) {
		time.Sleep(10 * time.Millisecond)
	}
	if got := strings.Join(fake.types(), "|"); got != want {
		t.Fatalf("batches = %s, want %s", got, want)
	}
}
