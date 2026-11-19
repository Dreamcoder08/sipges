package pglitewasm

import (
	"bufio"
	"context"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"net"
	"sync"
)

// Startup codes of the PostgreSQL frontend protocol (src/include/libpq/pqcomm.h).
const (
	protocolMajor3   = 3
	cancelRequest    = 1234<<16 | 5678
	sslRequest       = 1234<<16 | 5679
	gssencRequest    = 1234<<16 | 5680
	maxStartupPacket = 10000    // MAX_STARTUP_PACKET_LENGTH
	maxMessageBytes  = 64 << 20 // far above anything pg_dump or pgx send
	maxBatchBytes    = 1 << 20  // whole messages already buffered are fed together up to this size
	readBufferBytes  = 64 << 10
	sqlstateTooMany  = "53300" // too_many_connections
	sqlstateFailed   = "58000" // system_error
	sqlstateProtocol = "08P01" // protocol_violation
)

// ErrOneConnection is the message a second simultaneous client receives.
const ErrOneConnection = "pglitewasm: the PGlite copy serves one connection at a time"

// exchanger is the part of Backend the server needs; tests replace it.
type exchanger interface {
	Exchange(ctx context.Context, msg []byte) ([]byte, error)
}

// Server is a loopback PostgreSQL wire-protocol endpoint over one Backend, so native clients
// (pg_dump, pgx) can read the PGlite copy. It trusts every client: it listens on 127.0.0.1 only,
// serves one connection at a time and never logs what passes through it.
type Server struct {
	ex  exchanger
	ln  net.Listener
	ctx context.Context

	mu     sync.Mutex
	active net.Conn
	conns  map[net.Conn]struct{}
	err    error // the backend failed: every later client gets an error
	closed bool
	wg     sync.WaitGroup
}

// Serve listens on 127.0.0.1 at a random free port and serves b until Close; ctx bounds the
// listen only. The caller still owns b and closes it after the server.
func Serve(ctx context.Context, b *Backend) (*Server, error) { return serve(ctx, b) }

func serve(ctx context.Context, ex exchanger) (*Server, error) {
	var lc net.ListenConfig
	ln, err := lc.Listen(ctx, "tcp4", "127.0.0.1:0")
	if err != nil {
		return nil, fmt.Errorf("pglitewasm: listen on loopback: %w", err)
	}
	s := &Server{ex: ex, ln: ln, ctx: context.WithoutCancel(ctx), conns: map[net.Conn]struct{}{}}
	s.wg.Add(1)
	go s.acceptLoop()
	return s, nil
}

// Addr is the loopback address clients connect to.
func (s *Server) Addr() *net.TCPAddr { return s.ln.Addr().(*net.TCPAddr) }

// Port is Addr's port.
func (s *Server) Port() int { return s.Addr().Port }

// Err reports the backend failure that stopped the server from serving, if any. It never holds
// row values: only the transport error of the failed call.
func (s *Server) Err() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.err
}

// Close stops listening, drops every connection and waits for the handlers. A call into the
// backend already running finishes first.
func (s *Server) Close() error {
	s.mu.Lock()
	s.closed = true
	for c := range s.conns {
		_ = c.Close()
	}
	s.mu.Unlock()
	err := s.ln.Close()
	s.wg.Wait()
	if errors.Is(err, net.ErrClosed) {
		err = nil
	}
	return err
}

func (s *Server) acceptLoop() {
	defer s.wg.Done()
	for {
		c, err := s.ln.Accept()
		if err != nil {
			return
		}
		s.mu.Lock()
		if s.closed {
			s.mu.Unlock()
			_ = c.Close()
			return
		}
		s.conns[c] = struct{}{}
		s.wg.Add(1)
		s.mu.Unlock()
		go s.handle(c)
	}
}

func (s *Server) handle(c net.Conn) {
	defer s.wg.Done()
	defer func() {
		s.mu.Lock()
		delete(s.conns, c)
		s.mu.Unlock()
		_ = c.Close()
	}()
	r := bufio.NewReaderSize(c, readBufferBytes)
	startup, err := readStartup(r, c)
	if err != nil || startup == nil {
		return // gone, a cancel request (ignored: one statement runs at a time anyway) or garbage
	}
	if !s.acquire(c) {
		_, _ = c.Write(errorResponse(sqlstateTooMany, ErrOneConnection))
		return
	}
	defer s.release(c)
	if err := s.Err(); err != nil {
		_, _ = c.Write(errorResponse(sqlstateFailed, "pglitewasm: the PGlite backend failed earlier"))
		return
	}
	if !s.relay(c, startup) {
		return
	}
	defer s.resetSession()
	for {
		batch, terminate, err := readBatch(r)
		if len(batch) > 0 && !s.relay(c, batch) {
			return
		}
		if terminate || err != nil {
			if err != nil && !errors.Is(err, io.EOF) && !errors.Is(err, net.ErrClosed) {
				_, _ = c.Write(errorResponse(sqlstateProtocol, "pglitewasm: invalid frontend message"))
			}
			return
		}
	}
}

