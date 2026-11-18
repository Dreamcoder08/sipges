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

// probeTimeout bounds the protocol probe of the port a postmaster.pid names.
const probeTimeout = 2 * time.Second

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
// postmaster.pid names. The file alone proves nothing: a server that died leaves it behind, and
// after a restart the operating system may give its process id to another program (common on
// Windows). It counts only when that process is alive, works in dataDir where the system tells
// (Linux), and the port the file names answers the PostgreSQL protocol on loopback.
//
// A server that does not answer is not counted, and is never signalled: PostgreSQL's own check of
// postmaster.pid still keeps a second server off the folder.
func Serving(ctx context.Context, dataDir string) (int, bool) {
	pf, ok := readPidFile(dataDir)
	if !ok {
		return 0, false
	}
	if !pidAlive(pf.pid) {
		return pf.pid, false
	}
	if known, in := processInDir(pf.pid, dataDir); known && !in {
		return pf.pid, false
	}
	return pf.pid, answersPostgres(ctx, pf.port)
}

// answersPostgres sends an SSLRequest to 127.0.0.1:port and accepts only a PostgreSQL answer.
func answersPostgres(ctx context.Context, port int) bool {
	if port <= 0 || port > 65535 {
		return false
	}
	ctx, cancel := context.WithTimeout(ctx, probeTimeout)
	defer cancel()
	var d net.Dialer
	conn, err := d.DialContext(ctx, "tcp", net.JoinHostPort("127.0.0.1", strconv.Itoa(port)))
	if err != nil {
		return false
	}
	defer func() { _ = conn.Close() }()
	deadline, _ := ctx.Deadline()
	if conn.SetDeadline(deadline) != nil {
		return false
	}
	if _, err := conn.Write(sslRequest); err != nil {
		return false
	}
	answer := make([]byte, 1)
	if _, err := conn.Read(answer); err != nil {
		return false
	}
	return answer[0] == 'S' || answer[0] == 'N'
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
	if known, in := processInDir(pf.pid, s.opts.DataDir); known && !in {
		if err := os.Remove(filepath.Join(s.opts.DataDir, "postmaster.pid")); err != nil && !errors.Is(err, os.ErrNotExist) {
			return &Error{Kind: ErrStart, Path: s.opts.LogPath, Err: err}
		}
	}
	return nil
}
