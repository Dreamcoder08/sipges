// Package cli is sipgesctl: a client of the running SIPGES API. It speaks HTTP and nothing else,
// so sessions, MFA, roles, project scope and row-level security stay in the path of everything it
// does. It imports only the standard library, which a test holds: it cannot reach a table.
package cli

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"sort"
	"strings"
	"time"
)

const usage = `sipgesctl speaks to a running SIPGES API over HTTP. Run it as a person would use the app.
./sipges (deploy/local) runs the installation; sipgesctl signs in to it.

Session
  login                   sign in; password from SIPGES_PASSWORD or the first line of stdin
  logout                  end the session and remove the saved one
  session                 who is signed in, with which role and project
  mfa enroll              enrol TOTP; the secret goes to --secret-file only
  project list            the projects this account may use
  project switch ID       choose the project of this session

Any route
  routes                  the route inventory, with the command that reaches each route
  call METHOD PATH        any route of the inventory
    --query a=b  --param id=x  --body FILE|-  --form  --field a=b  --attach a=PATH  --output FILE

Typed commands (same flags, and one flag per path value)
%s
Common options, on every command
  --url URL               API address (SIPGES_URL)
  --ca-file FILE          certificate to trust (SIPGES_CA_FILE)
  --session-file FILE     saved session (SIPGES_SESSION_FILE)
  --project ID            project of this one command (SIPGES_PROJECT)
  --timeout DURATION      limit of each request (default 30s)
  --json                  one stable object on stdout

Exit codes
  0 done   1 failed   2 usage   3 not signed in   4 forbidden   5 not found
  6 input refused   7 server error   8 unreachable   9 local file
`

// IO is what a run reads and writes; main passes the process's own.
type IO struct {
	Stdin  io.Reader
	Stdout io.Writer
	Stderr io.Writer
	Env    func(string) string
}

type app struct {
	stdin  io.Reader
	stdout io.Writer
	stderr io.Writer
	env    func(string) string
	now    func() time.Time
	routes []Route
}

// command is one verb. It returns the exit code it printed, or an error for Run to print.
type command func(ctx context.Context, opts *options, args []string) (int, error)

// Run executes one command line and returns the exit code.
func Run(ctx context.Context, args []string, streams IO) int {
	routes, err := Routes()
	a := &app{
		stdin: streams.Stdin, stdout: streams.Stdout, stderr: streams.Stderr,
		env: streams.Env, now: time.Now, routes: routes,
	}
	if err != nil {
		return a.fail(wantsJSON(args), err)
	}
	if len(args) == 0 || args[0] == "help" || args[0] == "--help" || args[0] == "-h" {
		_, _ = io.WriteString(a.stdout, a.help())
		return ExitOK
	}
	name, run, rest := a.resolve(args)
	if run == nil {
		return a.fail(wantsJSON(args), usageError("unknown command %q: run sipgesctl help", strings.Join(args[:min(2, len(args))], " ")))
	}
	opts := a.newOptions(name)
	code, err := run(ctx, opts, rest)
	if err != nil {
		return a.fail(opts.json || wantsJSON(args), err)
	}
	return code
}

// help lists the typed commands from the inventory, so it cannot fall behind it.
func (a *app) help() string {
	var lines strings.Builder
	builtins := a.builtins()
	for _, route := range a.routes {
		if route.Command == "" {
			continue
		}
		if _, builtin := builtins[route.Command]; builtin && route.Command != "evidence upload" {
			continue
		}
		fmt.Fprintf(&lines, "  %-26s %s\n", route.Command, route.Summary)
	}
	return fmt.Sprintf(usage, lines.String())
}

// wantsJSON answers before flags are parsed, so even a usage error can honour --json.
func wantsJSON(args []string) bool {
	for _, arg := range args {
		if arg == "--json" || arg == "-json" {
			return true
		}
	}
	return false
}

func (a *app) builtins() map[string]command {
	return map[string]command{
		"login":           a.login,
		"logout":          a.logout,
		"session":         a.sessionState,
		"mfa enroll":      a.mfaEnroll,
		"project list":    a.projectList,
		"project switch":  a.projectSwitch,
		"routes":          a.listRoutes,
		"call":            a.call,
		"evidence upload": a.evidenceUpload,
	}
}

// resolve finds the command: its longest name wins, builtins first, then the typed routes.
func (a *app) resolve(args []string) (string, command, []string) {
	builtins := a.builtins()
	for _, length := range []int{2, 1} {
		if len(args) < length {
			continue
		}
		name := strings.Join(args[:length], " ")
		if run, ok := builtins[name]; ok {
			return name, run, args[length:]
		}
		for _, route := range a.routes {
			if route.Command == name {
				return name, a.typed(route), args[length:]
			}
		}
	}
	return "", nil, nil
}

