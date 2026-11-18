package main

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/Dreamcoder08/sipges/apps/api-go/internal/platform/desktopupdate"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/platform/localpg"
)

const launcherUsage = `Usage: sipges-desktop --install <root> [--releases <dir>] [--port <port>] [--pg-bin <dir>]
       sipges-desktop --install <root> --prepare-only [--pg-bin <dir>]
       sipges-desktop --install <root> --release <dir> --state <dir> (--trust-key <public.pem> | --trust-release-key)

Starts the current version of a managed install on 127.0.0.1 (default port 8000): its bundled
PostgreSQL 18 (<version>/postgresql/bin, else --pg-bin or SIPGES_PG_BIN) on <state>/pg18 and its
Go API (<version>/go/api). It checks <dir> for a newer signed release at startup and offers it in
the app; updates run only after an administrator clicks «Actualizar». Without --releases no
check is made.
--prepare-only creates an empty PostgreSQL 18 cluster in the state folder with the roles, the
database and the migrations, then stops it, so the one-time PGlite migrator can load it. It is
refused when <state>/pg18 already holds data.
A first SIGINT or SIGTERM stops SIPGES gracefully; a second one kills the server at once and
exits with code 1.
--release installs a signed release into an empty <root> and records <state> (its real path) in
install.json, as update.mjs --install does; --trust-release-key trusts the key that signed this
release and prints its SHA-256 fingerprint. It starts nothing.
Exit codes: 0 stopped, 3 an update could not be rolled back and nothing was started (restore
the pre-update copy named in the message), otherwise the server's own exit code or 1.`

// The only SIPGES_* variables a managed API sees (boot.mjs LAUNCHER_ENV, for the Go API).
var launcherVars = map[string]bool{
	"SIPGES_ADMIN_PASSWORD": true, "SIPGES_ALLOWED_HOSTS": true, "SIPGES_COOKIE_SECURE": true,
	"SIPGES_DATA_KEY": true, "SIPGES_DATABASE_URL": true, "SIPGES_DESKTOP_UPDATE_DIR": true,
	"SIPGES_HOST": true, "SIPGES_MIGRATIONS_DIR": true, "SIPGES_PORT": true,
	"SIPGES_UPLOAD_DIR": true, "SIPGES_WEB_DIR": true,
}

const (
	checkTimeout = 10 * time.Second
	pollEvery    = 500 * time.Millisecond
	// bootTimeout bounds one migration or readiness boot of a version (boot.mjs timeoutMs).
	bootTimeout = 120 * time.Second
	// bootPortAttempts: the free port is released before the API binds it (boot.mjs PORT_ATTEMPTS).
	bootPortAttempts = 5
)

// usesInstall reports whether the arguments ask for the managed launcher.
func usesInstall(args []string) bool {
	for _, a := range args {
		if a == "--install" || strings.HasPrefix(a, "--install=") {
			return true
		}
	}
	return false
}

// launcherEnv is base without any SIPGES_* variable, in any letter case (Windows names ignore
// case), followed by owned, which may only name launcher variables.
func launcherEnv(base []string, owned [][2]string) ([]string, error) {
	for _, o := range owned {
		if !launcherVars[o[0]] {
			return nil, fmt.Errorf("%s is not a launcher variable", o[0])
		}
	}
	env := make([]string, 0, len(base)+len(owned))
	for _, kv := range base {
		key, _, _ := strings.Cut(kv, "=")
		if !strings.HasPrefix(strings.ToUpper(key), "SIPGES_") {
			env = append(env, kv)
		}
	}
	for _, o := range owned {
		env = append(env, o[0]+"="+o[1])
	}
	return env, nil
}

// versionBins are the files of one installed version the server runs.
type versionBins struct {
	api        string
	migrations string
	pgBin      string
	web        string // empty when the version ships no web folder
}

func isDir(path string) bool {
	info, err := os.Stat(path)
	return err == nil && info.IsDir()
}

