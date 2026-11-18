package desktoprelease

import (
	"bytes"
	"crypto/ed25519"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
)

// Manifest is a verified release.json.
type Manifest struct {
	Version         string
	MinimumPrevious *string // nil when the release accepts any installed version
	Platform        string  // Node's process.platform: win32, linux, darwin
	Arch            string  // Node's process.arch: x64, arm64
	Notes           *string // release notes for the update notice, nil when absent
	// Files maps each package file to its SHA-256 in hex; FileOrder lists them in manifest order.
	Files     map[string]string
	FileOrder []string
	// Links maps each folder link to its relative target; LinkOrder lists them in manifest order.
	Links       map[string]string
	LinkOrder   []string
	Directories []string
}

// Release is a release whose signature verified and whose manifest is valid.
type Release struct {
	Manifest  *Manifest
	Bytes     []byte // the exact signed release.json bytes
	Signature string // the base64 signature text with one trailing newline, as Node returns it
}

var sha256Hex = regexp.MustCompile(`^[0-9a-f]{64}$`)

// ReadRelease verifies release.sig over the exact bytes of release.json with key, then parses
// and validates the manifest (release.mjs readRelease). Refusals are *Error with code REFUSED;
// any other error is an I/O failure.
func ReadRelease(releaseDir string, key ed25519.PublicKey) (*Release, error) {
	manifestPath := filepath.Join(releaseDir, ManifestName)
	info, err := os.Lstat(manifestPath)
	if err != nil {
		return nil, refuse(KindNoManifest, "No %s in the release directory", ManifestName)
	}
	tooLarge := refuse(KindNoManifest, "%s is not a file or is too large", ManifestName)
	if !info.Mode().IsRegular() || info.Size() > MaxManifestBytes {
		return nil, tooLarge
	}
	data, err := readLimited(manifestPath, MaxManifestBytes)
	if errors.Is(err, errTooLarge) {
		return nil, tooLarge
	}
	if err != nil {
		return nil, err
	}
	sigData, err := os.ReadFile(filepath.Join(releaseDir, SignatureName)) //nolint:gosec // a path inside the release folder being verified
	if err != nil {
		return nil, refuse(KindNoSignature, "No %s in the release directory", SignatureName)
	}
	text := jsTrim(string(sigData))
	signature, err := base64.StdEncoding.DecodeString(text)
	if err != nil || len(signature) != ed25519.SignatureSize || base64.StdEncoding.EncodeToString(signature) != text {
		return nil, refuse(KindSignatureMalformed, "The release signature is malformed")
	}
	if len(key) != ed25519.PublicKeySize || !ed25519.Verify(key, data, signature) {
		return nil, refuse(KindSignatureMismatch, "The release signature does not match the trusted update key")
	}
	manifest, err := parseManifest(data)
	if err != nil {
		return nil, err
	}
	return &Release{Manifest: manifest, Bytes: data, Signature: text + "\n"}, nil
}

var errTooLarge = errors.New("file too large")

// readLimited reads a whole file, refusing one that grew past limit since it was checked.
func readLimited(name string, limit int64) ([]byte, error) {
	f, err := os.Open(name) //nolint:gosec // a path inside the release folder being verified
	if err != nil {
		return nil, err
	}
	defer f.Close() //nolint:errcheck // read-only
	data, err := io.ReadAll(io.LimitReader(f, limit+1))
	if err != nil {
		return nil, err
	}
	if int64(len(data)) > limit {
		return nil, errTooLarge
	}
	return data, nil
}

// IsSafeRelative reports whether p is a package path release.mjs accepts: POSIX separators, no
// traversal, nothing Windows would alias or reject, at most 1024 UTF-16 code units.
func IsSafeRelative(p string) bool {
	if p == "" || utf16Len(p) > 1024 {
		return false
	}
	for _, r := range p {
		if r < 32 || strings.ContainsRune(`\:*?"<>|`, r) {
			return false
		}
	}
	for _, s := range strings.Split(p, "/") {
		if s == "" || s == "." || s == ".." || strings.HasSuffix(s, ".") || strings.HasSuffix(s, " ") {
			return false
		}
	}
	return true
}

