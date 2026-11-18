// Command sipges-desktop runs SIPGES on one computer with the Go API (docs/adr/0036 §2–3): it
// starts the bundled PostgreSQL 18 from the state folder, creates the roles and database of the
// local install, applies the migrations with `api migrate`, then serves `api` on 127.0.0.1:8000
// until it receives SIGINT or SIGTERM, or the API exits, and always stops PostgreSQL after it.
//
// It reads the state folder of the desktop launcher (deploy/desktop): data-key, admin-password
// and uploads. The API is the cmd/api binary, run as a child process, so the composition root
// stays in one place.
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"os/signal"
	"path/filepath"
	"runtime"
	"strings"
	"sync/atomic"
	"syscall"
	"time"

	"github.com/Dreamcoder08/sipges/apps/api-go/internal/platform/localpg"
)

// envState names the state folder in the environment, as the desktop launcher does.
const envState = "SIPGES_DESKTOP_STATE"

// envUpdateChannel names the update channel folder, as the API reads it.
const envUpdateChannel = "SIPGES_DESKTOP_UPDATE_DIR"

// updateChannelFolder is the launcher's CHANNEL inside the install root.
const updateChannelFolder = "update-channel"

// dataFolder is the cluster's folder inside the state folder.
const dataFolder = "pg18"

// stopTimeout bounds the PostgreSQL stop that runs after the API ended.
const stopTimeout = 60 * time.Second

