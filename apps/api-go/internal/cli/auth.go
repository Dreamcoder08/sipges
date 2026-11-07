package cli

import (
	"bufio"
	"context"
	"crypto/hmac"
	"crypto/sha1" //nolint:gosec // RFC 6238 TOTP is defined over HMAC-SHA-1, as the API checks it
	"encoding/base32"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"strings"
)

// badOTP is the API's answer to a wrong or reused code, byte for byte.
const badOTP = "Código de autenticación inválido"

const totpPeriod = 30

// totpCode is RFC 6238 with the API's settings: SHA-1, six digits, thirty seconds.
func totpCode(secret string, step int64) (string, error) {
	clean := strings.ToUpper(strings.TrimRight(strings.TrimSpace(secret), "="))
	key, err := base32.StdEncoding.WithPadding(base32.NoPadding).DecodeString(clean)
	if err != nil {
		return "", localError("the TOTP secret is not base32")
	}
	var counter [8]byte
	binary.BigEndian.PutUint64(counter[:], uint64(step)) //nolint:gosec // a time step is positive
	mac := hmac.New(sha1.New, key)
	mac.Write(counter[:])
	sum := mac.Sum(nil)
	at := sum[len(sum)-1] & 15
	value := binary.BigEndian.Uint32(sum[at:at+4]) & 0x7fffffff
	return fmt.Sprintf("%06d", value%1_000_000), nil
}

func (a *app) step() int64 { return a.now().Unix() / totpPeriod }

// credentials reads the password and code: environment first, then stdin, one per line. They have
// no flags on purpose: a command line is visible to every process on the machine.
func (a *app) credentials(secretFile string) (password, code, secret string, err error) {
	lines := bufio.NewReader(a.stdin)
	readLine := func() string {
		line, _ := lines.ReadString('\n') // EOF still returns what was read
		return strings.TrimRight(line, "\r\n")
	}
	if password = a.env("SIPGES_PASSWORD"); password == "" {
		password = readLine()
	}
	if password == "" {
		return "", "", "", usageError("no password: set SIPGES_PASSWORD or send it on stdin")
	}
	if secretFile != "" {
		body, err := readPrivate(secretFile)
		if err != nil {
			return "", "", "", err
		}
		return password, "", strings.TrimSpace(string(body)), nil
	}
	if code = a.env("SIPGES_TOTP"); code == "" {
		code = readLine()
	}
	return password, code, "", nil
}

// readPrivate refuses a credential file others can read.
func readPrivate(path string) ([]byte, error) {
	info, err := os.Stat(path)
	if err != nil {
		return nil, localError("read the secret file: %v", err)
	}
	if info.Mode().Perm()&0o077 != 0 {
		return nil, localError("%s can be read by others: chmod 600 it", path)
	}
	body, err := os.ReadFile(path) //nolint:gosec // the caller names their own file
	if err != nil {
		return nil, localError("read the secret file: %v", err)
	}
	return body, nil
}

func loginForm(username, password, code string) []byte {
	return []byte(url.Values{"username": {username}, "password": {password}, "otp": {code}}.Encode())
}