// resolveBins finds a version's Go mode (go/api, go/migrations), its PostgreSQL 18 (postgresql/bin,
// else pgBin) and its web folder.
func resolveBins(versionDir, pgBin string) (versionBins, error) {
	b := versionBins{
		api:        filepath.Join(versionDir, "go", program("api")),
		migrations: filepath.Join(versionDir, "go", "migrations"),
		pgBin:      pgBin,
	}
	if bundled := filepath.Join(versionDir, "postgresql", "bin"); isDir(bundled) {
		b.pgBin = bundled
	}
	if b.pgBin == "" {
		return versionBins{}, &userError{
			msg: "No se encontró PostgreSQL 18 para el modo Go: indique la carpeta bin de PostgreSQL 18 en SIPGES_PG_BIN.",
			err: fmt.Errorf("no postgresql/bin in %s and no --pg-bin or SIPGES_PG_BIN", versionDir),
		}
	}
	if web := filepath.Join(versionDir, "web"); isDir(web) {
		b.web = web
	}
	return b, nil
}

// serverEnv is the environment of a managed API: secrets from the state folder, loopback only,
// plain-HTTP cookies, data under the state folder, the version's own web app and migrations, and
// the update channel only for the running server (never for a migration boot).
func serverEnv(base []string, bins versionBins, stateDir string, sec secrets, databaseURL string, port int, channel string) ([]string, error) {
	owned := [][2]string{
		{"SIPGES_DATABASE_URL", databaseURL},
		{"SIPGES_DATA_KEY", sec.dataKey},
		{"SIPGES_ADMIN_PASSWORD", sec.adminPassword},
		{"SIPGES_HOST", "127.0.0.1"},
		{"SIPGES_PORT", strconv.Itoa(port)},
		{"SIPGES_COOKIE_SECURE", "0"},
		{"SIPGES_UPLOAD_DIR", filepath.Join(stateDir, "uploads")},
		{"SIPGES_MIGRATIONS_DIR", bins.migrations},
		// Only these names reach the API: a page on another name that resolves to 127.0.0.1 gets 400.
		{"SIPGES_ALLOWED_HOSTS", "localhost,127.0.0.1"},
	}
	if bins.web != "" {
		owned = append(owned, [2]string{"SIPGES_WEB_DIR", bins.web})
	}
	if channel != "" {
		owned = append(owned, [2]string{envUpdateChannel, channel})
	}
	return launcherEnv(base, owned)
}

// runtimeEnv is what every server and boot child inherits from the launcher.
type runtimeEnv struct {
	base   []string
	pgBin  string
	stdout io.Writer
	stderr io.Writer
}

// startCluster starts PostgreSQL 18 on <state>/pg18 and converges its roles and database.
func startCluster(ctx context.Context, binDir, stateDir string, sec secrets) (*localpg.Server, error) {
	pg, err := localpg.Start(ctx, localpg.Options{
		BinDir:        binDir,
		DataDir:       filepath.Join(stateDir, dataFolder),
		LogPath:       filepath.Join(stateDir, dataFolder+".log"),
		SuperPassword: sec.pgSuper,
		Setup: func(ctx context.Context, staging *localpg.Server) error {
			return provision(ctx, staging.SuperUserURL("postgres"), sec.pgApp)
		},
	})
	if err != nil {
		return nil, err
	}
	if err := provision(ctx, pg.SuperUserURL("postgres"), sec.pgApp); err != nil {
		return nil, errors.Join(&userError{msg: "No se pudo preparar la base de datos local. Revise el registro de SIPGES.", err: err}, stopCluster(ctx, pg))
	}
	return pg, nil
}

// stopCluster stops PostgreSQL even when ctx already ended.
func stopCluster(ctx context.Context, pg *localpg.Server) error {
	stopCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), stopTimeout)
	defer cancel()
	return pg.Stop(stopCtx)
}

// stack is a running managed server: PostgreSQL 18 and the API.
type stack struct {
	cmd     *exec.Cmd
	cancel  context.CancelFunc
	exited  chan struct{}
	code    int
	stopErr error
}

