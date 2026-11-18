// Package localpg runs the PostgreSQL 18 server of the desktop install (docs/adr/0036 §2–3):
// initdb once with the pinned locale, then pg_ctl start on 127.0.0.1 and a port chosen free at
// start, and a fast stop. It needs no Windows service and no administrator rights. Every program
// runs from an argument slice, never through a shell.
package localpg

import (
	"context"
	"errors"
	"fmt"
	"net"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

// DefaultSuperUser is the cluster's superuser when Options.SuperUser is empty.
const DefaultSuperUser = "postgres"

// supportedMajor is the PostgreSQL major version the desktop bundles (ADR 0036 §1).
const supportedMajor = 18

const (
	defaultStartTimeout = 60 * time.Second
	defaultStopTimeout  = 30 * time.Second
	pingTimeout         = 5 * time.Second
	// portAttempts bounds the retries when another program takes the free port between the
	// check and the server's own bind.
	portAttempts = 3
	// lingerChecks × lingerPause is how long a failed start is watched for a server still coming up.
	lingerChecks = 30
	lingerPause  = 100 * time.Millisecond
	// renameAttempts × renamePause bounds the retries of the final rename of a new cluster.
	renameAttempts = 10
	renamePause    = 200 * time.Millisecond
)

// Options locate the cluster.
type Options struct {
	// BinDir is the folder holding initdb, pg_ctl and postgres (the bundle's bin).
	BinDir string
	// DataDir is the cluster's folder: created by initdb when missing or empty, refused when it
	// holds anything that is not a PostgreSQL 18 cluster.
	DataDir string
	// LogPath receives the server log and the output of initdb and pg_ctl.
	LogPath string
	// SuperUser defaults to DefaultSuperUser.
	SuperUser string
	// SuperPassword becomes the superuser's password at initdb; every login needs a password
	// (scram-sha-256), so another account on the computer cannot connect without it.
	SuperPassword string
	// StartTimeout and StopTimeout bound pg_ctl; zero picks 60 s and 30 s.
	StartTimeout time.Duration
	StopTimeout  time.Duration
	// Setup runs once, on a new cluster, while it is still in its temporary folder: the cluster is
	// moved into DataDir only when Setup succeeded, so an interrupted first start leaves nothing
	// half made in DataDir.
	Setup func(ctx context.Context, s *Server) error
}

// setupSuffix names the sibling folder a new cluster is built in.
const setupSuffix = ".setup"

// Server is a started cluster.
type Server struct {
	opts Options
	port int
}

type dataState int

const (
	dataEmpty dataState = iota
	dataCluster
)

// Start starts the cluster in DataDir on a free loopback port and returns once it accepts
// connections. A missing or empty DataDir gets a new cluster, built and set up in a sibling
// folder first (see Options.Setup); a leftover of an interrupted build is removed. A server
// another instance runs on DataDir is refused with ErrInUse; one whose process is gone or no
// longer answers is stopped first.
func Start(ctx context.Context, opts Options) (*Server, error) {
	opts = withDefaults(opts)
	state, err := inspectDataDir(opts.DataDir)
	if err != nil {
		return nil, err
	}
	if err := checkBinaries(ctx, opts.BinDir); err != nil {
		return nil, err
	}
	if err := os.RemoveAll(opts.DataDir + setupSuffix); err != nil {
		return nil, &Error{Kind: ErrInit, Path: opts.LogPath, Err: fmt.Errorf("remove the leftover setup folder: %w", err)}
	}
	if state == dataEmpty {
		if err := buildCluster(ctx, opts); err != nil {
			return nil, err
		}
	}
	s := &Server{opts: opts}
	if err := s.refuseLiveOrClearStale(ctx); err != nil {
		return nil, err
	}
	if err := s.start(ctx); err != nil {
		return nil, err
	}
	return s, nil
}

// buildCluster runs initdb and Setup in the sibling setup folder, stops that server and only then
// renames the folder to DataDir: DataDir holds either nothing or a finished cluster.
func buildCluster(ctx context.Context, opts Options) error {
	tmp := opts.DataDir + setupSuffix
	build := opts
	build.DataDir = tmp
	err := initCluster(ctx, build)
	if err == nil && opts.Setup != nil {
		staging := &Server{opts: build}
		if err = staging.start(ctx); err == nil {
			if setupErr := opts.Setup(ctx, staging); setupErr != nil {
				err = &Error{Kind: ErrInit, Path: opts.LogPath, Err: fmt.Errorf("setup: %w", setupErr)}
			}
			err = errors.Join(err, staging.stopDetached(ctx))
		}
	}
	if err == nil {
		err = moveIntoPlace(tmp, opts.DataDir)
	}
	if err != nil {
		_ = os.RemoveAll(tmp)
		return err
	}
	return nil
}

// moveIntoPlace renames the finished cluster to DataDir, retrying briefly: on Windows an antivirus
// scan may still hold a file of the folder just after the server stopped.
func moveIntoPlace(tmp, dataDir string) error {
	if err := os.Remove(dataDir); err != nil && !errors.Is(err, os.ErrNotExist) {
		return &Error{Kind: ErrInit, Path: dataDir, Err: err}
	}
	var err error
	for range renameAttempts {
		if err = os.Rename(tmp, dataDir); err == nil {
			return nil
		}
		time.Sleep(renamePause)
	}
	return &Error{Kind: ErrInit, Path: dataDir, Err: err}
}

// refuseLiveOrClearStale leaves a server that answers alone (ErrInUse) and stops one that runs
// but does not answer. A pid file whose process is gone needs nothing: the server replaces it.
func (s *Server) refuseLiveOrClearStale(ctx context.Context) error {
	running, err := s.running(ctx)
	if err != nil || !running {
		return err
	}
	if port := pidFilePort(s.opts.DataDir); port > 0 && (&Server{opts: s.opts, port: port}).answers(ctx) {
		return &Error{Kind: ErrInUse, Path: s.opts.DataDir}
	}
	return s.Stop(ctx)
}

// answers is true when a PostgreSQL server replies on the port, even with an error such as
// "the database system is starting up": something else owns it.
func (s *Server) answers(ctx context.Context) bool {
	err := s.Ping(ctx)
	var pgErr *pgconn.PgError
	return err == nil || errors.As(err, &pgErr)
}

// pidFilePort reads the port, line 4 of postmaster.pid; zero when unreadable.
func pidFilePort(dataDir string) int {
	body, err := os.ReadFile(filepath.Join(dataDir, "postmaster.pid")) //nolint:gosec // G304: the configured data folder
	if err != nil {
		return 0
	}
	lines := strings.Split(string(body), "\n")
	if len(lines) < 4 {
		return 0
	}
	port, err := strconv.Atoi(strings.TrimSpace(lines[3]))
	if err != nil {
		return 0
	}
	return port
}

// start runs pg_ctl start on a free port. A start that fails or times out stops whatever server it
// may have left starting before returning the error.
func (s *Server) start(ctx context.Context) error {
	var startErr error
	for range portAttempts {
		port, err := freePort(ctx)
		if err != nil {
			return &Error{Kind: ErrStart, Path: s.opts.LogPath, Err: err}
		}
		s.port = port
		startErr = s.pgctl(ctx, startArgs(s.opts.DataDir, s.opts.LogPath, port, startWait(s.opts.StartTimeout)))
		if startErr == nil || portFree(ctx, port) {
			break
		}
	}
	if startErr == nil {
		startErr = s.Ping(ctx)
	}
	if startErr != nil {
		return errors.Join(&Error{Kind: ErrStart, Path: s.opts.LogPath, Err: startErr}, s.stopAfterFailedStart(ctx))
	}
	return nil
}

// stopAfterFailedStart waits a moment for a server pg_ctl gave up on to show up in the pid file,
// and stops it, so a timeout never leaves a server running that nothing will stop.
func (s *Server) stopAfterFailedStart(ctx context.Context) error {
	for range lingerChecks {
		if running, err := s.running(context.WithoutCancel(ctx)); err == nil && running {
			return s.stopDetached(ctx)
		}
		time.Sleep(lingerPause)
	}
	return nil
}

// stopDetached is Stop with its own deadline, for cleanups that must run after ctx ended.
func (s *Server) stopDetached(ctx context.Context) error {
	stopCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), s.opts.StopTimeout+5*time.Second)
	defer cancel()
	return s.Stop(stopCtx)
}

