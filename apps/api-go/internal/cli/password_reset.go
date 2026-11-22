package cli

import (
	"context"
	"fmt"
	"net/http"
	"net/url"
)

// resetPasswordInstruction tells the administrator what to do with the temporary password.
const resetPasswordInstruction = "Entregue esta contraseña temporal en persona y pida a la persona que la cambie de inmediato con «Cambiar contraseña»." //nolint:gosec // a message, not a credential

// resetPassword is users reset-password USERNAME: an administrator resets another person's
// forgotten password. The API draws the temporary password and answers it once; this prints it
// once, with what to do next, and keeps it nowhere.
func (a *app) resetPassword(ctx context.Context, o *options, args []string) (int, error) {
	positional, err := o.parse(args)
	if err != nil {
		return 0, err
	}
	if len(positional) != 1 || positional[0] == "" {
		return 0, usageError("usage: sipgesctl users reset-password USERNAME")
	}
	username := positional[0]
	c, path, err := o.connect()
	if err != nil {
		return 0, err
	}
	ctx, cancel := o.timeoutContext(ctx)
	defer cancel()
	target := "/system/auth/accounts/" + url.PathEscape(username) + "/password"
	const route = "POST /system/auth/accounts/{username}/password"
	answer, err := c.do(ctx, request{method: http.MethodPost, path: target})
	if err != nil {
		return 0, err
	}
	// The temporary password exists only in this answer: it is printed before the session is
	// saved, so a session file that cannot be written never loses it.
	persistErr := c.persist(path)
	if answer.status != http.StatusOK {
		if persistErr != nil {
			return 0, persistErr
		}
		return o.answer(route, answer), nil
	}
	fields, _ := answer.data.(map[string]any)
	temporary, _ := fields["temporary_password"].(string)
	if temporary == "" {
		return 0, &exitError{exit: ExitFailed, code: "bad_answer", detail: "the API sent no temporary password"}
	}
	exit, warning := ExitOK, ""
	if persistErr != nil {
		exit, warning = ExitLocal, "the password was reset, but the session could not be saved: "+persistErr.Error()
	}
	if o.json {
		view := map[string]any{"username": username, "temporary_password": temporary, "instruction": resetPasswordInstruction}
		if warning != "" {
			view["warning"] = warning
		}
		return a.write(true, envelope{OK: true, Status: answer.status, Route: route, Data: view}, exit), nil
	}
	_, _ = fmt.Fprintf(a.stdout, "Contraseña temporal de %s: %s\n%s\n", username, temporary, resetPasswordInstruction)
	if warning != "" {
		_, _ = fmt.Fprintf(a.stderr, "sipgesctl: %s\n", warning)
	}
	return exit, nil
}
