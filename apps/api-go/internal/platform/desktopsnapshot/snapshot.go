package desktopsnapshot

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net/http"
	"sort"
	"strings"
	"time"
)

// Format and FormatVersion are snapshot.mjs's FORMAT and FORMAT_VERSION.
const (
	Format        = "sipges.migration-snapshot"
	FormatVersion = 4
)

const (
	page          = 500
	maxPages      = 10_000
	auditPage     = 500
	uploadListCap = 500
	streamTimeout = 120 * time.Second
)

// exportComparedElsewhere are the export's tables compared record by record and entry by entry.
var exportComparedElsewhere = map[string]bool{"module_records": true, "audit": true}

func failed(what string, status int) error { return fmt.Errorf("%s answered %d", what, status) }

func plural(n int, word string) string {
	if n == 1 {
		return fmt.Sprintf("%d %s", n, word)
	}
	return fmt.Sprintf("%d %ss", n, word)
}

// errShape is a body this version of the API never answers (Node would throw a TypeError).
func errShape(route string) error { return fmt.Errorf("%s answered an unexpected shape", route) }

// TrailEntry is one audit entry's id, module and action, kept in memory for the added list.
type TrailEntry struct{ ID, Module, Action any }

// LiveProject is what one project's snapshot keeps in memory for the isolation probes and the
// added audit entries; it is never written.
type LiveProject struct {
	Scope     string
	Slugs     []string
	IDs       map[string][]string
	Contents  map[string]map[string]string
	UploadIDs []string
	Audit     []TrailEntry
	Hash      Hasher
}

// Live are the live projects in the order they were read.
type Live struct {
	Order    []string
	Projects map[string]*LiveProject
}

// moduleRows is every row of one module, page by page; ok false when this version has no such
// module. A page that repeats a row already read means the offset is not honoured.
func moduleRows(s *Session, scope, slug string) (rows []any, problem string, ok bool, err error) {
	seen := map[string]bool{}
	for pages := 0; pages < maxPages; pages++ {
		offset := len(rows)
		status, body, err := s.getJSON(fmt.Sprintf("/api/%s?limit=%d&offset=%d", slug, page, offset), scope)
		if err != nil {
			return nil, "", false, err
		}
		if status == http.StatusNotFound && offset == 0 {
			return nil, "", false, nil
		}
		if status != http.StatusOK {
			return nil, "", false, failed("/api/"+slug, status)
		}
		list, isList := body.([]any)
		if !isList {
			return nil, "", false, errShape("/api/" + slug)
		}
		if len(list) == 0 {
			return rows, "", true, nil
		}
		for _, row := range list {
			id := ToString(fieldOf(row, "_id"))
			if seen[id] {
				return rows, slug + ": the list repeated rows, its offset is not honoured", true, nil
			}
			seen[id] = true
			rows = append(rows, row)
		}
	}
	return rows, fmt.Sprintf("%s: more than %d pages", slug, maxPages), true, nil
}

// fieldOf is value?.[key].
func fieldOf(v any, key string) any {
	if o, ok := v.(*Object); ok {
		return o.Get(key)
	}
	return Undefined
}

// unreadExportRecords are the export's stored records no list read: by id when its rows carry
// one, otherwise by count; ok false when the export cannot be read.
func unreadExportRecords(exported *Object, ids map[string][]string, slugs []string) (int, bool) {
	stored, isList := exported.Get("module_records").([]any)
	if exported == nil || !isList {
		return 0, false
	}
	var read []string
	for _, slug := range slugs {
		read = append(read, ids[slug]...)
	}
	for _, row := range stored {
		switch fieldOf(row, "id").(type) {
		case undefinedValue, nil:
			return max(0, len(stored)-len(read)), true
		}
	}
	left := map[string]int{}
	for _, id := range read {
		left[id]++
	}
	unread := 0
	for _, row := range stored {
		id := ToString(fieldOf(row, "id"))
		if left[id] > 0 {
			left[id]--
		} else {
			unread++
		}
	}
	return unread, true
}