func (s *stack) Exited() <-chan struct{} { return s.exited }
func (s *stack) Code() int               { return s.code }

// Stop asks the API to stop (it is killed after apiStopGrace), then PostgreSQL stops.
func (s *stack) Stop(context.Context) error {
	s.cancel()
	<-s.exited
	return s.stopErr
}

func (s *stack) Kill() { _ = s.cmd.Process.Kill() }

// startStack serves one version: PostgreSQL on the state folder, its migrations, then its API.
// A stop during the start (ctx) ends what already started.
func startStack(ctx context.Context, rt runtimeEnv, spec serverSpec) (server, error) {
	bins, err := resolveBins(spec.Current.Dir, rt.pgBin)
	if err != nil {
		return nil, err
	}
	sec, err := readSecrets(spec.StateDir)
	if err != nil {
		return nil, err
	}
	pg, err := startCluster(ctx, bins.pgBin, spec.StateDir, sec)
	if err != nil {
		return nil, err
	}
	env, err := serverEnv(rt.base, bins, spec.StateDir, sec, pg.URL(appRole, sec.pgApp, appDatabase), spec.Port, spec.Channel)
	if err == nil {
		err = migrateAPI(ctx, bins.api, env, rt.stdout, rt.stderr)
	}
	if err != nil {
		return nil, errors.Join(err, stopCluster(ctx, pg))
	}
	apiCtx, cancel := context.WithCancel(context.WithoutCancel(ctx))
	cmd := child(apiCtx, bins.api, nil, env, rt.stdout, rt.stderr)
	if err := cmd.Start(); err != nil {
		cancel()
		return nil, errors.Join(fmt.Errorf("start the API: %w", err), stopCluster(ctx, pg))
	}
	s := &stack{cmd: cmd, cancel: cancel, exited: make(chan struct{})}
	go func() {
		s.code = exitCode(cmd.Wait())
		if err := stopCluster(ctx, pg); err != nil {
			s.stopErr = err
			if s.code == 0 {
				s.code = 1
			}
		}
		cancel()
		close(s.exited)
	}()
	return s, nil
}

// exitCode is a child's exit code, 1 when it was killed or never ran.
func exitCode(err error) int {
	if err == nil {
		return 0
	}
	var exit *exec.ExitError
	if errors.As(err, &exit) && exit.ExitCode() > 0 {
		return exit.ExitCode()
	}
	return 1
}

var errStopped = errors.New("SIPGES was stopped")

var errPortTaken = errors.New("port taken")

// bootCheck is the migration and readiness hook of desktopupdate (boot.mjs bootCheck): it starts
// PostgreSQL on the target state folder, applies the version's migrations, boots its API on a
// free loopback port, waits for /health/ready (and the web app when the version has one), then
// stops both. Output goes to logFile. ctx ending stops a running boot before it returns.
func bootCheck(rt runtimeEnv, logFile string) desktopupdate.Hook {
	return func(ctx context.Context, target desktopupdate.Target) error {
		port := 0
		for range bootPortAttempts {
			if ctx.Err() != nil {
				return errStopped
			}
			var err error
			if port, err = freeLoopbackPort(ctx); err != nil {
				return err
			}
			if err := bootOnce(ctx, rt, logFile, target, port); !errors.Is(err, errPortTaken) {
				return err
			}
		}
		return fmt.Errorf("the port %d was in use at each of %d attempts to start the new version; see %s", port, bootPortAttempts, logFile)
	}
}

func freeLoopbackPort(ctx context.Context) (int, error) {
	ln, err := (&net.ListenConfig{}).Listen(ctx, "tcp", "127.0.0.1:0")
	if err != nil {
		return 0, err
	}
	defer func() { _ = ln.Close() }()
	return ln.Addr().(*net.TCPAddr).Port, nil
}

// tailBuffer keeps what the boot's API printed, for the port-in-use check.
type tailBuffer struct {
	mu  sync.Mutex
	buf bytes.Buffer
}

