package cli

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
)

// Schema names the --json envelope. A change that breaks a consumer takes a new name.
const Schema = "sipgesctl/v1"

// Exit codes are part of the contract: scripts and agents branch on them.
const (
	ExitOK        = 0 // the command did what it was asked
	ExitFailed    = 1 // a verify check failed, or the API answered something unclassified
	ExitUsage     = 2 // the command line is wrong, or the route is not in the inventory
	ExitAuth      = 3 // 401: no valid session or credentials
	ExitForbidden = 4 // 403: signed in, but role, project or MFA refuses it
	ExitNotFound  = 5 // 404
	ExitRejected  = 6 // 400, 409, 413, 415, 422 or 429: the API refused the input or the pace
	ExitServer    = 7 // 5xx
	ExitNetwork   = 8 // the API could not be reached
	ExitLocal     = 9 // a local file (session, certificate, output) could not be used
)

// exitForStatus maps an HTTP status to an exit code.
func exitForStatus(status int) int {
	switch {
	case status >= 200 && status < 400:
		return ExitOK
	case status == http.StatusUnauthorized:
		return ExitAuth
	case status == http.StatusForbidden:
		return ExitForbidden
	case status == http.StatusNotFound:
		return ExitNotFound
	case status >= 500:
		return ExitServer
	case status >= 400:
		return ExitRejected
	}
	return ExitFailed
}

// envelope is everything --json prints: one object on stdout, for success and failure alike.
type envelope struct {
	Schema string    `json:"schema"`
	OK     bool      `json:"ok"`
	Status int       `json:"status,omitempty"`
	Route  string    `json:"route,omitempty"`
	Data   any       `json:"data,omitempty"`
	File   *fileInfo `json:"file,omitempty"`
	Error  *failure  `json:"error,omitempty"`
}

type failure struct {
	Code   string `json:"code"`
	Detail any    `json:"detail,omitempty"`
}

// fileInfo describes an answer that is not JSON: bytes never reach the terminal.
type fileInfo struct {
	ContentType string `json:"content_type"`
	Bytes       int64  `json:"bytes"`
	SHA256      string `json:"sha256,omitempty"`
	Path        string `json:"path,omitempty"`
	Stream      bool   `json:"stream,omitempty"`
}

// exitError is a failure with its exit code; code is the stable name in the envelope.
type exitError struct {
	exit   int
	code   string
	detail any
}

func (e *exitError) Error() string {
	if s, ok := e.detail.(string); ok {
		return s
	}
	return e.code
}

func usageError(format string, args ...any) error {
	return &exitError{exit: ExitUsage, code: "usage", detail: fmt.Sprintf(format, args...)}
}

func localError(format string, args ...any) error {
	return &exitError{exit: ExitLocal, code: "local", detail: fmt.Sprintf(format, args...)}
}

func networkError(err error) error {
	return &exitError{exit: ExitNetwork, code: "network", detail: err.Error()}
}

var statusCodes = map[int]string{
	ExitAuth: "unauthenticated", ExitForbidden: "forbidden", ExitNotFound: "not_found",
	ExitRejected: "rejected", ExitServer: "server_error", ExitFailed: "unexpected_status",
}

// write prints the result and returns its exit code.
func (a *app) write(asJSON bool, e envelope, exit int) int {
	if e.Data != nil {
		e.Data = redact(e.Data)
	}
	if e.Error != nil {
		e.Error.Detail = redact(e.Error.Detail)
	}
	e.Schema = Schema
	if asJSON {
		writeIndented(a.stdout, e)
		return exit
	}
	switch {
	case e.Error != nil:
		_, _ = fmt.Fprintf(a.stderr, "sipgesctl: %s: %s\n", e.Error.Code, detailText(e.Error.Detail))
	case e.File != nil:
		writeIndented(a.stdout, e.File)
	case e.Data != nil:
		writeIndented(a.stdout, e.Data)
	}
	return exit
}

// fail prints an error returned by a command and gives its exit code.
func (a *app) fail(asJSON bool, err error) int {
	var coded *exitError
	if !errors.As(err, &coded) {
		coded = &exitError{exit: ExitFailed, code: "failed", detail: err.Error()}
	}
	return a.write(asJSON, envelope{Error: &failure{Code: coded.code, Detail: coded.detail}}, coded.exit)
}

func writeIndented(w io.Writer, v any) {
	encoder := json.NewEncoder(w)
	encoder.SetEscapeHTML(false)
	encoder.SetIndent("", "  ")
	_ = encoder.Encode(v) // a value built from decoded JSON always encodes
}

func detailText(detail any) string {
	if s, ok := detail.(string); ok {
		return s
	}
	body, err := json.Marshal(detail)
	if err != nil {
		return "unreadable detail"
	}
	return string(body)
}

// redacted replaces every value that must never appear in output.
const redacted = "[redacted]"

// secretFields are answer fields that hold a credential. Output is what agents and logs keep, so
// the check is on the name, at any depth, and it runs on every command, the generic call included.
var secretFields = map[string]bool{
	"password": true, "password_hash": true, "secret": true, "totp_secret": true, "token": true,
	"session": true, "api_key": true, "apikey": true, "key": true, "otp": true, "otpauth": true,
	"otpauth_uri": true, "otpauth_url": true, "uri": true, "plaintext": true, "webhook_secret": true,
	"authorization": true, "cookie": true, "bot_token": true,
}

func redact(value any) any {
	switch typed := value.(type) {
	case map[string]any:
		clean := make(map[string]any, len(typed))
		for name, item := range typed {
			if secretFields[strings.ToLower(name)] && item != nil {
				clean[name] = redacted
				continue
			}
			clean[name] = redact(item)
		}
		return clean
	case []any:
		clean := make([]any, len(typed))
		for i, item := range typed {
			clean[i] = redact(item)
		}
		return clean
	}
	return value
}

// toJSONValue turns a value into plain decoded JSON, the shape redact walks.
func toJSONValue(v any) any {
	body, err := json.Marshal(v)
	if err != nil {
		return nil
	}
	var plain any
	if err := json.Unmarshal(body, &plain); err != nil {
		return nil
	}
	return plain
}
