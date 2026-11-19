package desktopsnapshot

import (
	"errors"
	"fmt"
	"net/http"
	"regexp"
	"sort"
	"strings"
)

const (
	listed = 20
	// DefaultProbes is --probe-limit's default: probes per module and project.
	DefaultProbes = 25
	// DesktopUpdatePath is mounted only when the desktop launcher started SIPGES.
	DesktopUpdatePath = "/system/desktop/update"
	// NotComparedExit is the exit code of a comparison that did not run.
	NotComparedExit = 2
)

var versionText = regexp.MustCompile(`^[0-9A-Za-z][0-9A-Za-z.+-]{0,255}$`)

// errMalformed is a --before file that holds a snapshot of the right format but not its shape.
var errMalformed = errors.New("the --before snapshot is malformed")

// hashMap is a map of keyed hashes, as a snapshot holds them.
type hashMap struct {
	keys []string // Object.keys order
	vals map[string]any
}

func (m hashMap) has(k string) bool { _, ok := m.vals[k]; return ok }
func (m hashMap) count() int        { return len(m.keys) }

// asHashMap is Object.keys(v) with its values: null or undefined is a TypeError in JavaScript
// (here a malformed --before), and a primitive has no keys of its own (a string its indices).
func asHashMap(v any) (hashMap, error) {
	switch x := v.(type) {
	case nil, undefinedValue:
		return hashMap{}, errMalformed
	case *Object:
		return hashMap{keys: x.Keys(), vals: x.vals}, nil
	}
	m := hashMap{vals: map[string]any{}}
	for _, e := range entries(v) {
		k := e[0].(string)
		m.keys = append(m.keys, k)
		m.vals[k] = e[1]
	}
	return m, nil
}

// defaulted is a parameter with the default {}: undefined reads as an empty map.
func defaulted(v any) (hashMap, error) {
	if v == Undefined {
		return hashMap{vals: map[string]any{}}, nil
	}
	return asHashMap(v)
}

// prop is value.key: undefined for a primitive, a TypeError (malformed) for null or undefined.
func prop(v any, key string) (any, error) {
	switch x := v.(type) {
	case nil, undefinedValue:
		return nil, errMalformed
	case *Object:
		return x.Get(key), nil
	}
	return Undefined, nil
}

// recordView is a record as compare.mjs reads it: its fields are read only when the other side
// holds the record too, so a malformed one only stops the comparison then.
type recordView struct{ raw any }

func (r recordView) parts() (updated any, fields hashMap, err error) {
	if updated, err = prop(r.raw, "updated"); err != nil {
		return nil, hashMap{}, err
	}
	f, err := prop(r.raw, "fields")
	if err != nil {
		return nil, hashMap{}, err
	}
	fields, err = defaulted(f)
	return updated, fields, err
}

// uploadView is an upload as compare.mjs reads it, its content and metadata read only when the
// other side holds it too.
type uploadView struct{ raw any }

type projectView struct {
	key              string
	modules          map[string]map[string]recordView
	moduleKeys       map[string][]string
	links            hashMap
	uploads          map[string]uploadView
	uploadKeys       []string
	uploadsComplete  bool
	recordsUnchecked []string
	export           map[string][]any
	exportReadable   bool
	auditSource      any
	auditComplete    bool
	auditEntries     hashMap
}

type snapshotView struct {
	projects        []projectView
	accounts        hashMap
	accountsPresent bool
}

// view reads a snapshot object (parsed from a file, or just taken) into what the comparison uses.
func view(snapshot *Object) (snapshotView, error) {
	var out snapshotView
	list, ok := snapshot.Get("projects").([]any)
	if !ok {
		return out, errMalformed
	}
	for _, item := range list {
		p, ok := item.(*Object)
		if !ok {
			return out, errMalformed
		}
		pv, err := projectOf(p)
		if err != nil {
			return out, err
		}
		out.projects = append(out.projects, pv)
	}
	if accounts := snapshot.Get("accounts"); Truthy(accounts) {
		m, err := asHashMap(accounts)
		if err != nil {
			return out, err
		}
		out.accounts, out.accountsPresent = m, true
	}
	return out, nil
}