func (b *tailBuffer) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.buf.Len() < 1<<20 {
		b.buf.Write(p)
	}
	return len(p), nil
}

func (b *tailBuffer) portInUse() bool {
	b.mu.Lock()
	defer b.mu.Unlock()
	text := b.buf.String()
	return strings.Contains(text, "address already in use") || strings.Contains(text, "Only one usage of each socket address")
}

func bootOnce(ctx context.Context, rt runtimeEnv, logFile string, target desktopupdate.Target, port int) (err error) {
	bins, err := resolveBins(target.VersionDir, rt.pgBin)
	if err != nil {
		return err
	}
	sec, err := readSecrets(target.StateDir)
	if err != nil {
		return err
	}
	logOut, err := os.OpenFile(logFile, os.O_WRONLY|os.O_CREATE|os.O_APPEND, 0o600) //nolint:gosec // the install root's boot log
	if err != nil {
		return err
	}
	defer func() { _ = logOut.Close() }()
	tail := &tailBuffer{}
	out := io.MultiWriter(logOut, tail)
	pg, err := startCluster(ctx, bins.pgBin, target.StateDir, sec)
	if err != nil {
		return stoppedOrErr(ctx, err)
	}
	defer func() { err = errors.Join(err, stopCluster(ctx, pg)) }()
	env, err := serverEnv(rt.base, bins, target.StateDir, sec, pg.URL(appRole, sec.pgApp, appDatabase), port, "")
	if err != nil {
		return err
	}
	if err := migrateAPI(ctx, bins.api, env, out, out); err != nil {
		return stoppedOrErr(ctx, err)
	}
	apiCtx, cancel := context.WithCancel(ctx)
	defer cancel()
	cmd := child(apiCtx, bins.api, nil, env, out, out)
	if err := cmd.Start(); err != nil {
		return fmt.Errorf("start the new version: %w", err)
	}
	waited := make(chan error, 1)
	go func() { waited <- cmd.Wait() }()
	exited := false
	// The boot's outcome is decided before the API is stopped; its exit only needs awaiting.
	stopAPI := func() error { cancel(); return <-waited }
	defer func() {
		if !exited {
			_ = stopAPI()
		}
	}()
	base := "http://127.0.0.1:" + strconv.Itoa(port)
	deadline := time.Now().Add(bootTimeout)
	for time.Now().Before(deadline) {
		if ctx.Err() != nil {
			return errStopped
		}
		select {
		case waitErr := <-waited:
			exited = true
			if tail.portInUse() {
				return errPortTaken
			}
			return fmt.Errorf("the new version stopped while starting (code %d); see %s", exitCode(waitErr), logFile)
		default:
		}
		if httpStatus(ctx, base+"/health/ready", "") == http.StatusOK {
			if bins.web != "" && httpStatus(ctx, base+"/", "text/html") != http.StatusOK {
				return errors.New("the new version is ready but does not serve the web app")
			}
			return nil
		}
		select {
		case <-ctx.Done():
		case <-time.After(500 * time.Millisecond):
		}
	}
	return fmt.Errorf("the new version was not ready within %d s; see %s", int(bootTimeout.Seconds()), logFile)
}

func stoppedOrErr(ctx context.Context, err error) error {
	if ctx.Err() != nil {
		return errors.Join(errStopped, err)
	}
	return err
}

// httpStatus is the status of a GET, 0 when there is no answer.
func httpStatus(ctx context.Context, url, accept string) int {
	ctx, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return 0
	}
	if accept != "" {
		req.Header.Set("Accept", accept)
	}
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		return 0
	}
	_, _ = io.Copy(io.Discard, res.Body)
	_ = res.Body.Close()
	return res.StatusCode
}

