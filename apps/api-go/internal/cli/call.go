package cli

import (
	"context"
	"net/http"
	"net/url"
	"slices"
	"strings"
)

// requestFlags are the flags shared by the generic call and the typed commands.
type requestFlags struct {
	query  keyValues
	params keyValues
	fields keyValues
	attach keyValues
	body   string
	form   bool
	output string
}

func (o *options) emptyFlags() *requestFlags {
	return &requestFlags{query: keyValues{}, params: keyValues{}, fields: keyValues{}, attach: keyValues{}}
}

func (o *options) addRequestFlags() *requestFlags {
	f := o.emptyFlags()
	o.flags.Var(f.query, "query", "query value, name=value, repeatable")
	o.flags.Var(f.params, "param", "path value, name=value, repeatable")
	o.flags.Var(f.fields, "field", "multipart text field, name=value, repeatable")
	o.flags.Var(f.attach, "attach", "multipart file, name=path, repeatable")
	o.flags.StringVar(&f.body, "body", "", "file with the request body, or - for stdin")
	o.flags.BoolVar(&f.form, "form", false, "send the body as a URL-encoded form")
	o.flags.StringVar(&f.output, "output", "", "file for an answer that is not JSON")
	return f
}

// expand fills the {names} of a path. Every value is one escaped segment, so a value cannot
// reach another route.
func expand(route Route, path string, params keyValues) (string, error) {
	for _, name := range route.params() {
		values := params[name]
		marker := "{" + name + "}"
		if !strings.Contains(path, marker) {
			continue
		}
		if len(values) != 1 {
			return "", usageError("%s needs exactly one value for %s", route.Key(), name)
		}
		path = strings.ReplaceAll(path, marker, url.PathEscape(values[0]))
	}
	return path, nil
}

// send runs one route with the shared flags and prints the answer.
func (o *options) send(ctx context.Context, route Route, path string, f *requestFlags) (int, error) {
	path, err := expand(route, path, f.params)
	if err != nil {
		return 0, err
	}
	out := request{method: route.Method, path: path, query: url.Values(f.query), output: f.output}
	switch {
	case f.body != "" && (len(f.attach) > 0 || len(f.fields) > 0):
		return 0, usageError("--body cannot be mixed with --field or --attach")
	case len(f.attach) > 0 || len(f.fields) > 0:
		files, err := readAttachments(f.attach)
		if err != nil {
			return 0, err
		}
		if out.body, out.contentType, err = multipartBody(f.fields, files); err != nil {
			return 0, err
		}
	case f.body != "":
		if out.body, err = o.app.readBody(f.body); err != nil {
			return 0, err
		}
		out.contentType = "application/json"
		if f.form {
			out.contentType = "application/x-www-form-urlencoded"
		}
	}
	c, sessionFile, err := o.connect()
	if err != nil {
		return 0, err
	}
	ctx, cancel := o.timeoutContext(ctx)
	defer cancel()
	answer, err := c.do(ctx, out)
	if err != nil {
		return 0, err
	}
	if err := c.persist(sessionFile); err != nil {
		return 0, err
	}
	return o.answer(route.Key(), answer), nil
}

// persist saves what the API changed in the session. A session the API ended leaves no file.
func (c *client) persist(path string) error {
	if len(c.session.Cookies) == 0 {
		return removeSession(path)
	}
	return saveSession(path, c.session)
}

// call is the generic path: any route of the inventory, and only those.
func (a *app) call(ctx context.Context, o *options, args []string) (int, error) {
	flags := o.addRequestFlags()
	positional, err := o.parse(args)
	if err != nil {
		return 0, err
	}
	if len(positional) != 2 {
		return 0, usageError("usage: sipgesctl call METHOD PATH [--query a=b] [--param id=x] [--body file]")
	}
	method := strings.ToUpper(positional[0])
	path, rawQuery, _ := strings.Cut(positional[1], "?")
	route, found := findRoute(a.routes, method, path)
	if !found {
		return 0, usageError("%s %s is not in the route inventory: run sipgesctl routes", method, path)
	}
	if rawQuery != "" {
		values, err := url.ParseQuery(rawQuery)
		if err != nil {
			return 0, usageError("bad query: %v", err)
		}
		for name, items := range values {
			flags.query[name] = append(flags.query[name], items...)
		}
	}
	return o.send(ctx, route, path, flags)
}

// typed is a route with a command name: its {names} become flags of their own.
func (a *app) typed(route Route) command {
	return func(ctx context.Context, o *options, args []string) (int, error) {
		flags := o.addRequestFlags()
		values := map[string]*string{}
		for _, name := range route.params() {
			values[name] = o.flags.String(name, "", "path value")
		}
		positional, err := o.parse(args)
		if err != nil {
			return 0, err
		}
		if len(positional) > 0 {
			return 0, usageError("%s takes flags only, not %q", route.Command, positional[0])
		}
		for name, value := range values {
			if *value != "" {
				flags.params[name] = []string{*value}
			}
		}
		return o.send(ctx, route, route.Path, flags)
	}
}

// listRoutes prints the inventory, with the path that reaches each route.
func (a *app) listRoutes(_ context.Context, o *options, args []string) (int, error) {
	if _, err := o.parse(args); err != nil {
		return 0, err
	}
	type entry struct {
		Route
		Reach string `json:"reach"`
	}
	entries := make([]entry, 0, len(a.routes))
	for _, route := range a.routes {
		reach := "sipgesctl call " + route.Method + " " + route.Path
		if route.Command != "" {
			reach = "sipgesctl " + route.Command
		}
		entries = append(entries, entry{route, reach})
	}
	slices.SortFunc(entries, func(x, y entry) int { return strings.Compare(x.Key(), y.Key()) })
	return a.write(o.json, envelope{OK: true, Data: toJSONValue(entries)}, ExitOK), nil
}

// evidenceUpload names the form's fields as flags; the rest is the generic path.
func (a *app) evidenceUpload(ctx context.Context, o *options, args []string) (int, error) {
	f := o.emptyFlags()
	file := o.flags.String("file", "", "file to upload")
	module := o.flags.String("module", "", "module of the linked record")
	record := o.flags.String("record", "", "id of the linked record")
	optional := map[string]*string{}
	for _, name := range []string{"document_type", "author", "verification", "notes"} {
		optional[name] = o.flags.String(strings.ReplaceAll(name, "_", "-"), "", name)
	}
	if _, err := o.parse(args); err != nil {
		return 0, err
	}
	if *file == "" || *module == "" || *record == "" {
		return 0, usageError("usage: sipgesctl evidence upload --file PATH --module SLUG --record ID")
	}
	f.attach["file"] = []string{*file}
	f.fields["linked_module"] = []string{*module}
	f.fields["linked_record_id"] = []string{*record}
	for name, value := range optional {
		if *value != "" {
			f.fields[name] = []string{*value}
		}
	}
	return o.send(ctx, Route{Method: http.MethodPost, Path: "/system/uploads"}, "/system/uploads", f)
}