func projectOf(p *Object) (projectView, error) {
	pv := projectView{modules: map[string]map[string]recordView{}, moduleKeys: map[string][]string{}, uploads: map[string]uploadView{}}
	key, ok := p.Get("key").(string)
	if !ok {
		return pv, errMalformed
	}
	pv.key = key
	modules, ok := p.Get("modules").(*Object)
	if !ok {
		return pv, errMalformed
	}
	for _, slug := range modules.Keys() {
		rows, err := asHashMap(modules.vals[slug])
		if err != nil {
			return pv, err
		}
		records := map[string]recordView{}
		for _, k := range rows.keys {
			records[k] = recordView{raw: rows.vals[k]}
		}
		pv.modules[slug] = records
		pv.moduleKeys[slug] = rows.keys
	}
	var err error
	if pv.links, err = defaulted(p.Get("links")); err != nil {
		return pv, err
	}
	uploads, err := asHashMap(p.Get("uploads"))
	if err != nil {
		return pv, err
	}
	pv.uploadKeys = uploads.keys
	for _, k := range pv.uploadKeys {
		pv.uploads[k] = uploadView{raw: uploads.vals[k]}
	}
	pv.uploadsComplete = Truthy(p.Get("uploadsComplete"))
	unchecked, ok := p.Get("recordsUnchecked").([]any)
	if !ok {
		return pv, errMalformed
	}
	for _, u := range unchecked {
		pv.recordsUnchecked = append(pv.recordsUnchecked, ToString(u))
	}
	if exported := p.Get("export"); Truthy(exported) {
		tables, ok := exported.(*Object)
		if !ok {
			return pv, errMalformed
		}
		pv.export, pv.exportReadable = map[string][]any{}, true
		for _, t := range tables.Keys() {
			rows, ok := tables.vals[t].([]any)
			if !ok {
				return pv, errMalformed
			}
			pv.export[t] = rows
		}
	}
	audit, ok := p.Get("audit").(*Object)
	if !ok {
		return pv, errMalformed
	}
	pv.auditSource = audit.Get("source")
	pv.auditComplete = Truthy(audit.Get("complete"))
	if pv.auditEntries, err = asHashMap(audit.Get("entries")); err != nil {
		return pv, err
	}
	return pv, nil
}

func sortedKeys(keys []string) []string {
	out := append([]string(nil), keys...)
	SortStrings(out)
	return out
}

func stringified(v any) string {
	s, ok := Stringify(v, "")
	if !ok {
		return "\x00undefined"
	}
	return s
}

// mapProblems are the missing, new and changed keys between two maps of keyed hashes.
func mapProblems(before, after hashMap, noun, changed string) []string {
	var problems []string
	for _, key := range sortedKeys(before.keys) {
		switch {
		case !after.has(key):
			problems = append(problems, fmt.Sprintf("%s [%s] missing", noun, Short(key)))
		case stringified(before.vals[key]) != stringified(after.vals[key]):
			problems = append(problems, fmt.Sprintf("%s [%s] %s", noun, Short(key), changed))
		}
	}
	for _, key := range sortedKeys(after.keys) {
		if !before.has(key) {
			problems = append(problems, fmt.Sprintf("%s [%s] new", noun, Short(key)))
		}
	}
	return problems
}

func recordProblems(before, after map[string]recordView, beforeKeys, afterKeys []string) ([]string, error) {
	var problems []string
	for _, key := range sortedKeys(beforeKeys) {
		now, ok := after[key]
		if !ok || !Truthy(now.raw) {
			problems = append(problems, fmt.Sprintf("record [%s] missing", Short(key)))
			continue
		}
		wasUpdated, wasFields, err := before[key].parts()
		if err != nil {
			return nil, err
		}
		nowUpdated, nowFields, err := now.parts()
		if err != nil {
			return nil, err
		}
		for _, p := range mapProblems(wasFields, nowFields, "field", "differs") {
			problems = append(problems, fmt.Sprintf("record [%s] %s", Short(key), p))
		}
		if !StrictEqual(wasUpdated, nowUpdated) {
			problems = append(problems, fmt.Sprintf("record [%s] update time differs", Short(key)))
		}
	}
	for _, key := range sortedKeys(afterKeys) {
		if _, ok := before[key]; !ok {
			problems = append(problems, fmt.Sprintf("record [%s] new", Short(key)))
		}
	}
	return problems, nil
}