// validNotes is release.mjs validNotes: absent, null, or non-blank text of at most 4000 units.
func validNotes(raw json.RawMessage, present bool) (*string, bool) {
	if !present || jsKind(raw) == "null" {
		return nil, true
	}
	s, ok := jsString(raw)
	if !ok || jsTrim(s) == "" || utf16Len(s) > MaxNotesLength {
		return nil, false
	}
	return &s, true
}

// parseManifest is JSON.parse followed by release.mjs validateManifest, rule for rule and in the
// same order, so the first broken rule gives the message Node gives.
func parseManifest(data []byte) (*Manifest, error) {
	fail := func(why string) error { return refuse(KindManifestInvalid, "The release manifest is invalid: %s", why) }
	if !json.Valid(data) {
		return nil, fail("not JSON")
	}
	// JSON.parse keeps a lone surrogate; encoding/json would turn it into U+FFFD and could merge two
	// keys the Node updater keeps apart, so such a manifest is refused as Node can never match it.
	if hasLoneSurrogateEscape(data) {
		return nil, fail("an unpaired UTF-16 surrogate escape")
	}
	if jsKind(data) != "object" {
		return nil, fail("not an object")
	}
	top, err := parseObject(data)
	if err != nil {
		return nil, fail("not JSON")
	}
	m := &Manifest{}
	if raw, ok := top.get("format"); !ok || !isOne(raw) {
		return nil, fail("unknown format")
	}
	version, _ := top.get("version")
	if s, ok := jsString(version); !ok || !IsVersion(s) {
		return nil, fail("version")
	} else {
		m.Version = s
	}
	minimum, present := top.get("minimumPrevious")
	if !present || jsKind(minimum) != "null" {
		s, ok := jsString(minimum)
		if !ok || !IsVersion(s) {
			return nil, fail("minimum previous version")
		}
		m.MinimumPrevious = &s
	}
	platform, okPlatform := jsString(top.values["platform"])
	arch, okArch := jsString(top.values["arch"])
	if !okPlatform || !okArch {
		return nil, fail("platform")
	}
	m.Platform, m.Arch = platform, arch
	notesRaw, notesPresent := top.get("notes")
	notes, ok := validNotes(notesRaw, notesPresent)
	if !ok {
		return nil, fail("notes")
	}
	m.Notes = notes

	filesRaw, filesPresent := top.get("files")
	linksRaw, linksPresent := top.get("links")
	if !isObjectLike(filesRaw, filesPresent) || !isObjectLike(linksRaw, linksPresent) {
		return nil, fail("lists")
	}
	dirsRaw := top.values["directories"]
	if jsKind(dirsRaw) != "array" {
		return nil, fail("directories")
	}
	files, err := parseObject(filesRaw)
	if err != nil {
		return nil, fail("lists")
	}
	links, err := parseObject(linksRaw)
	if err != nil {
		return nil, fail("lists")
	}
	var dirValues []json.RawMessage
	if err := json.Unmarshal(dirsRaw, &dirValues); err != nil {
		return nil, fail("directories")
	}

	// all: file paths, link paths, then directories, as JavaScript spreads them.
	type entry struct {
		path string
		raw  json.RawMessage
	}
	var all []entry
	for _, k := range files.keys {
		all = append(all, entry{k, mustQuote(k)})
	}
	for _, k := range links.keys {
		all = append(all, entry{k, mustQuote(k)})
	}
	directories := make([]string, 0, len(dirValues))
	for _, raw := range dirValues {
		s, ok := jsString(raw)
		all = append(all, entry{s, raw})
		if ok {
			directories = append(directories, s)
		} else {
			// Not text: refused below as an unsafe path, before anything else reads it.
			all[len(all)-1].path = "\x00"
		}
	}
	seen := map[string]bool{}
	for _, e := range all {
		if !IsSafeRelative(e.path) {
			return nil, fail("unsafe path " + jsStringify(e.raw))
		}
		lower := jsLower(e.path)
		if seen[lower] {
			return nil, fail("duplicate path " + e.path)
		}
		seen[lower] = true
	}
	for _, reserved := range []string{ManifestName, SignatureName} {
		if seen[reserved] {
			return nil, fail("reserved name " + reserved)
		}
	}
	for _, required := range requiredFiles {
		if _, ok := files.get(required); !ok {
			return nil, fail("missing " + required)
		}
	}
	m.Files = map[string]string{}
	for _, k := range files.keys {
		hash, ok := jsString(files.values[k])
		if !ok || !sha256Hex.MatchString(hash) {
			return nil, fail("hash")
		}
		m.Files[k] = hash
		m.FileOrder = append(m.FileOrder, k)
	}
	listed := map[string]bool{}
	for _, d := range directories {
		listed[d] = true
	}
	m.Links = map[string]string{}
	for _, k := range links.keys {
		target, ok := jsString(links.values[k])
		if !ok || target == "" || strings.HasPrefix(target, "/") || strings.Contains(target, `\`) {
			return nil, fail("link " + k)
		}
		resolved := posixNormalize(path.Dir(k) + "/" + target)
		if resolved == ".." || strings.HasPrefix(resolved, "../") || !listed[resolved] {
			return nil, fail(fmt.Sprintf("link %s leaves the package", k))
		}
		m.Links[k] = target
		m.LinkOrder = append(m.LinkOrder, k)
	}
	for _, e := range all {
		for _, link := range links.keys {
			if strings.HasPrefix(e.path, link+"/") {
				return nil, fail(fmt.Sprintf("path %s under link %s", e.path, link))
			}
		}
	}
	m.Directories = directories
	return m, nil
}

// isOne is `value === 1` for a JSON value: the number one, however it is written.
func isOne(raw json.RawMessage) bool {
	f, ok := jsNumberValue(raw)
	return ok && f == 1
}

// isObjectLike is `value && typeof value === 'object'`: an object or an array.
func isObjectLike(raw json.RawMessage, present bool) bool {
	kind := jsKind(raw)
	return present && (kind == "object" || kind == "array")
}

func mustQuote(s string) json.RawMessage {
	var b bytes.Buffer
	enc := json.NewEncoder(&b)
	enc.SetEscapeHTML(false)
	_ = enc.Encode(s)
	return bytes.TrimSpace(b.Bytes())
}

// isLink reports whether a mode is a link the Node updater sees as one: a symbolic link, or on
// Windows any other reparse point such as a junction, which libuv reports as a link and Go 1.23+
// reports as ModeIrregular without ModeDir ($GOROOT/src/os/types_windows.go).
func isLink(mode fs.FileMode) bool { return isLinkOn(mode, runtime.GOOS) }

func isLinkOn(mode fs.FileMode, goos string) bool {
	if mode&fs.ModeSymlink != 0 {
		return true
	}
	return goos == "windows" && mode&fs.ModeIrregular != 0
}

// hasLoneSurrogateEscape reports a \uD800-\uDFFF escape in a JSON text that is not a high surrogate
// immediately followed by a low one. data is valid JSON, so every backslash starts an escape.
func hasLoneSurrogateEscape(data []byte) bool {
	unit := func(i int) (rune, bool) {
		if i+6 > len(data) || data[i] != '\\' || data[i+1] != 'u' {
			return 0, false
		}
		var r rune
		for _, c := range data[i+2 : i+6] {
			switch {
			case c >= '0' && c <= '9':
				r = r<<4 | rune(c-'0')
			case c >= 'a' && c <= 'f':
				r = r<<4 | rune(c-'a'+10)
			case c >= 'A' && c <= 'F':
				r = r<<4 | rune(c-'A'+10)
			default:
				return 0, false
			}
		}
		return r, true
	}
	for i := 0; i < len(data); i++ {
		if data[i] != '\\' {
			continue
		}
		r, ok := unit(i)
		if !ok {
			i++ // a two-character escape such as \\ or \"
			continue
		}
		switch {
		case r >= 0xD800 && r <= 0xDBFF:
			if low, ok := unit(i + 6); ok && low >= 0xDC00 && low <= 0xDFFF {
				i += 11
				continue
			}
			return true
		case r >= 0xDC00 && r <= 0xDFFF:
			return true
		}
		i += 5
	}
	return false
}