// errStreamLate is snapshot.mjs's message when the 120 s of the stream ran out.
var errStreamLate = errors.New("The audit stream did not reach the newest entry in time") //nolint:staticcheck // snapshot.mjs's message

// decodeWhole is TextDecoder in stream mode: the whole UTF-8 sequences of b decoded, and an
// incomplete one at its end kept for the next chunk.
func decodeWhole(b []byte, final bool) (string, []byte) {
	if !final {
		for k := 1; k <= 3 && k <= len(b); k++ {
			c := b[len(b)-k]
			if c < 0x80 {
				break
			}
			need := 0
			switch {
			case c >= 0xC2 && c <= 0xDF:
				need = 2
			case c >= 0xE0 && c <= 0xEF:
				need = 3
			case c >= 0xF0 && c <= 0xF4:
				need = 4
			}
			if need > k {
				return DecodeText(b[:len(b)-k]), append([]byte(nil), b[len(b)-k:]...)
			}
			if need != 0 {
				break
			}
		}
	}
	return DecodeText(b), nil
}

// streamedTrail is the whole audit trail of a project, oldest first, from the activity stream:
// only when the export cannot be read. Its entries carry no detail, so they are counted but
// their content is not checked.
func streamedTrail(s *Session, scope string, newest []any) ([]TrailEntry, error) {
	lastID := ToNumber(fieldOf(newest[0], "id"))
	a, err := s.call("/system/events", callOptions{
		scope:   scope,
		headers: map[string]string{"Accept": "text/event-stream", "Last-Event-ID": "0"},
		timeout: streamTimeout,
	})
	if errors.Is(err, context.DeadlineExceeded) {
		return nil, errStreamLate
	}
	if err != nil {
		return nil, err
	}
	defer a.Close()
	if a.Status != http.StatusOK {
		return nil, failed("/system/events", a.Status)
	}
	var entries []TrailEntry
	var raw []byte
	buffer := ""
	first := true
	chunk := make([]byte, 32<<10)
	for {
		n, rerr := a.body.Read(chunk)
		raw = append(raw, chunk[:n]...)
		if first && len(raw) >= 3 {
			raw = bytes.TrimPrefix(raw, []byte{0xEF, 0xBB, 0xBF})
			first = false
		}
		text, rest := decodeWhole(raw, rerr != nil)
		raw = rest
		buffer += text
		for {
			end := strings.Index(buffer, "\n\n")
			if end < 0 {
				break
			}
			block := buffer[:end]
			buffer = buffer[end+2:]
			field := func(name string) (string, bool) {
				for _, line := range strings.Split(block, "\n") {
					if strings.HasPrefix(line, name+":") {
						return Trim(line[len(name)+1:]), true
					}
				}
				return "", false
			}
			if event, _ := field("event"); event != "activity" {
				continue
			}
			id := ToNumber(Undefined)
			if idText, ok := field("id"); ok {
				id = ToNumber(idText)
			}
			dataText, ok := field("data")
			if !ok {
				dataText = "{}"
			}
			data, perr := ParseJSON(dataText)
			if perr != nil {
				return nil, errors.New("The audit stream sent an entry that is not valid JSON") //nolint:staticcheck // a sentence for the log
			}
			entries = append(entries, TrailEntry{ID: id, Module: fieldOf(data, "module"), Action: fieldOf(data, "action")})
			if id >= lastID {
				return entries, nil
			}
		}
		switch {
		case rerr == nil:
		case errors.Is(rerr, context.DeadlineExceeded):
			return nil, errStreamLate
		case errors.Is(rerr, io.EOF):
			return nil, errors.New("The audit stream ended before the newest entry") //nolint:staticcheck // snapshot.mjs's message
		default:
			return nil, bodyError(rerr)
		}
	}
}