// Stop shuts the server down with a fast shutdown: open transactions roll back, nothing written
// is lost. Stopping a server that is not running does nothing.
func (s *Server) Stop(ctx context.Context) error {
	running, err := s.running(ctx)
	if err != nil || !running {
		return err
	}
	if err := s.pgctl(ctx, stopArgs(s.opts.DataDir, seconds(s.opts.StopTimeout))); err != nil {
		return &Error{Kind: ErrStop, Path: s.opts.LogPath, Err: err}
	}
	return nil
}

// Ping connects as the superuser and runs one query.
func (s *Server) Ping(ctx context.Context) error {
	ctx, cancel := context.WithTimeout(ctx, pingTimeout)
	defer cancel()
	conn, err := pgx.Connect(ctx, s.SuperUserURL("postgres"))
	if err != nil {
		return fmt.Errorf("connect: %w", err)
	}
	defer func() { _ = conn.Close(context.WithoutCancel(ctx)) }()
	var one int
	return conn.QueryRow(ctx, "SELECT 1").Scan(&one)
}

// Port is the TCP port chosen at start.
func (s *Server) Port() int { return s.port }

// URL connects to database as user on the server's loopback address. Never log it: it holds the
// password.
func (s *Server) URL(user, password, database string) string {
	u := url.URL{
		Scheme:   "postgres",
		User:     url.UserPassword(user, password),
		Host:     net.JoinHostPort("127.0.0.1", strconv.Itoa(s.port)),
		Path:     "/" + database,
		RawQuery: "sslmode=disable",
	}
	return u.String()
}

