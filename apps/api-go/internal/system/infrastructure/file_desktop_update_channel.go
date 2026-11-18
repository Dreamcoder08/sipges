// Package infrastructure holds the file channel of the desktop update notice, as
// apps/api/src/contexts/system/infrastructure/file-desktop-update-channel.ts.
package infrastructure

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"time"

	"github.com/Dreamcoder08/sipges/apps/api-go/internal/system/application"
)

const (
	// statusFile is written by deploy/desktop/updater/launcher.mjs before and after its check.
	statusFile = "status.json"
	// requestFile is written here after the click; the launcher reads it, removes it and updates.
	requestFile = "request.json"
	maxVersion  = 256  // UTF-16 code units, z.string().min(1).max(256)
	maxNotes    = 4000 // UTF-16 code units, z.string().max(4000)
)

// FileDesktopUpdateChannel is the channel in the folder named by SIPGES_DESKTOP_UPDATE_DIR
// (absolute, owned by the launcher).
type FileDesktopUpdateChannel struct {
	dir string
	now func() time.Time
}

// NewFileDesktopUpdateChannel reads and writes dir; now stamps requestedAt.
func NewFileDesktopUpdateChannel(dir string, now func() time.Time) FileDesktopUpdateChannel {
	if now == nil {
		now = time.Now
	}
	return FileDesktopUpdateChannel{dir: dir, now: now}
}

// Read returns what the launcher verified; a status that is missing, unreadable or not in the
// LauncherStatus shape reads as nothing, never as an error.
func (c FileDesktopUpdateChannel) Read(context.Context) (application.DesktopUpdateCheck, error) {
	text, err := os.ReadFile(filepath.Join(c.dir, statusFile))
	if err != nil {
		return application.DesktopUpdateCheck{}, nil
	}
	check, ok := parseStatus(text)
	if !ok {
		return application.DesktopUpdateCheck{}, nil
	}
	return check, nil
}

// Request writes request.json whole under a temporary name, then renames it: the launcher never
// reads half a request.
func (c FileDesktopUpdateChannel) Request(_ context.Context, version string) error {
	var id [16]byte
	if _, err := rand.Read(id[:]); err != nil {
		return err
	}
	temporary := filepath.Join(c.dir, "."+requestFile+"."+hex.EncodeToString(id[:])+".tmp")
	body, err := stringify(struct {
		Format      int    `json:"format"`
		Version     string `json:"version"`
		RequestedAt string `json:"requestedAt"`
	}{1, version, c.now().UTC().Format("2006-01-02T15:04:05.000Z")})
	if err != nil {
		return err
	}
	file, err := os.OpenFile(temporary, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600) //nolint:gosec // the configured channel folder and a name made here
	if err != nil {
		return err
	}
	_, err = file.Write(body)
	if closeErr := file.Close(); err == nil {
		err = closeErr
	}
	if err == nil {
		err = os.Rename(temporary, filepath.Join(c.dir, requestFile))
	}
	if err != nil {
		_ = os.Remove(temporary)
	}
	return err
}

// stringify is JSON.stringify followed by a newline: no HTML escaping.
func stringify(v any) ([]byte, error) {
	var b bytes.Buffer
	enc := json.NewEncoder(&b)
	enc.SetEscapeHTML(false)
	err := enc.Encode(v)
	return b.Bytes(), err
}

// parseStatus is JSON.parse of the UTF-8 text, then LauncherStatus.safeParse: format the number
// 1, installed a version or null, available null or {version, notes: text of 4000 or null}.
// Keys are case sensitive, unknown keys are ignored and a repeated key keeps its last value.
func parseStatus(text []byte) (application.DesktopUpdateCheck, bool) {
	var none application.DesktopUpdateCheck
	// JSON.parse refuses a byte order mark, which readFile(…, 'utf8') keeps.
	fields, ok := object(text)
	if !ok || !formatOne(fields["format"]) {
		return none, false
	}
	installed, ok := nullableText(fields["installed"], 1, maxVersion)
	if !ok {
		return none, false
	}
	rawAvailable, present := fields["available"]
	if !present {
		return none, false
	}
	check := application.DesktopUpdateCheck{Installed: installed}
	if isNull(rawAvailable) {
		return check, true
	}
	available, ok := object(rawAvailable)
	if !ok {
		return none, false
	}
	version, ok := nullableText(available["version"], 1, maxVersion)
	if !ok || version == nil {
		return none, false
	}
	notes, ok := nullableText(available["notes"], 0, maxNotes)
	if !ok {
		return none, false
	}
	check.Available = &application.DesktopUpdateAvailable{Version: *version, Notes: notes}
	return check, true
}

// object reads a JSON object; null, arrays and scalars are not one.
func object(raw []byte) (map[string]json.RawMessage, bool) {
	trimmed := bytes.TrimLeft(raw, " \t\r\n")
	if len(trimmed) == 0 || trimmed[0] != '{' {
		return nil, false
	}
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(raw, &fields); err != nil {
		return nil, false
	}
	return fields, true
}

func isNull(raw json.RawMessage) bool { return string(bytes.TrimSpace(raw)) == "null" }

// formatOne is z.literal(1): a JSON number whose value is 1 (1, 1.0 and 1e0 alike).
func formatOne(raw json.RawMessage) bool {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 || (trimmed[0] != '-' && (trimmed[0] < '0' || trimmed[0] > '9')) {
		return false
	}
	var n float64
	return json.Unmarshal(trimmed, &n) == nil && n == 1
}

// nullableText reads null, or a string of min to max UTF-16 code units; a missing key fails, as
// zod's nullable refuses undefined.
func nullableText(raw json.RawMessage, minUnits, maxUnits int) (*string, bool) {
	if raw == nil {
		return nil, false
	}
	if isNull(raw) {
		return nil, true
	}
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 || trimmed[0] != '"' {
		return nil, false
	}
	var s string
	if err := json.Unmarshal(trimmed, &s); err != nil {
		return nil, false
	}
	if n := len16(s); n < minUnits || n > maxUnits {
		return nil, false
	}
	return &s, true
}

// len16 is a JavaScript string's length: UTF-16 code units.
func len16(s string) int {
	n := 0
	for _, r := range s {
		n++
		if r > 0xffff {
			n++
		}
	}
	return n
}
