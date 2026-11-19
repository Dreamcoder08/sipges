package desktopsnapshot

import (
	"errors"
	"fmt"
	"io"
	"math"
	"os"
	"path/filepath"
	"time"
)

// SnapshotUsage is snapshot.mjs's usage, for sipges-desktop --snapshot.
const SnapshotUsage = `Usage: sipges-desktop --snapshot --url <base> --out <file.json>
       [--user admin] [--password-file <file>] [--otp <code> | --totp-secret-file <file> [--totp-state <file>]]

Signs in as an administrator and writes counts and keyed hashes of every project the account can
open: records per module (each field hashed; every list read to its end and checked against the
project export), links, uploads (content hashed with the same key), the audit trail and the
accounts. Prints counts and short hashes only. Without --password-file the password comes
from SIPGES_MIGRATION_PASSWORD or a prompt; without --otp the MFA code is asked for.
The file is the one deploy/desktop/migration/snapshot.mjs writes (format 4): either one's
snapshot compares with either one's --compare.`

// CompareUsage is compare.mjs's usage, for sipges-desktop --compare.
const CompareUsage = `Usage: sipges-desktop --compare --before <snapshot.json> --url <base>
       [--user admin] [--password-file <file>] [--otp <code> | --totp-secret-file <file> [--totp-state <file>]]
       [--probe-limit 25] [--out <after.json>]

Signs in (the same password and MFA as before the move) and first checks which server answers:
only the managed install of the new version mounts GET ` + DesktopUpdatePath + `. It prints
"Managed install: version <v>", or refuses with "RESULT: not compared (…)" and exit code 2 when
the server is another one (for example the old version, still running on the port) or does not
report its version. Then it takes the same snapshot with the salt of --before and prints, per project and module, the counts before and after and whether every field,
link, upload (SHA-256) and audit entry is unchanged; audit entries added since are listed by id,
module and action. Then probes that no record or upload of one project opens in another.
Every record list is read to its end and checked against the project export, every upload is
read by its id (the export names those past the 500 the list shows) and every audit entry with
its content (from the export); a part that cannot be read in full is printed as "not fully
checked" (or "not checked") and fails the comparison, as does a snapshot of an older format.
No request follows a redirect. Prints counts and short keyed hashes only. Exit code 0 when
nothing differs and everything was checked; 2 with "RESULT: not compared (…)" when the
comparison did not happen (not the managed install, a redirect, the server not reachable or the
connection dropped, any other error after the options were read); otherwise 1.
--before may be a snapshot of deploy/desktop/migration/snapshot.mjs or of sipges-desktop
--snapshot: the same file, the same rules, lines and exit codes as compare.mjs.`

// Env is how the commands see the process.
type Env struct {
	Lookup   func(string) (string, bool)
	Terminal *Terminal
	Stdout   io.Writer
	Stderr   io.Writer
	Now      func() time.Time
}

func (e Env) now() time.Time {
	if e.Now != nil {
		return e.Now()
	}
	return time.Now()
}

func (e Env) out(format string, a ...any) { _, _ = fmt.Fprintf(e.Stdout, format+"\n", a...) }

// writeNew is writeFile(path, text, { mode: 0o600, flag: 'wx' }): never over an existing file.
func writeNew(path, text string) error {
	f, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600) //nolint:gosec // the person names the file
	if err != nil {
		return err
	}
	if _, err := f.WriteString(text); err != nil {
		_ = f.Close()
		return err
	}
	return f.Close()
}

func snapshotText(snapshot *Object) string {
	text, _ := Stringify(snapshot, "  ")
	return text + "\n"
}

// RunSnapshot is snapshot.mjs's main; it returns the exit code.
func RunSnapshot(args []string, env Env) int {
	if err := runSnapshot(args, env); err != nil {
		_, _ = fmt.Fprintln(env.Stderr, "Error: "+err.Error())
		return 1
	}
	return 0
}

func runSnapshot(args []string, env Env) error {
	if len(args) == 1 && args[0] == "--help" {
		env.out("%s", SnapshotUsage)
		return nil
	}
	options, err := parseArgs(args, []string{"--url", "--out", "--user", "--password-file", "--otp", "--totp-secret-file", "--totp-state"})
	if err != nil {
		return err
	}
	if options["--url"] == "" || options["--out"] == "" {
		return errors.New("--url and --out are required")
	}
	login, err := credentials(options, env.Lookup, env.Terminal)
	if err != nil {
		return err
	}
	session, err := SignIn(login)
	if err != nil {
		return err
	}
	snapshot, _, err := TakeSnapshot(session, NewSalt(), env.now())
	if err != nil {
		return err
	}
	out, err := filepath.Abs(options["--out"])
	if err != nil {
		return err
	}
	if err := writeNew(out, snapshotText(snapshot)); err != nil {
		return err
	}
	lines, err := Summary(snapshot)
	if err != nil {
		return err
	}
	env.out("SIPGES snapshot at %s", snapshot.Get("takenAt"))
	for _, line := range lines {
		env.out("%s", line)
	}
	env.out("Written: %s", out)
	return nil
}

// RunCompare is compare.mjs's main; it returns the exit code.
func RunCompare(args []string, env Env) int {
	code, err := runCompare(args, env)
	if err != nil {
		_, _ = fmt.Fprintln(env.Stderr, "Error: "+err.Error())
		return 1
	}
	return code
}