// login signs in and saves the session. With a secret file it tries the next step once as well:
// the API refuses a code twice, and right after enrolment this step's code is already spent.
func (a *app) login(ctx context.Context, o *options, args []string) (int, error) {
	username := o.flags.String("username", a.env("SIPGES_USERNAME"), "account")
	secretFile := o.flags.String("totp-secret-file", a.env("SIPGES_TOTP_SECRET_FILE"), "file with the TOTP secret")
	if _, err := o.parse(args); err != nil {
		return 0, err
	}
	if *username == "" {
		return 0, usageError("no account: pass --username or set SIPGES_USERNAME")
	}
	password, code, secret, err := a.credentials(*secretFile)
	if err != nil {
		return 0, err
	}
	path, err := o.sessionPath()
	if err != nil {
		return 0, err
	}
	address := o.url
	if address == "" {
		if saved, err := loadSession(path); err == nil && saved != nil {
			address = saved.URL
		}
	}
	c, err := newClient(address, o.caFile, o.timeout, nil, "")
	if err != nil {
		return 0, err
	}
	ctx, cancel := o.timeoutContext(ctx)
	defer cancel()
	attempt := func(otp string) (*response, error) {
		return c.do(ctx, request{
			method: http.MethodPost, path: "/login", body: loginForm(*username, password, otp),
			contentType: "application/x-www-form-urlencoded",
		})
	}
	if secret != "" {
		if code, err = totpCode(secret, a.step()); err != nil {
			return 0, err
		}
	}
	answer, err := attempt(code)
	if err != nil {
		return 0, err
	}
	if secret != "" && answer.status == http.StatusUnauthorized && apiDetail(answer) == badOTP {
		if code, err = totpCode(secret, a.step()+1); err != nil {
			return 0, err
		}
		if answer, err = attempt(code); err != nil {
			return 0, err
		}
	}
	if answer.status != http.StatusOK {
		return o.answer("POST /login", answer), nil
	}
	c.session.Username = *username
	if err := saveSession(path, c.session); err != nil {
		return 0, err
	}
	return o.answer("POST /login", answer), nil
}

func (a *app) logout(ctx context.Context, o *options, args []string) (int, error) {
	if _, err := o.parse(args); err != nil {
		return 0, err
	}
	c, path, err := o.connect()
	if err != nil {
		return 0, err
	}
	ctx, cancel := o.timeoutContext(ctx)
	defer cancel()
	answer, err := c.do(ctx, request{method: http.MethodPost, path: "/logout"})
	if err != nil {
		return 0, err
	}
	// The local copy goes whatever the API said: nothing should keep using it.
	if err := removeSession(path); err != nil {
		return 0, err
	}
	return o.answer("POST /logout", answer), nil
}

type sessionView struct {
	SignedIn      bool   `json:"signed_in"`
	URL           string `json:"url"`
	Username      string `json:"username,omitempty"`
	FullName      string `json:"full_name,omitempty"`
	Role          string `json:"role,omitempty"`
	Project       any    `json:"project,omitempty"`
	MFARequired   bool   `json:"mfa_required,omitempty"`
	ChooseProject any    `json:"choose_project,omitempty"`
}

// sessionState asks the API, not the saved file: only the API knows a session is still alive.
func (a *app) sessionState(ctx context.Context, o *options, args []string) (int, error) {
	if _, err := o.parse(args); err != nil {
		return 0, err
	}
	c, sessionFile, err := o.connect()
	if err != nil {
		return 0, err
	}
	ctx, cancel := o.timeoutContext(ctx)
	defer cancel()
	me, err := c.do(ctx, request{method: http.MethodGet, path: "/system/auth/me"})
	if err != nil {
		return 0, err
	}
	view := sessionView{URL: c.base.String()}
	identity, signedIn := me.data.(map[string]any)
	if me.status != http.StatusOK {
		return o.answer("GET /system/auth/me", me), nil
	}
	if !signedIn {
		exit := a.write(o.json, envelope{OK: false, Status: me.status, Data: toJSONValue(view),
			Error: &failure{Code: "unauthenticated", Detail: "not signed in"}}, ExitAuth)
		return exit, nil
	}
	view.SignedIn = true
	view.Username, _ = identity["username"].(string)
	view.FullName, _ = identity["full_name"].(string)
	view.Role, _ = identity["role"].(string)
	scope, err := c.do(ctx, request{method: http.MethodGet, path: "/system/auth/current-scope"})
	if err != nil {
		return 0, err
	}
	switch body, _ := scope.data.(map[string]any); {
	case scope.status == http.StatusOK:
		view.Project = scope.data
	case body["projects"] != nil:
		view.ChooseProject = body["projects"]
	case strings.Contains(fmt.Sprint(body["detail"]), "MFA"):
		view.MFARequired = true
	}
	if err := c.persist(sessionFile); err != nil {
		return 0, err
	}
	return a.write(o.json, envelope{OK: true, Status: me.status, Data: toJSONValue(view)}, ExitOK), nil
}