func main() {
	joinLauncherJob()
	if usesInstall(os.Args[1:]) {
		os.Exit(launcherMain(os.Args[1:]))
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	if err := run(ctx, os.Args[1:], os.Environ(), os.Stdout, os.Stderr); err != nil {
		fmt.Fprintln(os.Stderr, "sipges-desktop:", err) // English, for the log
		fmt.Fprintln(os.Stderr, "SIPGES:", userMessage(err))
		stop()
		os.Exit(1) //nolint:gocritic // stop already ran; nothing else is deferred
	}
}

// settings are the flags, falling back to the environment and then to the launcher's defaults.
type settings struct {
	state      string
	pgBin      string
	apiBin     string
	migrations string
	port       int
	// updateChannel is the folder the API shares with the launcher (SIPGES_DESKTOP_UPDATE_DIR);
	// empty outside a managed install, and then the API serves no update routes.
	updateChannel string
	// prepareOnly makes the empty cluster for the PGlite migrator and stops (--prepare-only).
	prepareOnly bool
}

func parseSettings(args []string, lookup func(string) (string, bool), exeDir string) (settings, error) {
	fs := flag.NewFlagSet("sipges-desktop", flag.ContinueOnError)
	fs.SetOutput(io.Discard)
	var s settings
	fs.StringVar(&s.state, "state", envOr(lookup, envState, defaultState(lookup)), "state folder (data-key, admin-password, uploads, pg18)")
	fs.StringVar(&s.pgBin, "pg-bin", envOr(lookup, "SIPGES_PG_BIN", ""), "folder with initdb, pg_ctl and postgres")
	fs.StringVar(&s.apiBin, "api", envOr(lookup, "SIPGES_API_BIN", filepath.Join(exeDir, program("api"))), "the Go API binary (cmd/api)")
	fs.StringVar(&s.migrations, "migrations", envOr(lookup, "SIPGES_MIGRATIONS_DIR", filepath.Join(exeDir, "migrations")), "folder with the SQL migrations")
	fs.IntVar(&s.port, "port", 8000, "port of the API on 127.0.0.1")
	fs.BoolVar(&s.prepareOnly, "prepare-only", false, "create and provision an empty PostgreSQL 18 cluster, then stop")
	fs.StringVar(&s.updateChannel, "update-channel", envOr(lookup, envUpdateChannel, managedChannel(exeDir)), "folder shared with the desktop launcher for the update notice")
	if err := fs.Parse(args); err != nil {
		return settings{}, &userError{msg: "Opciones de inicio inválidas.", err: err}
	}
	if fs.NArg() > 0 {
		return settings{}, &userError{msg: "Opciones de inicio inválidas.", err: fmt.Errorf("unexpected argument %q", fs.Arg(0))}
	}
	if s.pgBin == "" {
		return settings{}, &userError{
			msg: "No se indicó la carpeta de los ejecutables de PostgreSQL. Vuelva a instalar SIPGES.",
			err: errors.New("the PostgreSQL binaries folder is required: --pg-bin or SIPGES_PG_BIN"),
		}
	}
	if s.state == "" {
		return settings{}, &userError{msg: "No se encontró la carpeta de datos de SIPGES.", err: errors.New("no state folder: --state or " + envState)}
	}
	if s.port < 1 || s.port > 65535 {
		return settings{}, &userError{msg: "Opciones de inicio inválidas.", err: fmt.Errorf("port %d out of range", s.port)}
	}
	return s, nil
}

// managedChannel is <root>/update-channel when exeDir lies inside a managed install root (the one
// holding current.json and install.json, with this program in versions/<version>/go), the folder
// deploy/desktop/updater/launcher.mjs passes as SIPGES_DESKTOP_UPDATE_DIR; "" anywhere else.
func managedChannel(exeDir string) string {
	dir := exeDir
	for range 3 {
		dir = filepath.Dir(dir)
		if isFile(filepath.Join(dir, "current.json")) && isFile(filepath.Join(dir, "install.json")) {
			return filepath.Join(dir, updateChannelFolder)
		}
	}
	return ""
}

func isFile(path string) bool {
	info, err := os.Stat(path)
	return err == nil && info.Mode().IsRegular()
}

// defaultState is the launcher's state folder: %LOCALAPPDATA%\SIPGES or ~/.local/share/sipges-local.
func defaultState(lookup func(string) (string, bool)) string {
	if runtime.GOOS == "windows" {
		if dir, _ := lookup("LOCALAPPDATA"); dir != "" {
			return filepath.Join(dir, "SIPGES")
		}
		return ""
	}
	if home, _ := lookup("HOME"); home != "" {
		return filepath.Join(home, ".local", "share", "sipges-local")
	}
	return ""
}

func envOr(lookup func(string) (string, bool), key, fallback string) string {
	if v, _ := lookup(key); v != "" {
		return v
	}
	return fallback
}

// run is runDesktop, except that a stop requested while starting is not a failure: whatever
// started was stopped, and the reason only goes to the log. A PostgreSQL that did not stop is
// always a failure, requested stop or not: it may still be running.
func run(ctx context.Context, args, environ []string, stdout, stderr io.Writer) error {
	err := runDesktop(ctx, args, environ, stdout, stderr)
	if err != nil && ctx.Err() != nil && !errors.Is(err, localpg.ErrStop) {
		_, _ = fmt.Fprintln(stderr, "sipges-desktop: stopped while starting:", err)
		return nil
	}
	return err
}

func runDesktop(ctx context.Context, args, environ []string, stdout, stderr io.Writer) (err error) {
	exe, err := os.Executable()
	if err != nil {
		return err
	}
	s, err := parseSettings(args, lookupIn(environ), filepath.Dir(exe))
	if err != nil {
		return err
	}
	if s.prepareOnly {
		return prepareOnly(ctx, s.state, s.pgBin, stdout)
	}
	sec, err := readSecrets(s.state)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Join(s.state, "uploads"), 0o700); err != nil {
		return &userError{msg: "No se pudo crear la carpeta de archivos de SIPGES.", err: err}
	}
	if s.updateChannel != "" {
		// As the launcher does: the API only writes request.json into a folder that exists.
		if s.updateChannel, err = filepath.Abs(s.updateChannel); err != nil {
			return err
		}
		if err := os.MkdirAll(s.updateChannel, 0o700); err != nil {
			return &userError{msg: "No se pudo crear la carpeta de actualizaciones de SIPGES.", err: err}
		}
	}
	server, err := localpg.Start(ctx, localpg.Options{
		BinDir:        s.pgBin,
		DataDir:       filepath.Join(s.state, dataFolder),
		LogPath:       filepath.Join(s.state, dataFolder+".log"),
		SuperPassword: sec.pgSuper,
		// A new cluster reaches pg18 only with its roles and database made.
		Setup: func(ctx context.Context, staging *localpg.Server) error {
			return provision(ctx, staging.SuperUserURL("postgres"), sec.pgApp)
		},
	})
	if err != nil {
		return err
	}
	_, _ = fmt.Fprintf(stdout, "sipges-desktop: PostgreSQL started on 127.0.0.1:%d\n", server.Port())
	defer func() {
		stopCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), stopTimeout)
		defer cancel()
		if stopErr := server.Stop(stopCtx); stopErr != nil {
			err = errors.Join(err, stopErr)
			return
		}
		_, _ = fmt.Fprintln(stdout, "sipges-desktop: PostgreSQL stopped")
	}()
	// Again on every start: it converges the roles and sets the API login's password.
	if err := provision(ctx, server.SuperUserURL("postgres"), sec.pgApp); err != nil {
		return &userError{msg: "No se pudo preparar la base de datos local. Revise el registro de SIPGES.", err: err}
	}
	env := apiEnv(environ, s, sec, server.URL(appRole, sec.pgApp, appDatabase))
	if err := migrateAPI(ctx, s.apiBin, env, stdout, stderr); err != nil {
		return &userError{msg: "No se pudo actualizar la base de datos local. Revise el registro de SIPGES.", err: err}
	}
	return serveAPI(ctx, s.apiBin, env, stdout, stderr)
}