// clusterRunning asks pg_ctl status whether a server runs on dataDir: 0 is running, 3 not
// running, 4 no readable data folder.
func clusterRunning(ctx context.Context, binDir, dataDir string) (bool, error) {
	cmd := exec.CommandContext(ctx, filepath.Join(binDir, program("pg_ctl")), "status", "-D", dataDir) //nolint:gosec // G204: the bundled pg_ctl, fixed arguments
	err := cmd.Run()
	var exit *exec.ExitError
	switch {
	case err == nil:
		return true, nil
	case errors.As(err, &exit) && (exit.ExitCode() == 3 || exit.ExitCode() == 4):
		return false, nil
	default:
		return false, fmt.Errorf("pg_ctl status -D %s: %w", dataDir, err)
	}
}

// stopOrphanClusters stops every PostgreSQL left running on one of the folders, typically by a
// launcher that was killed, with localpg.StopLeftover: pg_ctl stop -m fast on that data folder,
// then a kill when that fails, and never a start, so a copy of the state folder is never served.
// A postmaster.pid that no PostgreSQL serves (a crashed server, or a process id the system gave
// to another program) leaves the folder free. It fails without touching anything else when a
// server cannot be stopped.
func stopOrphanClusters(rt runtimeEnv, root string) func(context.Context, []string) error {
	return func(ctx context.Context, folders []string) error {
		binDir := ""
		for _, dir := range folders {
			dataDir := filepath.Join(dir, dataFolder)
			if _, serving := localpg.Serving(ctx, dataDir); !serving {
				continue
			}
			if binDir == "" {
				current, err := desktopupdate.ReadCurrent(root)
				if err == nil && current == nil {
					err = errors.New("no installed version here")
				}
				if err != nil {
					return fmt.Errorf("find PostgreSQL to stop the server on %s: %w", dataDir, err)
				}
				bins, err := resolveBins(current.Dir, rt.pgBin)
				if err != nil {
					return fmt.Errorf("find PostgreSQL to stop the server on %s: %w", dataDir, err)
				}
				binDir = bins.pgBin
			}
			stopped, err := localpg.StopLeftover(ctx, localpg.Options{
				BinDir: binDir, DataDir: dataDir, LogPath: filepath.Join(dir, dataFolder+".log"),
			})
			if err != nil {
				return fmt.Errorf("stop the PostgreSQL left running on %s: %w", dataDir, err)
			}
			if stopped {
				_, _ = fmt.Fprintf(rt.stderr, "sipges-desktop: stopped the PostgreSQL left running on %s\n", dataDir)
			}
		}
		return nil
	}
}

// prepareOnly makes an empty PostgreSQL 18 cluster in the state folder ready for the one-time
// PGlite migrator: roles, database and migrations, then PostgreSQL stops. A pg18 folder that
// already holds anything is refused.
func prepareOnly(ctx context.Context, stateDir string, bins versionBins, base []string, stdout, stderr io.Writer) (err error) {
	dataDir := filepath.Join(stateDir, dataFolder)
	if entries, readErr := os.ReadDir(dataDir); readErr == nil && len(entries) > 0 {
		return &userError{
			msg: "La carpeta de datos ya tiene una base de datos PostgreSQL 18: no se preparó nada.",
			err: fmt.Errorf("%s already holds data", dataDir),
		}
	} else if readErr != nil && !errors.Is(readErr, os.ErrNotExist) {
		return readErr
	}
	sec, err := readSecrets(stateDir)
	if err != nil {
		return err
	}
	pg, err := startCluster(ctx, bins.pgBin, stateDir, sec)
	if err != nil {
		return removeHalfMade(ctx, bins.pgBin, dataDir, err)
	}
	env, err := serverEnv(base, bins, stateDir, sec, pg.URL(appRole, sec.pgApp, appDatabase), 8000, "")
	if err == nil {
		err = migrateAPI(ctx, bins.api, env, stdout, stderr)
	}
	if err = errors.Join(err, stopCluster(ctx, pg)); err != nil {
		return removeHalfMade(ctx, bins.pgBin, dataDir, err)
	}
	_, _ = fmt.Fprintf(stdout, "sipges-desktop: PostgreSQL 18 prepared in %s\n", dataDir)
	return nil
}

