package cli

import (
	"bufio"
	"context"
	"encoding/json"
	"net/http"
	"strings"
)

const passwordPath = "/system/auth/password" //nolint:gosec // a route, not a credential

// password changes the signed-in person's own password. Both passwords come from stdin, one per
// line, or from a terminal with echo off; never from a flag or the environment, so they cannot
// reach shell history or another process's view of the command line. The API keeps this session
// open and ends the others.
func (a *app) password(ctx context.Context, o *options, args []string) (int, error) {
	if err := o.parseNone(args); err != nil {
		return 0, err
	}
	lines := bufio.NewReader(a.stdin)
	readLine := func() string {
		line, _ := lines.ReadString('\n') // EOF still returns what was read
		return strings.TrimRight(line, "\r\n")
	}
	current, err := a.typedPassword(ctx, "Current password: ", readLine)
	if err != nil {
		return 0, err
	}
	next := ""
	if current != "" {
		if next, err = a.typedPassword(ctx, "New password: ", readLine); err != nil {
			return 0, err
		}
	}
	if current == "" || next == "" {
		return 0, usageError("password needs the current and the new password on stdin, one per line")
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
