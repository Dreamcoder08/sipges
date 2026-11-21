package cli

import (
	"bufio"
	"context"
	"encoding/json"
	"net/http"
	"strings"
)

const passwordPath = "/system/auth/password" //nolint:gosec // a route, not a credential

// loginNoStty is login's refusal on a terminal that cannot be silenced: it also reads a variable.
const loginNoStty = "cannot hide a typed password without a working stty: set SIPGES_PASSWORD"

// The refusals of password that the API never sees.
const (
	passwordMismatch = "las dos contraseñas nuevas no coinciden; no se cambió nada" //nolint:gosec // a message, not a credential
	// passwordNoStty replaces login's hint: password reads no variable, only stdin.
	passwordNoStty = "no se puede ocultar la contraseña sin un stty que funcione: envíe por stdin la actual, la nueva y la nueva otra vez, una por línea" //nolint:gosec // a message, not a credential
)

// password changes the signed-in person's own password. The current password, the new one and the
// new one again come from stdin, one per line, or from a terminal with echo off; never from a flag
// or the environment, so they cannot reach shell history or another process's view of the command
// line. A confirmation that differs stops the command before the API. The API keeps this session
// open and ends the others.
func (a *app) password(ctx context.Context, o *options, args []string) (int, error) {
	if err := o.parseNone(args); err != nil {
		return 0, err
	}
	current, next, err := a.passwords(ctx)
	if err != nil {
		return 0, err
	}
	body, err := json.Marshal(map[string]string{"current_password": current, "new_password": next})
	if err != nil {
		return 0, localError("build the request: %v", err)
	}
	c, path, err := o.connect()
	if err != nil {
		return 0, err
	}
	ctx, cancel := o.timeoutContext(ctx)
	defer cancel()
	answer, err := c.do(ctx, request{method: http.MethodPost, path: passwordPath, body: body, contentType: "application/json"})
	if err != nil {
		return 0, err
	}
	if err := c.persist(path); err != nil {
		return 0, err
	}
	return o.answer("POST "+passwordPath, answer), nil
}

// passwords reads the current password, the new one and the new one again, stopping at the first
// empty one; a confirmation that differs is refused before anything is sent.
func (a *app) passwords(ctx context.Context) (current, next string, err error) {
	lines := bufio.NewReader(a.stdin)
	readLine := func() string {
		line, _ := lines.ReadString('\n') // EOF still returns what was read
		return strings.TrimRight(line, "\r\n")
	}
	var answers [3]string
	for i, prompt := range []string{"Current password: ", "New password: ", "New password again: "} {
		if answers[i], err = a.typedPassword(ctx, prompt, passwordNoStty, readLine); err != nil {
			return "", "", err
		}
		if answers[i] == "" && i < 2 {
			return "", "", usageError("password needs the current password, the new one and the new one again on stdin, one per line")
		}
	}
	if answers[1] != answers[2] {
		return "", "", usageError("%s", passwordMismatch)
	}
	return answers[0], answers[1], nil
}