// report is one line, or a line and the problems under it.
func report(out *[]string, label string, problems []string, okText string) {
	switch len(problems) {
	case 0:
		*out = append(*out, fmt.Sprintf("  %s, %s", label, okText))
	case 1:
		*out = append(*out, fmt.Sprintf("  %s, %s", label, problems[0]))
	default:
		*out = append(*out, fmt.Sprintf("  %s, %s:", label, plural(len(problems), "problem")))
		for i, p := range problems {
			if i == listed {
				*out = append(*out, fmt.Sprintf("    … and %d more", len(problems)-listed))
				break
			}
			*out = append(*out, "    "+p)
		}
	}
}

func auditLine(out *[]string, before, after hashMap, trail []TrailEntry) (problems, added int) {
	var kept, missing, changed int
	for _, id := range before.keys {
		switch {
		case !after.has(id):
			missing++
		case !StrictEqual(after.vals[id], before.vals[id]):
			changed++
		default:
			kept++
		}
	}
	var fresh []TrailEntry
	for _, e := range trail {
		if !before.has(ToString(e.ID)) {
			fresh = append(fresh, e)
		}
	}
	parts := []string{fmt.Sprintf("%d -> %d", before.count(), after.count())}
	if kept > 0 {
		parts = append(parts, fmt.Sprintf("%d kept unchanged", kept))
	}
	if missing > 0 {
		parts = append(parts, fmt.Sprintf("%d missing", missing))
	}
	if changed > 0 {
		parts = append(parts, fmt.Sprintf("%d changed", changed))
	}
	if len(fresh) > 0 {
		var named []string
		for i, e := range fresh {
			if i == listed {
				named = append(named, fmt.Sprintf("… and %d more", len(fresh)-listed))
				break
			}
			named = append(named, fmt.Sprintf("#%s %s/%s", ToString(e.ID), ToString(e.Module), ToString(e.Action)))
		}
		parts = append(parts, "added: "+strings.Join(named, ", "))
	}
	*out = append(*out, "  audit: "+strings.Join(parts, ", "))
	return missing + changed, len(fresh)
}

// exportLines are the other exported tables, as sets of row hashes.
func exportLines(out *[]string, before, after projectView) (differences, incomplete int) {
	if !before.exportReadable && !after.exportReadable {
		*out = append(*out, "  export: not checked (the project export is not readable on either side)")
		return 0, 1
	}
	if !before.exportReadable || !after.exportReadable {
		*out = append(*out, "  export: readable on one side only")
		return 1, 0
	}
	seen := map[string]bool{}
	var tables []string
	for _, side := range []map[string][]any{before.export, after.export} {
		for t := range side {
			if !seen[t] {
				seen[t] = true
				tables = append(tables, t)
			}
		}
	}
	SortStrings(tables)
	for _, table := range tables {
		was, now := before.export[table], after.export[table]
		if len(was) == 0 && len(now) == 0 {
			continue
		}
		left := append([]any(nil), now...)
		missing := 0
		for _, hash := range was {
			at := -1
			for i, x := range left {
				if StrictEqual(x, hash) {
					at = i
					break
				}
			}
			if at < 0 {
				missing++
			} else {
				left = append(left[:at], left[at+1:]...)
			}
		}
		var problems []string
		if missing > 0 {
			problems = append(problems, plural(missing, "row")+" missing or changed")
		}
		if len(left) > 0 {
			problems = append(problems, plural(len(left), "row")+" new or changed")
		}
		state := "identical"
		if len(problems) > 0 {
			differences++
			state = strings.Join(problems, ", ")
		}
		*out = append(*out, fmt.Sprintf("  export %s: %d -> %d, %s", table, len(was), len(now), state))
	}
	return differences, 0
}

// Result is a comparison's lines and counts.
type Result struct {
	Lines                          []string
	Differences, Added, Incomplete int
}