// auditResult is auditOf's answer.
type auditResult struct {
	source   string
	complete bool
	rows     []any
	trail    []TrailEntry
	hash     func(i int) string
}

func byID(rows []any) []any {
	out := append([]any(nil), rows...)
	sort.SliceStable(out, func(i, j int) bool {
		return ToNumber(fieldOf(out[i], "id"))-ToNumber(fieldOf(out[j], "id")) < 0
	})
	return out
}

func trailOf(rows []any) []TrailEntry {
	out := make([]TrailEntry, len(rows))
	for i, row := range rows {
		out[i] = TrailEntry{ID: fieldOf(row, "id"), Module: fieldOf(row, "module"), Action: fieldOf(row, "action")}
	}
	return out
}

// auditOf is every audit entry with its content: the export's rows, or the newest page when it
// holds the whole trail; otherwise the streamed ids, marked incomplete.
func auditOf(s *Session, scope string, h Hasher, exported *Object) (auditResult, error) {
	if rows, ok := exported.Get("audit").([]any); exported != nil && ok {
		sorted := byID(rows)
		return auditResult{"export", true, sorted, trailOf(sorted), func(i int) string { return h(sorted[i]) }}, nil
	}
	status, body, err := s.getJSON(fmt.Sprintf("/system/audit?limit=%d", auditPage), scope)
	if err != nil {
		return auditResult{}, err
	}
	if status != http.StatusOK {
		return auditResult{}, failed("/system/audit", status)
	}
	newest, ok := body.([]any)
	if !ok {
		return auditResult{}, errShape("/system/audit")
	}
	if len(newest) < auditPage {
		sorted := byID(newest)
		return auditResult{"audit", true, sorted, trailOf(sorted), func(i int) string { return h(sorted[i]) }}, nil
	}
	trail, err := streamedTrail(s, scope, newest)
	if err != nil {
		return auditResult{}, err
	}
	rows := make([]any, len(trail))
	for i, e := range trail {
		rows[i] = e
	}
	return auditResult{"stream", false, rows, trail, func(i int) string {
		return h(ToString(trail[i].Module) + "\n" + ToString(trail[i].Action))
	}}, nil
}

// uploadIDsOf is the id of every upload: the list shows at most 500, so the export's attachment
// rows name the rest. Without the export a full list is marked incomplete.
func uploadIDsOf(s *Session, scope string, exported *Object) ([]string, bool, error) {
	status, body, err := s.getJSON(fmt.Sprintf("/system/uploads?limit=%d", uploadListCap), scope)
	if err != nil {
		return nil, false, err
	}
	if status != http.StatusOK {
		return nil, false, failed("/system/uploads", status)
	}
	listed, ok := body.([]any)
	if !ok {
		return nil, false, errShape("/system/uploads")
	}
	seen := map[string]bool{}
	var ids []string
	add := func(id string) {
		if !seen[id] {
			seen[id] = true
			ids = append(ids, id)
		}
	}
	for _, u := range listed {
		add(ToString(fieldOf(u, "id")))
	}
	if rows, isList := exported.Get("attachments").([]any); exported != nil && isList {
		for _, row := range rows {
			add(ToString(fieldOf(row, "id")))
		}
		SortStrings(ids)
		return ids, true, nil
	}
	SortStrings(ids)
	return ids, len(listed) < uploadListCap, nil
}

