package cli

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"strings"
)

// check is one line of the verdict.
type check struct {
	Area   string `json:"area"`
	Name   string `json:"name"`
	OK     bool   `json:"ok"`
	Detail string `json:"detail,omitempty"`
}

type verdict struct {
	Run    string  `json:"run"`
	Passed int     `json:"passed"`
	Failed int     `json:"failed"`
	Checks []check `json:"checks"`
}

// actor is one signed-in person, in memory only: verify never touches the saved session.
type actor struct {
	label    string
	username string
	password string
	secret   string
	code     string
	client   *client
}

type verifier struct {
	ctx      context.Context
	app      *app
	options  *options
	base     string
	stream   bool
	run      string
	area     string
	result   verdict
	admin    *actor
	analyst  *actor
	viewer   *actor
	outsider *actor
	// created lists the accounts to deactivate at the end.
	created            []string
	projectA, projectB string
	record             string
	alert              string
	action             string
	upload             string
	uploadBytes        []byte
	marker             string
}

// errStop ends a part of the journey whose failure leaves the next steps nothing to stand on.
var errStop = errors.New("stopped")

// verifyCommand runs the whole journey against a running API and prints one line per check. It
// works from the saved session of an administrator, so it needs no credential of its own. It
// writes synthetic accounts, projects and records through the API, so it refuses any address but
// this machine's and asks to be told the target is synthetic. Exit 0 only if every check passed.
func (a *app) verifyCommand(ctx context.Context, o *options, args []string) (int, error) {
	synthetic := o.flags.Bool("synthetic-target", false, "confirm the target holds synthetic data only")
	if _, err := o.parse(args); err != nil {
		return 0, err
	}
	if !*synthetic {
		return 0, usageError("verify writes accounts, projects and records: pass --synthetic-target on a synthetic install")
	}
	o.project = ""
	c, _, err := o.connect()
	if err != nil {
		return 0, err
	}
	if !isLoopback(c.base.Hostname()) {
		return 0, usageError("verify only runs against this machine: --url must be a loopback address")
	}
	if len(c.session.Cookies) == 0 {
		return 0, &exitError{exit: ExitAuth, code: "unauthenticated", detail: "verify runs as an administrator: sign in with sipgesctl login first"}
	}
	v := &verifier{ctx: ctx, app: a, options: o, base: c.base.String(), stream: !o.json, run: randomHex(4)}
	v.result.Run = v.run
	v.admin = &actor{label: "admin", username: c.session.Username, client: c}
	v.journey()
	exit := ExitOK
	if v.result.Failed > 0 {
		exit = ExitFailed
	}
	if o.json {
		body := envelope{OK: exit == ExitOK, Data: toJSONValue(v.result)}
		if exit != ExitOK {
			body.Error = &failure{Code: "verify_failed", Detail: fmt.Sprintf("%d checks failed", v.result.Failed)}
		}
		return a.write(true, body, exit), nil
	}
	_, _ = fmt.Fprintf(a.stdout, "\n%d passed, %d failed\n", v.result.Passed, v.result.Failed)
	return exit, nil
}

func randomHex(size int) string {
	raw := make([]byte, size)
	_, _ = rand.Read(raw) // crypto/rand.Read never fails (Go 1.24+)
	return hex.EncodeToString(raw)
}

// journey runs the parts in order. The first ones build what the rest stand on, so their failure
// ends the run; the accounts are deactivated whatever happened.
func (v *verifier) journey() {
	defer v.part("cleanup", v.cleanup)
	for _, part := range []struct {
		name string
		run  func() error
	}{
		{"anonymous", v.anonymous},
		{"sign-in", v.signIn},
		{"projects", v.projects},
		{"accounts", v.accounts},
		{"mfa", v.mfa},
	} {
		if !v.part(part.name, part.run) {
			v.note(part.name, "the rest of the journey", false, "not run: this part must pass first")
			return
		}
	}
	for _, part := range []struct {
		name string
		run  func() error
	}{
		{"records", v.records},
		{"prevention", v.prevention},
		{"evidence", v.evidence},
		{"reports", v.reports},
		{"document-lab", v.documentLab},
		{"management", v.management},
		{"automation", v.automation},
		{"notifications", v.notifications},
		{"tenant-isolation", v.isolation},
		{"read-only-role", v.readOnly},
		{"route-sweep", v.sweep},
	} {
		v.part(part.name, part.run)
	}
}