// removeHalfMade removes the pg18 folder a failed --prepare-only built (it held nothing before),
// so the next attempt is not refused; when PostgreSQL may still run on it, it says what to do.
func removeHalfMade(ctx context.Context, binDir, dataDir string, cause error) error {
	running, err := clusterRunning(context.WithoutCancel(ctx), binDir, dataDir)
	if err == nil && !running {
		err = os.RemoveAll(dataDir)
	} else if err == nil {
		err = errors.New("PostgreSQL still runs on it")
	}
	if err != nil {
		return &userError{
			msg: "No se pudo preparar la base de datos local. Detenga PostgreSQL y borre la carpeta " + dataDir + " antes de volver a intentarlo. Detalle: " + cause.Error(),
			err: errors.Join(cause, fmt.Errorf("remove the half-made %s: %w", dataDir, err)),
		}
	}
	return &userError{
		msg: "No se pudo preparar la base de datos local; se borró la carpeta pg18 a medio preparar. Detalle: " + cause.Error(),
		err: cause,
	}
}

// launcherOptions are the parsed --install options.
type launcherOptions struct {
	install     string
	releases    string
	pgBin       string
	port        int
	prepareOnly bool
	help        bool
	// The install form (update.mjs --install <root> --release <dir>): a first install.
	release      string
	state        string
	trustKey     string
	trustRelease bool
}

var errInvalidOptions = errors.New("Invalid options; use --help") //nolint:staticcheck // ST1005: launcher.mjs's message

// parseLauncherArgs follows launcher.mjs main: valued options once each, never a value that starts
// with --, and --help alone.
func parseLauncherArgs(args []string, lookup func(string) (string, bool)) (launcherOptions, error) {
	o := launcherOptions{port: 8000}
	if len(args) == 1 && args[0] == "--help" {
		return launcherOptions{help: true}, nil
	}
	seen := map[string]bool{}
	port := ""
	for rest := args; len(rest) > 0; {
		key, value, inline := rest[0], "", false
		rest = rest[1:]
		if k, v, ok := strings.Cut(key, "="); ok && strings.HasPrefix(k, "--") {
			key, value, inline = k, v, true
		}
		if key == "--prepare-only" && !inline && !o.prepareOnly {
			o.prepareOnly = true
			continue
		}
		if key == "--trust-release-key" && !inline && !o.trustRelease {
			o.trustRelease = true
			continue
		}
		targets := map[string]*string{
			"--install": &o.install, "--releases": &o.releases, "--port": &port, "--pg-bin": &o.pgBin,
			"--release": &o.release, "--state": &o.state, "--trust-key": &o.trustKey,
		}
		target, ok := targets[key]
		if !ok || seen[key] {
			return launcherOptions{}, errInvalidOptions
		}
		if !inline {
			if len(rest) == 0 {
				return launcherOptions{}, errInvalidOptions
			}
			value, rest = rest[0], rest[1:]
		}
		if value == "" || strings.HasPrefix(value, "--") {
			return launcherOptions{}, errInvalidOptions
		}
		seen[key] = true
		*target = value
	}
	if o.install == "" {
		return launcherOptions{}, errors.New("Missing --install") //nolint:staticcheck // ST1005: launcher.mjs's message
	}
	if err := checkInstallForm(o, seen); err != nil {
		return launcherOptions{}, err
	}
	if port != "" {
		n, err := strconv.Atoi(port)
		if err != nil || n < 1 || n > 65535 {
			return launcherOptions{}, errors.New("Invalid --port") //nolint:staticcheck // ST1005: launcher.mjs's message
		}
		o.port = n
	}
	if o.pgBin == "" {
		o.pgBin, _ = lookup("SIPGES_PG_BIN")
	}
	return o, nil
}