// options are the common flags. The rest of a command's flags join the same set.
type options struct {
	flags       *flag.FlagSet
	url         string
	caFile      string
	sessionFile string
	project     string
	timeout     time.Duration
	json        bool
	app         *app
}

func (a *app) newOptions(name string) *options {
	opts := &options{flags: flag.NewFlagSet(name, flag.ContinueOnError), app: a}
	opts.flags.SetOutput(io.Discard)
	opts.flags.StringVar(&opts.url, "url", a.env("SIPGES_URL"), "API address")
	opts.flags.StringVar(&opts.caFile, "ca-file", a.env("SIPGES_CA_FILE"), "certificate to trust")
	opts.flags.StringVar(&opts.sessionFile, "session-file", a.env("SIPGES_SESSION_FILE"), "saved session")
	opts.flags.StringVar(&opts.project, "project", a.env("SIPGES_PROJECT"), "project of this command")
	opts.flags.DurationVar(&opts.timeout, "timeout", 30*time.Second, "limit of each request")
	opts.flags.BoolVar(&opts.json, "json", false, "one stable object on stdout")
	return opts
}

// parse reads flags before and after the positional arguments, which come back in order.
func (o *options) parse(args []string) ([]string, error) {
	var positional []string
	for {
		if err := o.flags.Parse(args); err != nil {
			if errors.Is(err, flag.ErrHelp) {
				return nil, usageError("%s: see sipgesctl help", o.flags.Name())
			}
			return nil, usageError("%v", err)
		}
		if o.flags.NArg() == 0 {
			return positional, nil
		}
		positional = append(positional, o.flags.Arg(0))
		args = o.flags.Args()[1:]
	}
}

func (o *options) sessionPath() (string, error) {
	if o.sessionFile != "" {
		return o.sessionFile, nil
	}
	return defaultSessionFile(o.app.env)
}

// connect builds a client, on the saved session unless there is none. With no --url the saved
// session says where to go.
func (o *options) connect() (*client, string, error) {
	path, err := o.sessionPath()
	if err != nil {
		return nil, "", err
	}
	saved, err := loadSession(path)
	if err != nil {
		return nil, "", err
	}
	address := o.url
	if address == "" && saved != nil {
		address = saved.URL
	}
	c, err := newClient(address, o.caFile, o.timeout, saved, o.project)
	return c, path, err
}

func (o *options) timeoutContext(ctx context.Context) (context.Context, context.CancelFunc) {
	return context.WithTimeout(ctx, o.timeout)
}

// answer prints one API response and returns the exit code it means.
func (o *options) answer(route string, r *response) int {
	exit := exitForStatus(r.status)
	result := envelope{OK: exit == ExitOK, Status: r.status, Route: route, Data: r.data, File: r.file}
	if exit != ExitOK {
		result.Data = nil
		result.Error = &failure{Code: statusCodes[exit], Detail: apiDetail(r)}
	}
	return o.app.write(o.json, result, exit)
}

// apiDetail is the API's own explanation.
func apiDetail(r *response) any {
	if body, ok := r.data.(map[string]any); ok {
		if projects, ok := body["projects"]; ok { // the API's "choose a project" answer
			return map[string]any{"detail": body["detail"], "projects": projects}
		}
		if detail, ok := body["detail"]; ok {
			return detail
		}
	}
	if r.data != nil {
		return r.data
	}
	return fmt.Sprintf("status %d", r.status)
}

// keyValues is a repeatable name=value flag.
type keyValues map[string][]string

func (k keyValues) String() string { return "" }

func (k keyValues) Set(value string) error {
	name, item, found := strings.Cut(value, "=")
	if !found || name == "" {
		return errors.New("expected name=value")
	}
	k[name] = append(k[name], item)
	return nil
}

// readBody loads a request body: "-" is stdin. A body never sits on the command line, because it
// may hold a credential and the command line is visible to every process.
func (a *app) readBody(path string) ([]byte, error) {
	if path == "-" {
		body, err := io.ReadAll(a.stdin)
		if err != nil {
			return nil, localError("read stdin: %v", err)
		}
		return body, nil
	}
	body, err := os.ReadFile(path) //nolint:gosec // the caller names their own file
	if err != nil {
		return nil, localError("read the body: %v", err)
	}
	return body, nil
}

func sortedNames(values map[string][]string) []string {
	names := make([]string, 0, len(values))
	for name := range values {
		names = append(names, name)
	}
	sort.Strings(names)
	return names
}