func (v *verifier) part(name string, run func() error) bool {
	v.area = name
	failedBefore := v.result.Failed
	if err := run(); err != nil && !errors.Is(err, errStop) {
		v.note(name, "finished", false, err.Error())
	}
	return v.result.Failed == failedBefore
}

// note records and prints one check.
func (v *verifier) note(area, name string, ok bool, detail string) {
	v.result.Checks = append(v.result.Checks, check{area, name, ok, detail})
	word := "PASS"
	if ok {
		v.result.Passed++
	} else {
		v.result.Failed++
		word = "FAIL"
	}
	if !v.stream {
		return
	}
	line := fmt.Sprintf("%s %s: %s", word, area, name)
	if detail != "" {
		line += " (" + detail + ")"
	}
	_, _ = fmt.Fprintln(v.app.stdout, line)
}

func (v *verifier) that(name string, ok bool, detail string) bool {
	if ok {
		detail = ""
	}
	v.note(v.area, name, ok, detail)
	return ok
}

// call is one request as an actor; nil means anonymous. A network failure counts as status 0.
type call struct {
	as          *actor
	method      string
	path        string
	json        any
	form        []byte
	contentType string
	project     string
	origin      string
	query       url.Values
}

func (v *verifier) send(q call) *response {
	c := v.anonymousClient()
	if q.as != nil {
		c = q.as.client
	}
	saved := c.project
	if q.project != "" {
		c.project = q.project
	}
	defer func() { c.project = saved }()
	out := request{method: q.method, path: q.path, query: q.query, anonymous: q.as == nil, origin: q.origin,
		body: q.form, contentType: q.contentType}
	if q.json != nil {
		body, err := json.Marshal(q.json)
		if err != nil {
			return &response{}
		}
		out.body, out.contentType = body, "application/json"
	}
	ctx, cancel := v.options.timeoutContext(v.ctx)
	defer cancel()
	answer, err := c.do(ctx, out)
	if err != nil {
		return &response{header: http.Header{}, data: map[string]any{"detail": err.Error()}}
	}
	return answer
}

func (v *verifier) anonymousClient() *client {
	c, err := newClient(v.base, v.options.caFile, v.options.timeout, nil, "")
	if err != nil {
		panic(err) // the same address already built a client
	}
	return c
}

// want checks a status and returns the response.
func (v *verifier) want(name string, status int, q call) *response {
	answer := v.send(q)
	v.that(name, answer.status == status, fmt.Sprintf("%s %s answered %d, want %d: %s", q.method, q.path, answer.status, status, shortDetail(answer)))
	return answer
}

// must is want for a success the rest of the part needs.
func (v *verifier) must(name string, q call) (*response, error) {
	answer := v.want(name, http.StatusOK, q)
	if answer.status != http.StatusOK {
		return nil, errStop
	}
	return answer, nil
}

func shortDetail(r *response) string {
	if r.data == nil {
		return ""
	}
	text := detailText(redact(apiDetail(r)))
	if len(text) > 200 {
		return text[:200] + "..."
	}
	return text
}

func text(r *response, name string) string {
	body, _ := r.data.(map[string]any)
	value, _ := body[name].(string)
	return value
}

func object(r *response, name string) map[string]any {
	body, _ := r.data.(map[string]any)
	value, _ := body[name].(map[string]any)
	return value
}

func items(r *response) []any {
	list, _ := r.data.([]any)
	return list
}

func hits(r *response) []any {
	body, _ := r.data.(map[string]any)
	list, _ := body["hits"].([]any)
	return list
}

func number(r *response, name string) float64 {
	body, _ := r.data.(map[string]any)
	value, _ := body[name].(float64)
	return value
}

// holds says whether the answer mentions a value anywhere.
func holds(r *response, value string) bool {
	body, err := json.Marshal(r.data)
	return err == nil && strings.Contains(string(body), value)
}

func companyAndProject(tenant string) (string, string) {
	company, project, _ := strings.Cut(tenant, "/")
	return company, project
}