// NewSalt is a random 16-byte salt in hex, as snapshot.mjs makes one.
func NewSalt() string {
	b := make([]byte, 16)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

// takenAt is new Date().toISOString().
func takenAt(t time.Time) string { return t.UTC().Format("2006-01-02T15:04:05.000Z") }

// TakeSnapshot reads everything the comparison needs, as snapshot.mjs's takeSnapshot: the
// snapshot holds only counts and keyed hashes; live keeps the raw ids in memory, never written.
func TakeSnapshot(s *Session, salt string, now time.Time) (*Object, *Live, error) {
	h := Keyed(salt)
	hb := KeyedBytes(salt)
	status, body, err := s.getJSON("/system/auth/scopes", "")
	if err != nil {
		return nil, nil, err
	}
	if status != http.StatusOK {
		return nil, nil, failed("/system/auth/scopes", status)
	}
	scopeList, ok := body.([]any)
	if !ok {
		return nil, nil, errShape("/system/auth/scopes")
	}
	names := make([]string, len(scopeList))
	for i, sc := range scopeList {
		names[i] = ToString(fieldOf(sc, "company_id")) + "/" + ToString(fieldOf(sc, "project_id"))
	}
	SortStrings(names)
	snapshot := NewObject()
	snapshot.Set("format", Format)
	snapshot.Set("version", float64(FormatVersion))
	snapshot.Set("takenAt", takenAt(now))
	snapshot.Set("salt", salt)
	live := &Live{Projects: map[string]*LiveProject{}}
	var projects []any
	for _, scope := range names {
		project, lp, err := takeProject(s, scope, h, hb)
		if err != nil {
			return nil, nil, err
		}
		projects = append(projects, project)
		key := project.Get("key").(string)
		if _, seen := live.Projects[key]; !seen {
			live.Order = append(live.Order, key)
		}
		live.Projects[key] = lp
	}
	if projects == nil {
		projects = []any{}
	}
	snapshot.Set("projects", projects)
	var accounts any
	if len(names) > 0 {
		status, body, err := s.getJSON("/system/auth/accounts", names[0])
		if err != nil {
			return nil, nil, err
		}
		if status == http.StatusOK {
			list, ok := body.([]any)
			if !ok {
				return nil, nil, errShape("/system/auth/accounts")
			}
			byName := NewObject()
			for _, a := range list {
				byName.Set(h(ToString(fieldOf(a, "username"))), h(a))
			}
			accounts = byName
		}
	}
	snapshot.Set("accounts", accounts)
	return snapshot, live, nil
}

func takeProject(s *Session, scope string, h Hasher, hb func([]byte) string) (*Object, *LiveProject, error) {
	project := NewObject()
	project.Set("key", h(scope))
	modules := NewObject()
	links := NewObject()
	uploads := NewObject()
	project.Set("modules", modules)
	project.Set("links", links)
	project.Set("uploads", uploads)
	project.Set("audit", NewObject())
	lp := &LiveProject{Scope: scope, IDs: map[string][]string{}, Contents: map[string]map[string]string{}, Hash: h}
	var unchecked []string
	for _, slug := range ModuleSlugs {
		rows, problem, ok, err := moduleRows(s, scope, slug)
		if err != nil {
			return nil, nil, err
		}
		if !ok {
			continue
		}
		if problem != "" {
			unchecked = append(unchecked, problem)
		}
		lp.Slugs = append(lp.Slugs, slug)
		ids := make([]string, len(rows))
		contents := map[string]string{}
		records := NewObject()
		for i, row := range rows {
			o, isObject := row.(*Object)
			if !isObject {
				return nil, nil, errShape("/api/" + slug)
			}
			ids[i] = ToString(o.Get("_id"))
			contents[ids[i]] = ContentHash(h, o)
			updated := o.Get("_updated_at")
			if updated == nil || updated == Undefined {
				updated = ""
			}
			fields := NewObject()
			for _, k := range o.Keys() {
				if k == "_id" || k == "_updated_at" {
					continue
				}
				fields.Set(h(k), h(o.vals[k]))
			}
			record := NewObject()
			record.Set("updated", h(ToString(updated)))
			record.Set("fields", fields)
			records.Set(h(ids[i]), record)
		}
		lp.IDs[slug] = ids
		lp.Contents[slug] = contents
		modules.Set(slug, records)
	}
	for _, slug := range lp.Slugs {
		for _, id := range lp.IDs[slug] {
			m, err := EncodeURIComponent(slug)
			if err != nil {
				return nil, nil, err
			}
			i, err := EncodeURIComponent(id)
			if err != nil {
				return nil, nil, err
			}
			status, body, err := s.getJSON("/system/links?module="+m+"&id="+i, scope)
			if err != nil {
				return nil, nil, err
			}
			if status != http.StatusOK {
				return nil, nil, failed("/system/links", status)
			}
			list := fieldOf(body, "links")
			if list == nil || list == Undefined {
				continue
			}
			found, ok := list.([]any)
			if !ok {
				return nil, nil, errShape("/system/links")
			}
			for _, link := range found {
				edge := fieldOf(link, "edge")
				if _, ok := edge.(*Object); !ok {
					return nil, nil, errShape("/system/links")
				}
				links.Set(h(ToString(fieldOf(edge, "id"))), h(edge))
			}
		}
	}
	status, body, err := s.getJSON("/system/export", scope)
	if err != nil {
		return nil, nil, err
	}
	var exported *Object
	if status == http.StatusOK {
		data := fieldOf(body, "data")
		if data == nil || data == Undefined {
			data = NewObject()
		}
		var isObject bool
		if exported, isObject = data.(*Object); !isObject {
			return nil, nil, errShape("/system/export")
		}
	}
	if exported != nil {
		tables := NewObject()
		for _, table := range exported.Keys() {
			if exportComparedElsewhere[table] {
				continue
			}
			rows, ok := exported.vals[table].([]any)
			if !ok {
				return nil, nil, errShape("/system/export")
			}
			hashes := make([]string, len(rows))
			for i, row := range rows {
				hashes[i] = ExportRowHash(h, table, row)
			}
			SortStrings(hashes)
			tables.Set(table, stringList(hashes))
		}
		project.Set("export", tables)
	} else {
		project.Set("export", nil)
	}
	unread, known := unreadExportRecords(exported, lp.IDs, lp.Slugs)
	if known && unread > 0 {
		unchecked = append(unchecked, plural(unread, "record")+" in the project export not read through the lists")
	}
	if known && unread == 0 {
		unchecked = nil
	}
	project.Set("recordsUnchecked", stringList(unchecked))
	ids, complete, err := uploadIDsOf(s, scope, exported)
	if err != nil {
		return nil, nil, err
	}
	lp.UploadIDs = ids
	project.Set("uploadsComplete", complete)
	for _, id := range ids {
		enc, err := EncodeURIComponent(id)
		if err != nil {
			return nil, nil, err
		}
		path := "/system/uploads/" + enc
		status, body, err := s.getJSON(path, scope)
		if err != nil {
			return nil, nil, err
		}
		if status != http.StatusOK {
			return nil, nil, failed("an upload", status)
		}
		file, err := s.call(path+"/download", callOptions{scope: scope})
		if err != nil {
			return nil, nil, err
		}
		if file.Status != http.StatusOK {
			file.Close()
			return nil, nil, failed("an upload download", file.Status)
		}
		content, err := file.Bytes()
		if err != nil {
			return nil, nil, err
		}
		meta := NewObject()
		for _, e := range entries(body) {
			if e[0] != "download_url" {
				meta.Set(e[0].(string), e[1])
			}
		}
		upload := NewObject()
		upload.Set("content", hb(content))
		upload.Set("meta", h(meta))
		uploads.Set(h(id), upload)
	}
	audit, err := auditOf(s, scope, h, exported)
	if err != nil {
		return nil, nil, err
	}
	auditEntries := NewObject()
	for i := range audit.rows {
		auditEntries.Set(ToString(audit.trail[i].ID), audit.hash(i))
	}
	auditObject := NewObject()
	auditObject.Set("source", audit.source)
	auditObject.Set("complete", audit.complete)
	auditObject.Set("entries", auditEntries)
	project.Set("audit", auditObject)
	lp.Audit = audit.trail
	return project, lp, nil
}

func stringList(s []string) []any {
	out := make([]any, len(s))
	for i, v := range s {
		out[i] = v
	}
	return out
}