// CompareSnapshots is compare.mjs's compareSnapshots: two snapshots taken with the same salt.
func CompareSnapshots(beforeObject, afterObject *Object, live *Live) (Result, error) {
	before, err := view(beforeObject)
	if err != nil {
		return Result{}, err
	}
	after, err := view(afterObject)
	if err != nil {
		return Result{}, err
	}
	var r Result
	out := &r.Lines
	afterByKey := map[string]projectView{}
	for _, p := range after.projects {
		afterByKey[p.key] = p
	}
	for index, was := range before.projects {
		*out = append(*out, fmt.Sprintf("project %d [%s]", index+1, Short(was.key)))
		now, ok := afterByKey[was.key]
		if !ok {
			*out = append(*out, "  missing after the move")
			r.Differences++
			continue
		}
		if err := compareProject(&r, was, now, live); err != nil {
			return Result{}, err
		}
	}
	for _, p := range after.projects {
		found := false
		for _, b := range before.projects {
			found = found || b.key == p.key
		}
		if !found {
			*out = append(*out, fmt.Sprintf("project [%s] new after the move", Short(p.key)))
			r.Differences++
		}
	}
	switch {
	case before.accountsPresent && after.accountsPresent:
		accounts := mapProblems(before.accounts, after.accounts, "account", "differs")
		r.Differences += len(accounts)
		label := fmt.Sprintf("Accounts: %d -> %d", before.accounts.count(), after.accounts.count())
		if len(accounts) == 0 {
			*out = append(*out, label+", identical")
		} else {
			*out = append(*out, label)
			*out = append(*out, accounts...)
		}
	case before.accountsPresent || after.accountsPresent:
		*out = append(*out, "Accounts: readable on one side only")
		r.Differences++
	default:
		*out = append(*out, "Accounts: not checked (not readable on either side)")
		r.Incomplete++
	}
	return r, nil
}

func compareProject(r *Result, was, now projectView, live *Live) error {
	out := &r.Lines
	seen := map[string]bool{}
	var slugs []string
	for _, side := range []map[string][]string{was.moduleKeys, now.moduleKeys} {
		for slug := range side {
			if !seen[slug] {
				seen[slug] = true
				slugs = append(slugs, slug)
			}
		}
	}
	SortStrings(slugs)
	for _, slug := range slugs {
		a, b := len(was.moduleKeys[slug]), len(now.moduleKeys[slug])
		if a == 0 && b == 0 {
			continue
		}
		problems, err := recordProblems(was.modules[slug], now.modules[slug], was.moduleKeys[slug], now.moduleKeys[slug])
		if err != nil {
			return err
		}
		r.Differences += len(problems)
		report(out, fmt.Sprintf("%s: %d -> %d", slug, a, b), problems, "every field identical")
	}
	var unchecked []string
	dup := map[string]bool{}
	for _, u := range append(append([]string(nil), was.recordsUnchecked...), now.recordsUnchecked...) {
		if !dup[u] {
			dup[u] = true
			unchecked = append(unchecked, u)
		}
	}
	if len(unchecked) > 0 {
		r.Incomplete++
		*out = append(*out, fmt.Sprintf("  records: not fully checked (%s)", strings.Join(unchecked, "; ")))
	}
	links := mapProblems(was.links, now.links, "link", "differs")
	r.Differences += len(links)
	report(out, fmt.Sprintf("links: %d -> %d", was.links.count(), now.links.count()), links, "identical")
	var uploads []string
	for _, key := range sortedKeys(was.uploadKeys) {
		y, ok := now.uploads[key]
		if !ok || !Truthy(y.raw) {
			uploads = append(uploads, fmt.Sprintf("upload [%s] missing", Short(key)))
			continue
		}
		xContent, err := prop(was.uploads[key].raw, "content")
		if err != nil {
			return err
		}
		yContent, err := prop(y.raw, "content")
		if err != nil {
			return err
		}
		if !StrictEqual(xContent, yContent) {
			uploads = append(uploads, fmt.Sprintf("upload [%s] content differs", Short(key)))
			continue
		}
		xMeta, err := prop(was.uploads[key].raw, "meta")
		if err != nil {
			return err
		}
		yMeta, err := prop(y.raw, "meta")
		if err != nil {
			return err
		}
		if !StrictEqual(xMeta, yMeta) {
			uploads = append(uploads, fmt.Sprintf("upload [%s] metadata differs", Short(key)))
		}
	}
	for _, key := range sortedKeys(now.uploadKeys) {
		if _, ok := was.uploads[key]; !ok {
			uploads = append(uploads, fmt.Sprintf("upload [%s] new", Short(key)))
		}
	}
	if !was.uploadsComplete || !now.uploadsComplete {
		r.Incomplete++
		*out = append(*out, fmt.Sprintf("  uploads: not fully checked (%d -> %d read; more than the list shows and the project export is not readable)", len(was.uploadKeys), len(now.uploadKeys)))
	}
	r.Differences += len(uploads)
	// Keyed content hashes only: a known file's plain SHA-256 is never printed.
	// Array.prototype.sort leaves undefined last; join writes undefined and null as "".
	type sortedContent struct {
		key  string // what sort compares: String(value)
		text string // what join writes
	}
	var contents []sortedContent
	var missing []string
	var single any
	for _, key := range was.uploadKeys {
		c, err := prop(was.uploads[key].raw, "content")
		if err != nil {
			return err
		}
		single = c
		switch c.(type) {
		case undefinedValue:
			missing = append(missing, "")
		case nil:
			contents = append(contents, sortedContent{"null", ""})
		default:
			contents = append(contents, sortedContent{ToString(c), ToString(c)})
		}
	}
	sort.SliceStable(contents, func(i, j int) bool { return Less(contents[i].key, contents[j].key) })
	joined := make([]string, 0, len(contents)+len(missing))
	for _, c := range contents {
		joined = append(joined, c.text)
	}
	content := Keyed("00")(strings.Join(append(joined, missing...), "\n"))
	if len(was.uploadKeys) == 1 {
		text, ok := single.(string)
		if !ok && was.uploadsComplete && now.uploadsComplete {
			return errMalformed // content.slice is not a function
		}
		content = text
	}
	if was.uploadsComplete && now.uploadsComplete {
		okText := "none"
		if len(was.uploadKeys) > 0 {
			okText = fmt.Sprintf("content %s… identical", sliceUnits(content, 12))
		}
		report(out, fmt.Sprintf("uploads: %d -> %d", len(was.uploadKeys), len(now.uploadKeys)), uploads, okText)
	} else {
		for i, p := range uploads {
			if i == listed {
				break
			}
			*out = append(*out, "    "+p)
		}
	}
	d, inc := exportLines(out, was, now)
	r.Differences += d
	r.Incomplete += inc
	if !was.auditComplete || !now.auditComplete || !StrictEqual(was.auditSource, now.auditSource) {
		r.Incomplete++
		*out = append(*out, fmt.Sprintf("  audit: not fully checked (%d -> %d entries; more than one page and the project export is not readable)", was.auditEntries.count(), now.auditEntries.count()))
		return nil
	}
	var trail []TrailEntry
	if lp := live.Projects[now.key]; lp != nil {
		trail = lp.Audit
	}
	problems, added := auditLine(out, was.auditEntries, now.auditEntries, trail)
	r.Differences += problems
	r.Added += added
	return nil
}