// relay feeds whole frontend messages to the backend and writes back everything it answered.
func (s *Server) relay(c net.Conn, msg []byte) bool {
	out, err := s.ex.Exchange(s.ctx, msg)
	if err != nil {
		s.mu.Lock()
		if s.err == nil {
			s.err = err
		}
		s.mu.Unlock()
		_, _ = c.Write(errorResponse(sqlstateFailed, "pglitewasm: the PGlite backend failed"))
		return false
	}
	_, err = c.Write(out)
	return err == nil
}

// resetSession leaves the single PGlite session clean for the next client: it ends any
// extended-protocol error state and open transaction, then drops prepared statements, cursors
// and session settings (pgx names its statements by hash, so a new client reuses the names).
func (s *Server) resetSession() {
	if _, err := s.ex.Exchange(s.ctx, frontendMessage('S', nil)); err != nil {
		s.fail(err)
		return
	}
	for _, sql := range []string{"ROLLBACK", "DISCARD ALL"} {
		res, err := runSimple(s.ctx, s.ex, sql)
		if err == nil && res.Error != "" && sql != "ROLLBACK" {
			err = fmt.Errorf("pglitewasm: %s failed between clients", sql)
		}
		if err != nil {
			s.fail(err)
			return
		}
	}
}

func (s *Server) fail(err error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.err == nil {
		s.err = err
	}
}

func (s *Server) acquire(c net.Conn) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.active != nil || s.closed {
		return false
	}
	s.active = c
	return true
}

func (s *Server) release(c net.Conn) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.active == c {
		s.active = nil
	}
}

// readStartup reads the first packet (int32 length, int32 code, body), answering SSLRequest and
// GSSENCRequest with 'N' until a StartupMessage arrives. It returns nil for a CancelRequest.
func readStartup(r *bufio.Reader, w io.Writer) ([]byte, error) {
	for {
		var head [8]byte
		if _, err := io.ReadFull(r, head[:]); err != nil {
			return nil, err
		}
		n := binary.BigEndian.Uint32(head[:4])
		if n < 8 || n > maxStartupPacket {
			return nil, fmt.Errorf("pglitewasm: startup packet of %d bytes", n)
		}
		pkt := make([]byte, n)
		copy(pkt, head[:])
		if _, err := io.ReadFull(r, pkt[8:]); err != nil {
			return nil, err
		}
		switch code := binary.BigEndian.Uint32(head[4:]); {
		case code == sslRequest || code == gssencRequest:
			if _, err := w.Write([]byte{'N'}); err != nil {
				return nil, err
			}
		case code == cancelRequest:
			return nil, nil
		case code>>16 == protocolMajor3:
			return pkt, nil
		default:
			_, _ = w.Write(errorResponse(sqlstateProtocol, "pglitewasm: unsupported frontend protocol"))
			return nil, fmt.Errorf("pglitewasm: protocol code %d", code)
		}
	}
}

// readBatch blocks for one whole frontend message (type byte, int32 length, body), then adds the
// whole messages already buffered. Terminate ('X') ends the batch and is not forwarded.
func readBatch(r *bufio.Reader) (batch []byte, terminate bool, err error) {
	for {
		if len(batch) > 0 && !wholeMessageBuffered(r) {
			return batch, false, nil
		}
		var head [5]byte
		if _, err := io.ReadFull(r, head[:]); err != nil {
			if errors.Is(err, io.ErrUnexpectedEOF) {
				err = io.EOF
			}
			return batch, false, err
		}
		if head[0] == 'X' {
			return batch, true, nil
		}
		n := binary.BigEndian.Uint32(head[1:])
		if n < 4 || n > maxMessageBytes {
			return batch, false, fmt.Errorf("pglitewasm: frontend message of %d bytes", n)
		}
		start := len(batch)
		batch = append(batch, make([]byte, 1+int(n))...)
		copy(batch[start:], head[:])
		if _, err := io.ReadFull(r, batch[start+5:]); err != nil {
			return batch[:start], false, err
		}
		if len(batch) >= maxBatchBytes {
			return batch, false, nil
		}
	}
}

func wholeMessageBuffered(r *bufio.Reader) bool {
	if r.Buffered() < 5 {
		return false
	}
	head, err := r.Peek(5)
	if err != nil {
		return false
	}
	return head[0] == 'X' || int(binary.BigEndian.Uint32(head[1:]))+1 <= r.Buffered()
}

func frontendMessage(typ byte, body []byte) []byte {
	msg := make([]byte, 0, 5+len(body))
	msg = append(msg, typ)
	msg = binary.BigEndian.AppendUint32(msg, n32(len(body)+4))
	return append(msg, body...)
}

// errorResponse is a FATAL ErrorResponse with an SQLSTATE and a message.
func errorResponse(code, message string) []byte {
	var body []byte
	for _, f := range []struct {
		typ byte
		val string
	}{{'S', "FATAL"}, {'V', "FATAL"}, {'C', code}, {'M', message}} {
		body = append(append(append(body, f.typ), f.val...), 0)
	}
	return frontendMessage('E', append(body, 0))
}