// mfaEnroll enrols the session's account. The secret is the one thing that must outlive this
// command, so it goes to a new private file; it never reaches stdout.
func (a *app) mfaEnroll(ctx context.Context, o *options, args []string) (int, error) {
	secretFile := o.flags.String("secret-file", "", "new file for the TOTP secret")
	if _, err := o.parse(args); err != nil {
		return 0, err
	}
	if *secretFile == "" {
		return 0, usageError("mfa enroll needs --secret-file: the secret is never printed")
	}
	if _, err := os.Lstat(*secretFile); err == nil {
		return 0, localError("%s already exists", *secretFile)
	}
	c, path, err := o.connect()
	if err != nil {
		return 0, err
	}
	ctx, cancel := o.timeoutContext(ctx)
	defer cancel()
	setup, err := c.do(ctx, request{method: http.MethodPost, path: "/system/auth/totp/setup"})
	if err != nil {
		return 0, err
	}
	if setup.status != http.StatusOK {
		return o.answer("POST /system/auth/totp/setup", setup), nil
	}
	body, _ := setup.data.(map[string]any)
	secret, _ := body["secret"].(string)
	if secret == "" {
		return 0, &exitError{exit: ExitFailed, code: "bad_answer", detail: "the API sent no TOTP secret"}
	}
	code, err := totpCode(secret, a.step())
	if err != nil {
		return 0, err
	}
	if err := writePrivate(*secretFile, secret); err != nil {
		return 0, err
	}
	confirm, _ := json.Marshal(map[string]string{"code": code}) //nolint:errchkjson // plain strings
	enabled, err := c.do(ctx, request{
		method: http.MethodPost, path: "/system/auth/totp/enable", body: confirm, contentType: "application/json",
	})
	if err != nil {
		return 0, err
	}
	if enabled.status != http.StatusOK {
		_ = os.Remove(*secretFile)
		return o.answer("POST /system/auth/totp/enable", enabled), nil
	}
	if err := c.persist(path); err != nil {
		return 0, err
	}
	view := map[string]any{"totp_enabled": true, "secret_file": *secretFile}
	return a.write(o.json, envelope{OK: true, Status: enabled.status, Data: view}, ExitOK), nil
}

func writePrivate(path, content string) error {
	file, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600) //nolint:gosec // the caller's file
	if err != nil {
		return localError("write the secret file: %v", err)
	}
	if _, err := io.WriteString(file, content+"\n"); err != nil {
		_ = file.Close()
		_ = os.Remove(path)
		return localError("write the secret file: %v", err)
	}
	if err := file.Close(); err != nil {
		return localError("write the secret file: %v", err)
	}
	return nil
}

func (a *app) projectList(ctx context.Context, o *options, args []string) (int, error) {
	if _, err := o.parse(args); err != nil {
		return 0, err
	}
	return o.send(ctx, Route{Method: http.MethodGet, Path: "/system/auth/scopes"}, "/system/auth/scopes", o.emptyFlags())
}

// projectSwitch saves the choice in the session, the way the browser's project picker does, then
// reads it back from the API: an answer of 303 alone does not prove the project is active.
func (a *app) projectSwitch(ctx context.Context, o *options, args []string) (int, error) {
	positional, err := o.parse(args)
	if err != nil {
		return 0, err
	}
	if len(positional) != 1 {
		return 0, usageError("usage: sipgesctl project switch COMPANY/PROJECT")
	}
	o.project = ""
	c, path, err := o.connect()
	if err != nil {
		return 0, err
	}
	ctx, cancel := o.timeoutContext(ctx)
	defer cancel()
	chosen, err := c.do(ctx, request{
		method: http.MethodPost, path: "/select-project",
		body: []byte(url.Values{"scope": {positional[0]}}.Encode()), contentType: "application/x-www-form-urlencoded",
	})
	if err != nil {
		return 0, err
	}
	if chosen.status >= 400 {
		return o.answer("POST /select-project", chosen), nil
	}
	if err := c.persist(path); err != nil {
		return 0, err
	}
	current, err := c.do(ctx, request{method: http.MethodGet, path: "/system/auth/current-scope"})
	if err != nil {
		return 0, err
	}
	return o.answer("GET /system/auth/current-scope", current), nil
}