// sliceUnits is String.prototype.slice(0, n) on UTF-16 units (a hash is ASCII).
func sliceUnits(s string, n int) string {
	if isASCII(s) {
		if len(s) > n {
			return s[:n]
		}
		return s
	}
	units := utf16Units(s)
	if len(units) <= n {
		return s
	}
	var b strings.Builder
	for _, u := range units[:n] {
		writeUnit(&b, u)
	}
	return b.String()
}

// Isolation is what the probes found.
type Isolation struct{ Probes, Records, Uploads int }

// ProbeIsolation asks every other project for each record and upload of a project (at most
// limit per module and project). A record found there is a leak unless that project lists the
// same id itself with the same content.
func ProbeIsolation(s *Session, live *Live, limit int) (Isolation, error) {
	var iso Isolation
	for _, fromKey := range live.Order {
		from := live.Projects[fromKey]
		for _, otherKey := range live.Order {
			other := live.Projects[otherKey]
			if other == from {
				continue
			}
			for _, slug := range from.Slugs {
				ids := from.IDs[slug]
				for _, id := range ids[:min(limit, len(ids))] {
					iso.Probes++
					enc, err := EncodeURIComponent(id)
					if err != nil {
						return iso, err
					}
					path := "/api/" + slug + "/" + enc
					a, err := s.call(path, callOptions{scope: other.Scope})
					if err != nil {
						return iso, err
					}
					if a.Status != http.StatusOK {
						if _, err := a.Bytes(); err != nil {
							return iso, err
						}
						if a.Status != http.StatusNotFound {
							return iso, fmt.Errorf("An isolation probe answered %d", a.Status) //nolint:staticcheck // compare.mjs's message
						}
						continue
					}
					body, err := readJSON(a, path)
					if err != nil {
						return iso, err
					}
					if body == nil {
						return iso, errShape("/api/" + slug + "/<id>")
					}
					own, ok := other.Contents[slug][id]
					if !ok || own != ContentHash(other.Hash, body) {
						iso.Records++
					}
				}
			}
			for _, id := range from.UploadIDs[:min(limit, len(from.UploadIDs))] {
				iso.Probes++
				enc, err := EncodeURIComponent(id)
				if err != nil {
					return iso, err
				}
				a, err := s.call("/system/uploads/"+enc+"/download", callOptions{scope: other.Scope})
				if err != nil {
					return iso, err
				}
				if _, err := a.Bytes(); err != nil {
					return iso, err
				}
				switch {
				case a.Status == http.StatusOK && !contains(other.UploadIDs, id):
					iso.Uploads++
				case a.Status != http.StatusOK && a.Status != http.StatusNotFound:
					return iso, fmt.Errorf("An isolation probe answered %d", a.Status) //nolint:staticcheck // compare.mjs's message
				}
			}
		}
	}
	return iso, nil
}