// runLauncherCLI is the managed launcher's command line; hold receives the launcher before it
// starts, so a second stop signal can kill its server. It returns the exit code.
func runLauncherCLI(ctx context.Context, args, environ []string, stdout, stderr io.Writer, hold func(*launcher)) int {
	o, err := parseLauncherArgs(args, lookupIn(environ))
	if err != nil {
		_, _ = fmt.Fprintln(stderr, "Error: "+err.Error())
		return 1
	}
	if o.help {
		_, _ = fmt.Fprintln(stdout, launcherUsage)
		return 0
	}
	root, err := filepath.Abs(o.install)
	if err != nil {
		_, _ = fmt.Fprintln(stderr, "Error: "+err.Error())
		return 1
	}
	if o.release != "" {
		return runInstall(ctx, root, o, stdout, stderr)
	}
	rt := runtimeEnv{base: environ, pgBin: o.pgBin, stdout: stdout, stderr: stderr}
	if o.prepareOnly {
		if err := prepareManaged(ctx, root, rt); err != nil {
			_, _ = fmt.Fprintln(stderr, "sipges-desktop:", err)
			_, _ = fmt.Fprintln(stderr, "SIPGES:", userMessage(err))
			return 1
		}
		return 0
	}
	source := ""
	if o.releases != "" {
		if source, err = filepath.Abs(o.releases); err != nil {
			_, _ = fmt.Fprintln(stderr, "Error: "+err.Error())
			return 1
		}
	}
	hook := bootCheck(rt, filepath.Join(root, "update-boot.log"))
	l := newLauncher(launchConfig{
		Root: root, Source: source, Port: o.port, Log: newEventLog(stdout),
		CheckTimeout: checkTimeout, Poll: pollEvery, Find: findUpdate,
		Migrate: hook, Ready: hook, Verifier: releaseVerifier{},
		Serve:       func(ctx context.Context, spec serverSpec) (server, error) { return startStack(ctx, rt, spec) },
		StopOrphans: stopOrphanClusters(rt, root),
	})
	if hold != nil {
		hold(l)
	}
	code, err := l.run(ctx)
	if err != nil {
		return reportStartError(err, stderr)
	}
	if notice := l.halted(); notice != "" {
		_, _ = fmt.Fprintln(stderr, notice)
	}
	return code
}

// reportStartError prints the notice of a start that never got as far as a server and returns
// the exit code: 3 when the state folder must not be used, 1 otherwise.
func reportStartError(err error, stderr io.Writer) int {
	var orphan *orphanError
	if errors.As(err, &orphan) {
		_, _ = fmt.Fprintln(stderr, orphanNotice)
		_, _ = fmt.Fprintln(stderr, "Detalle: "+err.Error())
		return exitRollbackIncomplete
	}
	if errors.Is(err, errLauncherRunning) {
		_, _ = fmt.Fprintln(stderr, "SIPGES ya está en ejecución en este equipo: use la ventana abierta.")
		_, _ = fmt.Fprintln(stderr, "Error: "+err.Error())
		return 1
	}
	if ri, ok := rollbackIncomplete(err); ok {
		_, _ = fmt.Fprintln(stderr, haltNotice(ri.PreUpdateCopy))
		_, _ = fmt.Fprintln(stderr, "Detalle: "+ri.Message)
		return exitRollbackIncomplete
	}
	var first *firstStartError
	if errors.As(err, &first) {
		_, _ = fmt.Fprintln(stderr, firstStartNotice(first.err))
	}
	_, _ = fmt.Fprintln(stderr, "Error: "+err.Error())
	return 1
}

// prepareManaged runs --prepare-only on the install's state folder with its current version.
func prepareManaged(ctx context.Context, root string, rt runtimeEnv) error {
	current, err := desktopupdate.ReadCurrent(root)
	if err != nil {
		return err
	}
	if current == nil {
		return errors.New("no installed version here")
	}
	stateDir, err := desktopupdate.ReadStateDir(root)
	if err != nil {
		return err
	}
	bins, err := resolveBins(current.Dir, rt.pgBin)
	if err != nil {
		return err
	}
	return prepareOnly(ctx, stateDir, bins, rt.base, rt.stdout, rt.stderr)
}