// SuperUserURL is URL as the cluster's superuser.
func (s *Server) SuperUserURL(database string) string {
	return s.URL(s.opts.SuperUser, s.opts.SuperPassword, database)
}

func withDefaults(opts Options) Options {
	if opts.SuperUser == "" {
		opts.SuperUser = DefaultSuperUser
	}
	if opts.StartTimeout <= 0 {
		opts.StartTimeout = defaultStartTimeout
	}
	if opts.StopTimeout <= 0 {
		opts.StopTimeout = defaultStopTimeout
	}
	return opts
}

// inspectDataDir tells an empty (or missing) folder from a PostgreSQL 18 cluster, and refuses
// anything else without writing to it.
func inspectDataDir(dir string) (dataState, error) {
	entries, err := os.ReadDir(dir)
	if errors.Is(err, os.ErrNotExist) {
		return dataEmpty, nil
	}
	if err != nil {
		return 0, &Error{Kind: ErrForeignDataDir, Path: dir, Err: err}
	}
	if len(entries) == 0 {
		return dataEmpty, nil
	}
	version, err := os.ReadFile(filepath.Join(dir, "PG_VERSION")) //nolint:gosec // G304: the configured data folder
	if err != nil {
		return 0, &Error{Kind: ErrForeignDataDir, Path: dir, Err: errors.New("no PG_VERSION")}
	}
	if got := strings.TrimSpace(string(version)); got != strconv.Itoa(supportedMajor) {
		return 0, &Error{Kind: ErrForeignDataDir, Path: dir, Err: fmt.Errorf("PG_VERSION is %q", got)}
	}
	return dataCluster, nil
}

func checkBinaries(ctx context.Context, binDir string) error {
	for _, name := range []string{"initdb", "pg_ctl", "postgres"} {
		info, err := os.Stat(program(binDir, name))
		if err != nil || info.IsDir() {
			return &Error{Kind: ErrBinariesMissing, Path: binDir, Err: fmt.Errorf("%s not found", name)}
		}
	}
	cmd := exec.CommandContext(ctx, program(binDir, "postgres"), "--version") //nolint:gosec // G204: the bundle's own program, arguments fixed
	hideWindow(cmd)
	out, err := cmd.Output()
	if ctx.Err() != nil {
		return ctx.Err()
	}
	if err != nil {
		return &Error{Kind: ErrWrongBinaries, Path: binDir, Err: err}
	}
	if major := majorVersion(string(out)); major != supportedMajor {
		return &Error{Kind: ErrWrongBinaries, Path: binDir, Err: fmt.Errorf("postgres --version: %q", strings.TrimSpace(string(out)))}
	}
	return nil
}

var versionLine = regexp.MustCompile(`\(PostgreSQL\) (\d+)`)

// majorVersion reads `postgres (PostgreSQL) 18.7`; zero when the output is something else.
func majorVersion(out string) int {
	m := versionLine.FindStringSubmatch(out)
	if m == nil {
		return 0
	}
	major, err := strconv.Atoi(m[1])
	if err != nil {
		return 0
	}
	return major
}

func initCluster(ctx context.Context, opts Options) error {
	if err := os.MkdirAll(opts.DataDir, 0o700); err != nil {
		return &Error{Kind: ErrInit, Path: opts.LogPath, Err: err}
	}
	pwfile, err := writePasswordFile(opts.SuperPassword)
	if err != nil {
		return &Error{Kind: ErrInit, Path: opts.LogPath, Err: err}
	}
	defer func() { _ = os.Remove(pwfile) }()
	if err := runLogged(ctx, opts.LogPath, program(opts.BinDir, "initdb"), initdbArgs(opts.DataDir, opts.SuperUser, pwfile)); err != nil {
		return &Error{Kind: ErrInit, Path: opts.LogPath, Err: err}
	}
	return nil
}