func runCompare(args []string, env Env) (int, error) {
	if len(args) == 1 && args[0] == "--help" {
		env.out("%s", CompareUsage)
		return 0, nil
	}
	options, err := parseArgs(args, []string{"--before", "--url", "--user", "--password-file", "--otp", "--totp-secret-file", "--totp-state", "--probe-limit", "--out"})
	if err != nil {
		return 0, err
	}
	if options["--before"] == "" || options["--url"] == "" {
		return 0, errors.New("--before and --url are required")
	}
	text, err := readText(options["--before"])
	if err != nil {
		return 0, err
	}
	parsed, err := ParseJSON(text)
	if err != nil {
		return 0, fmt.Errorf("%s is not valid JSON", options["--before"])
	}
	if parsed == nil || parsed == Undefined {
		return 0, fmt.Errorf("%s holds null, not a snapshot", options["--before"])
	}
	before, _ := parsed.(*Object)
	salt, saltOK := fieldOf(parsed, "salt").(string)
	if !StrictEqual(fieldOf(parsed, "format"), Format) || !saltOK {
		return 0, fmt.Errorf("%s is not a snapshot made by snapshot.mjs", options["--before"])
	}
	if !StrictEqual(fieldOf(parsed, "version"), float64(FormatVersion)) || before == nil {
		return 0, fmt.Errorf("%s was made by an older snapshot.mjs; take it again with this one before the move", options["--before"])
	}
	limit := float64(DefaultProbes)
	if v, ok := options["--probe-limit"]; ok {
		limit = ToNumber(v)
	}
	if math.IsNaN(limit) || math.IsInf(limit, 0) || limit != math.Trunc(limit) || limit < 0 {
		return 0, errors.New("Invalid --probe-limit") //nolint:staticcheck // compare.mjs's message
	}
	login, err := credentials(options, env.Lookup, env.Terminal)
	if err != nil {
		return 0, err
	}
	code, err := compareWith(login, before, salt, int(math.Min(limit, math.MaxInt32)), options["--out"], env)
	if err != nil {
		_, _ = fmt.Fprintln(env.Stderr, "Error: "+err.Error())
		env.out("RESULT: not compared (%s)", notComparedReason(err))
		return NotComparedExit, nil
	}
	return code, nil
}

// notComparedReason is why a run that stopped compared nothing, for its RESULT line.
func notComparedReason(err error) string {
	var redirect *RedirectError
	if errors.As(err, &redirect) {
		return fmt.Sprintf("redirect: %s answered %d, not followed", redirect.Route, redirect.Status)
	}
	var network *NetworkError
	if errors.As(err, &network) {
		cause := ""
		if network.Cause != "" {
			cause = ", " + network.Cause
		}
		return "the server could not be reached or the connection dropped: " + network.Message + cause
	}
	return "error: " + err.Error()
}

// compareWith signs in, checks the server and compares; an error means nothing was compared.
func compareWith(login Login, before *Object, salt string, limit int, out string, env Env) (int, error) {
	session, err := SignIn(login)
	var refused *SignInError
	if errors.As(err, &refused) {
		env.out("%s", refused.Error())
		env.out("RESULT: sign-in failed")
		return 1, nil
	}
	if err != nil {
		return 0, err
	}
	how := "password"
	if session.WithCode {
		how = "password and MFA code"
	}
	env.out("Sign-in: ok (%s)", how)
	managed, err := ManagedInstall(session)
	if err != nil {
		return 0, err
	}
	if managed.Version == "" {
		var line, result string
		switch {
		case managed.Forbidden:
			line = "Managed install: not asked (GET " + DesktopUpdatePath + " answered 403: this account has no project scope or is not an administrator)"
			result = "no project scope for this account"
		case managed.Managed:
			line = "Managed install: version not readable (GET " + DesktopUpdatePath + " reports no installed version)"
			result = "installed version not readable"
		default:
			line = "Managed install: no (GET " + DesktopUpdatePath + " answered " + managed.Why + "); the server on this port is not the new version installed with install.ps1 -Release"
			result = "not the managed install"
		}
		env.out("%s", line)
		env.out("RESULT: not compared (%s)", result)
		return NotComparedExit, nil
	}
	env.out("Managed install: version %s", managed.Version)
	after, live, err := TakeSnapshot(session, salt, env.now())
	if err != nil {
		return 0, err
	}
	if out != "" {
		path, err := filepath.Abs(out)
		if err != nil {
			return 0, err
		}
		if err := writeNew(path, snapshotText(after)); err != nil {
			return 0, err
		}
	}
	result, err := CompareSnapshots(before, after, live)
	if err != nil {
		return 0, err
	}
	for _, line := range result.Lines {
		env.out("%s", line)
	}
	iso, err := ProbeIsolation(session, live, limit)
	if err != nil {
		return 0, err
	}
	leaked := iso.Records + iso.Uploads
	if leaked == 0 {
		env.out("Isolation: %d probes, no record or upload of one project visible in another", iso.Probes)
	} else {
		env.out("Isolation: %d probes, %d visible in another project (records %d, uploads %d)", iso.Probes, leaked, iso.Records, iso.Uploads)
	}
	differences := result.Differences
	if leaked > 0 {
		differences++
	}
	unchecked := ""
	if result.Incomplete > 0 {
		unchecked = fmt.Sprintf("not fully checked (%s, listed above)", plural(result.Incomplete, "part"))
	}
	switch {
	case differences == 0 && unchecked == "" && result.Added > 0:
		entry := "entries"
		if result.Added == 1 {
			entry = "entry"
		}
		env.out("RESULT: no difference (%d audit %s added, listed above)", result.Added, entry)
	case differences == 0 && unchecked == "":
		env.out("RESULT: no difference")
	case differences == 0:
		env.out("RESULT: %s", unchecked)
	case unchecked != "":
		env.out("RESULT: %s; %s", plural(differences, "difference"), unchecked)
	default:
		env.out("RESULT: %s", plural(differences, "difference"))
	}
	if differences == 0 && unchecked == "" {
		return 0, nil
	}
	return 1, nil
}