// launcherMain runs the managed launcher (--install) until it stops: the first SIGINT or SIGTERM
// stops SIPGES gracefully, a second one kills the server at once and exits with code 1.
func launcherMain(args []string) int {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	signals := make(chan os.Signal, 2)
	signal.Notify(signals, os.Interrupt, syscall.SIGTERM)
	var held atomic.Pointer[launcher]
	go func() {
		<-signals
		cancel()
		second := <-signals
		if l := held.Load(); l != nil {
			l.kill()
		}
		newEventLog(os.Stdout).event("stop_forced", field{"signal", signalName(second)})
		os.Exit(exitForced)
	}()
	return runLauncherCLI(ctx, args, os.Environ(), os.Stdout, os.Stderr, held.Store)
}

// signalName is the signal as Node names it in the stop_forced line.
func signalName(s os.Signal) string {
	if s == os.Interrupt {
		return "SIGINT"
	}
	return "SIGTERM"
}

func lookupIn(environ []string) func(string) (string, bool) {
	return func(key string) (string, bool) {
		for i := len(environ) - 1; i >= 0; i-- {
			if k, v, ok := strings.Cut(environ[i], "="); ok && sameKey(k, key) {
				return v, true
			}
		}
		return "", false
	}
}

// sameKey compares environment names as the platform does: Windows ignores case.
func sameKey(a, b string) bool {
	if runtime.GOOS == "windows" {
		return strings.EqualFold(a, b)
	}
	return a == b
}

func program(name string) string {
	if runtime.GOOS == "windows" {
		return name + ".exe"
	}
	return name
}

// userError carries the Spanish sentence for the screen next to the English cause for the log.
type userError struct {
	msg string
	err error
}

func (e *userError) Error() string { return e.err.Error() }
func (e *userError) Unwrap() error { return e.err }

// userMessage is the Spanish sentence for err. A PostgreSQL that did not stop comes first, before
// whatever ended the run: the person must know it may still be running.
func userMessage(err error) string {
	if errors.Is(err, localpg.ErrStop) {
		return localpg.UserMessage(err)
	}
	var ue *userError
	if errors.As(err, &ue) {
		return ue.msg
	}
	var pe *localpg.Error
	if errors.As(err, &pe) {
		return localpg.UserMessage(err)
	}
	return "SIPGES no pudo iniciar. Revise el registro de SIPGES."
}