// writePasswordFile hands initdb the password through a file only this user can read, so it never
// appears in a command line.
func writePasswordFile(password string) (string, error) {
	if password == "" {
		return "", errors.New("the superuser password is empty")
	}
	f, err := os.CreateTemp("", "sipges-pg-*")
	if err != nil {
		return "", err
	}
	_, werr := f.WriteString(password + "\n")
	if err := errors.Join(werr, f.Close()); err != nil {
		_ = os.Remove(f.Name())
		return "", err
	}
	return f.Name(), nil
}

// initdbArgs is ADR 0036 §2: the builtin C.UTF-8 locale, UTF8, and a password on every login.
func initdbArgs(dataDir, superUser, pwfile string) []string {
	return []string{
		"-D", dataDir,
		"--locale-provider=builtin", "--locale=C.UTF-8", "-E", "UTF8",
		"-U", superUser, "--auth=scram-sha-256", "--pwfile=" + pwfile,
	}
}

// startArgs listens on loopback only and opens no Unix socket, so nothing depends on a socket
// folder the user may not be allowed to write. The -o value holds no quotes or paths, so pg_ctl
// can pass it on through the platform's shell unchanged.
func startArgs(dataDir, logPath string, port, timeoutSeconds int) []string {
	return []string{
		"start", "-D", dataDir, "-l", logPath, "-w", "-t", strconv.Itoa(timeoutSeconds),
		"-o", "-p " + strconv.Itoa(port) + " -c listen_addresses=127.0.0.1 -c unix_socket_directories=",
	}
}

func stopArgs(dataDir string, timeoutSeconds int) []string {
	return []string{"stop", "-D", dataDir, "-m", "fast", "-w", "-t", strconv.Itoa(timeoutSeconds)}
}

// running asks pg_ctl status: exit 0 is running, 3 not running, 4 no readable data folder.
func (s *Server) running(ctx context.Context) (bool, error) {
	err := s.pgctl(ctx, []string{"status", "-D", s.opts.DataDir})
	var exit *exec.ExitError
	switch {
	case err == nil:
		return true, nil
	case errors.As(err, &exit) && (exit.ExitCode() == 3 || exit.ExitCode() == 4):
		return false, nil
	}
	return false, &Error{Kind: ErrStop, Path: s.opts.LogPath, Err: err}
}

func (s *Server) pgctl(ctx context.Context, args []string) error {
	return runLogged(ctx, s.opts.LogPath, program(s.opts.BinDir, "pg_ctl"), args)
}

// runLogged appends the program's output to the log. It is a file, not a pipe, so a server that
// pg_ctl leaves running cannot hold this process waiting on the output.
func runLogged(ctx context.Context, logPath, path string, args []string) error {
	if err := os.MkdirAll(filepath.Dir(logPath), 0o700); err != nil {
		return err
	}
	log, err := os.OpenFile(logPath, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o600) //nolint:gosec // G304: the configured log path
	if err != nil {
		return err
	}
	defer func() { _ = log.Close() }()
	cmd := exec.CommandContext(ctx, path, args...) //nolint:gosec // G204: the bundle's own programs, argument slices without a shell
	cmd.Stdout, cmd.Stderr = log, log
	hideWindow(cmd)
	return cmd.Run()
}

func program(binDir, name string) string {
	if runtime.GOOS == "windows" {
		name += ".exe"
	}
	return filepath.Join(binDir, name)
}

// freePort asks the system for a free loopback port. Another program may take it before the
// server binds; Start then tries another.
func freePort(ctx context.Context) (int, error) {
	ln, err := new(net.ListenConfig).Listen(ctx, "tcp", "127.0.0.1:0")
	if err != nil {
		return 0, err
	}
	port := ln.Addr().(*net.TCPAddr).Port
	return port, ln.Close()
}

func portFree(ctx context.Context, port int) bool {
	ln, err := new(net.ListenConfig).Listen(ctx, "tcp", net.JoinHostPort("127.0.0.1", strconv.Itoa(port)))
	if err != nil {
		return false
	}
	_ = ln.Close()
	return true
}

// startWait is the -t of pg_ctl start; a test sets it to zero to force a timeout.
var startWait = seconds

func seconds(d time.Duration) int { return max(1, int(d.Round(time.Second)/time.Second)) }
