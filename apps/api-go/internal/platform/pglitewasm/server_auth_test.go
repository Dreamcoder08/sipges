package pglitewasm

import (
	"bufio"
	"context"
	"encoding/binary"
	"net"
	"strings"
	"testing"
)

// startup sends the StartupMessage and answers the cleartext password request with password.
func startup(t *testing.T, c net.Conn, r *bufio.Reader, password string) {
	t.Helper()
	if _, err := c.Write(startupPacket(3<<16, []byte("user\x00postgres\x00\x00"))); err != nil {
		t.Fatal(err)
	}
	typ, body := readMessage(t, r)
	if typ != 'R' || len(body) != 4 || binary.BigEndian.Uint32(body) != authCleartext {
		t.Fatalf("startup answered %q %q, want a cleartext password request", typ, body)
	}
	if _, err := c.Write(frontendMessage('p', append([]byte(password), 0))); err != nil {
		t.Fatal(err)
	}
}

// Another local user can reach 127.0.0.1 too: without the run's password no client reaches the
// backend nor takes the one connection.
func TestServerRequiresTheRunsPasswordBeforeTheBackendSeesAnything(t *testing.T) {
	fake := &fakeBackend{}
	s, err := serve(context.Background(), fake)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = s.Close() }()
	if len(s.Password()) < 32 {
		t.Fatalf("password %d characters, want a random one of at least 32", len(s.Password()))
	}
	other, err := serve(context.Background(), &fakeBackend{})
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = other.Close() }()
	if other.Password() == s.Password() {
		t.Fatal("two servers share a password")
	}

	for _, wrong := range []string{"", "postgres", s.Password()[:len(s.Password())-1], s.Password() + "x"} {
		c := dial(t, s)
		r := bufio.NewReader(c)
		startup(t, c, r, wrong)
		if typ, body := readMessage(t, r); typ != 'E' || !strings.Contains(string(body), "28P01") {
			t.Fatalf("password %q answered %q %q, want 28P01", wrong, typ, body)
		}
		_ = c.Close()
	}
	// A client that answers with anything but a password message is refused as well.
	c := dial(t, s)
	r := bufio.NewReader(c)
	if _, err := c.Write(startupPacket(3<<16, []byte("user\x00postgres\x00\x00"))); err != nil {
		t.Fatal(err)
	}
	readMessage(t, r)
	if _, err := c.Write(frontendMessage('Q', []byte("select 1\x00"))); err != nil {
		t.Fatal(err)
	}
	if typ, body := readMessage(t, r); typ != 'E' || !strings.Contains(string(body), "28P01") {
		t.Fatalf("a query instead of the password answered %q %q", typ, body)
	}
	if got := fake.types(); len(got) != 0 {
		t.Fatalf("the backend saw %v before any client authenticated", got)
	}

	// The right password gets the session at once: the refused clients never held it.
	ok := dial(t, s)
	okr := bufio.NewReader(ok)
	startup(t, ok, okr, s.Password())
	if typ, _ := readMessage(t, okr); typ != 'Z' {
		t.Fatalf("authenticated startup answered %q", typ)
	}
}