func contains(list []string, s string) bool {
	for _, x := range list {
		if x == s {
			return true
		}
	}
	return false
}

// Managed is which server answers on --url.
type Managed struct {
	Version   string
	Forbidden bool
	// Managed is true for a managed install that does not report a readable version.
	Managed bool
	// Why is the answer of another server.
	Why string
}

var jsonType = regexp.MustCompile(`(?i)^application/json\b`)

// ManagedInstall is compare.mjs's managedInstall: only a managed install started by the desktop
// launcher mounts GET /system/desktop/update.
func ManagedInstall(s *Session) (Managed, error) {
	status, body, err := s.getJSON("/system/auth/scopes", "")
	if err != nil {
		return Managed{}, err
	}
	scope := ""
	if list, ok := body.([]any); status == http.StatusOK && ok && len(list) > 0 {
		first := list[0]
		if first != nil && first != Undefined && Truthy(first) {
			scope = ToString(fieldOf(first, "company_id")) + "/" + ToString(fieldOf(first, "project_id"))
		}
	}
	a, err := s.call(DesktopUpdatePath, callOptions{scope: scope, acceptRedirect: true})
	if err != nil {
		return Managed{}, err
	}
	b, err := a.Bytes()
	if err != nil {
		return Managed{}, err
	}
	if a.Status == http.StatusForbidden {
		return Managed{Forbidden: true}, nil
	}
	if a.Status != http.StatusOK || !jsonType.MatchString(a.Header.Get("Content-Type")) {
		why := fmt.Sprint(a.Status)
		if a.Status == http.StatusOK {
			why = "200, not JSON"
		}
		return Managed{Why: why}, nil
	}
	v, err := ParseJSON(DecodeText(b))
	if err != nil {
		return Managed{Why: "200, not JSON"}, nil
	}
	installed, ok := fieldOf(v, "installed").(string)
	if !ok || !versionText.MatchString(installed) || !isASCII(installed) {
		return Managed{Managed: true}, nil
	}
	return Managed{Version: installed}, nil
}

// RecordCount is the number of records a project holds in a snapshot.
func recordCount(p projectView) int {
	n := 0
	for _, keys := range p.moduleKeys {
		n += len(keys)
	}
	return n
}

// Summary is snapshot.mjs's summary: counts and short keyed hashes only.
func Summary(snapshot *Object) ([]string, error) {
	v, err := view(snapshot)
	if err != nil {
		return nil, err
	}
	lines := []string{fmt.Sprintf("Projects: %d", len(v.projects))}
	for i, p := range v.projects {
		var slugs []string
		for slug, keys := range p.moduleKeys {
			if len(keys) > 0 {
				slugs = append(slugs, slug)
			}
		}
		SortStrings(slugs)
		modules := make([]string, len(slugs))
		for j, slug := range slugs {
			modules[j] = fmt.Sprintf("%s %d", slug, len(p.moduleKeys[slug]))
		}
		line := fmt.Sprintf("project %d [%s]: records %d", i+1, Short(p.key), recordCount(p))
		if len(modules) > 0 {
			line += " (" + strings.Join(modules, ", ") + ")"
		}
		if len(p.recordsUnchecked) > 0 {
			line += " (not fully checked)"
		}
		line += fmt.Sprintf(", links %d, uploads %d", p.links.count(), len(p.uploadKeys))
		if !p.uploadsComplete {
			line += " (not fully checked)"
		}
		line += fmt.Sprintf(", audit %d", p.auditEntries.count())
		if !p.auditComplete {
			line += " (not fully checked)"
		}
		lines = append(lines, line)
	}
	accounts := "not readable"
	if v.accountsPresent {
		accounts = fmt.Sprint(v.accounts.count())
	}
	return append(lines, "Accounts: "+accounts), nil
}
