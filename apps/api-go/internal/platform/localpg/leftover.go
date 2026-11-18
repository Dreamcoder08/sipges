package localpg

import (
	"context"
	"errors"
	"net"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

// probeTimeout bounds the protocol probe of the port a postmaster.pid names. It is longer than
// the two seconds Windows spends retrying a refused connection, so a closed port reads as refused.
var probeTimeout = 5 * time.Second

// sslRequest is the PostgreSQL protocol's SSLRequest: length 8, code 80877103. Any PostgreSQL
// answers it with one byte, 'S' or 'N', before it asks for a password, and logs nothing when the
// connection then closes.
var sslRequest = []byte{0, 0, 0, 8, 0x04, 0xd2, 0x16, 0x2f}

// pidFile is what Serving reads from postmaster.pid: the first line (process id) and the fourth
// (port).
type pidFile struct{ pid, port int }

func readPidFile(dataDir string) (pidFile, bool) {
	body, err := os.ReadFile(filepath.Join(dataDir, "postmaster.pid")) //nolint:gosec // G304: inside the configured data folder
	if err != nil {
		return pidFile{}, false
	}
	lines := strings.Split(string(body), "\n")
	pid, err := strconv.Atoi(strings.TrimSpace(lines[0]))
	if err != nil || pid <= 0 {
		return pidFile{}, false
	}
	pf := pidFile{pid: pid}
	if len(lines) > 3 {
		pf.port, _ = strconv.Atoi(strings.TrimSpace(lines[3]))
	}
	return pf, true
}

// Serving reports whether a PostgreSQL server serves dataDir, with the process id its
// postmaster.pid names. The rule is asymmetric: a live server must never be missed, since the
// callers copy or rename the folder when it is free, and a stale file must never lock the client
// out.
//
// A file whose process is dead is free: a server that died leaves it behind. A live process the
// system proves to be PostgreSQL on dataDir serves it, listening or not (frozen, starting up,
// socket or IPv6 only); one it proves to be another program is free, since after a restart the
// system may give a dead server's process id to anything. When the system does not tell, the port
// the file names decides: only a refused connection or a reply that is not PostgreSQL's frees the
// folder, and silence or a timeout counts as serving.
func Serving(ctx context.Context, dataDir string) (int, bool) {
	pf, ok := readPidFile(dataDir)
	if !ok {
		return 0, false
	}
	if !pidAlive(pf.pid) {
		return pf.pid, false
	}
	switch processIdentity(pf.pid, dataDir) {
	case identityPostgres:
		return pf.pid, true
	case identityOther:
		return pf.pid, false
	default:
		return pf.pid, portServing(ctx, pf.port)
	}
}

// portServing sends an SSLRequest to 127.0.0.1:port. A PostgreSQL answer, silence or a timeout
// count as serving; a refused connection, one closed without an answer or another answer do not.
// A port that cannot be probed proves nothing and counts as serving.
func portServing(ctx context.Context, port int) bool {
	if port <= 0 || port > 65535 {
		return true
	}
	ctx, cancel := context.WithTimeout(ctx, probeTimeout)
	defer cancel()
	var d net.Dialer
	conn, err := d.DialContext(ctx, "tcp", net.JoinHostPort("127.0.0.1", strconv.Itoa(port)))
	if err != nil {
		return !connectionRefused(err)
	}
	defer func() { _ = conn.Close() }()
	deadline, _ := ctx.Deadline()
	if conn.SetDeadline(deadline) != nil {
		return true
	}
	if _, err := conn.Write(sslRequest); err != nil {
		return timedOut(err)
	}
	answer := make([]byte, 1)
	if _, err := conn.Read(answer); err != nil {
		return timedOut(err)
	}
	return answer[0] == 'S' || answer[0] == 'N'
}

func timedOut(err error) bool {
	var netErr net.Error
	return errors.As(err, &netErr) && netErr.Timeout()
}

// StopLeftover stops a server left running on opts.DataDir, typically by a launcher that was
// killed: pg_ctl stop -m fast on that folder and, when that fails, a kill through pg_ctl. It never
// starts PostgreSQL, needs no password and takes no lock, so it is safe on a copy of the state
// folder. A folder no server serves (see Serving) is left as it is; stopped reports a stop.
func StopLeftover(ctx context.Context, opts Options) (stopped bool, err error) {
	opts = withDefaults(opts)
	if _, serving := Serving(ctx, opts.DataDir); !serving {
		return false, nil
	}
	s := &Server{opts: opts}
	if err := s.stopOrKill(ctx); err != nil {
		return false, err
	}
	return true, nil
}

// stopLeftover runs under the lock before a start: a server that serves the folder is an orphan
// of a dead instance and is stopped; a postmaster.pid whose process is proven to be another
// program is removed, since PostgreSQL would refuse to start while that program lives.
func (s *Server) stopLeftover(ctx context.Context) error {
	if _, serving := Serving(ctx, s.opts.DataDir); serving {
		return s.stopServer(ctx)
	}
	pf, ok := readPidFile(s.opts.DataDir)
	if !ok || !pidAlive(pf.pid) {
		return nil
	}
	if processIdentity(pf.pid, s.opts.DataDir) == identityOther {
		if err := os.Remove(filepath.Join(s.opts.DataDir, "postmaster.pid")); err != nil && !errors.Is(err, os.ErrNotExist) {
			return &Error{Kind: ErrStart, Path: s.opts.LogPath, Err: err}
		}
	}
	return nil
}
