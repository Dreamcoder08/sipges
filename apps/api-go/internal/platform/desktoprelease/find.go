package desktoprelease

import (
	"crypto/ed25519"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
)

// Current is the installed version current.json points to.
type Current struct {
	Version string
	Dir     string // the version's folder, absolute
	Adopted bool   // an old plain install adopted in place
}

// ReadCurrent reads an install root's current.json (updater.mjs readCurrent). It returns nil
// when nothing is installed, a CORRUPT *Error when the pointer is invalid, and any other error
// when the file cannot be read or is not JSON.
func ReadCurrent(root string) (*Current, error) {
	root, err := filepath.Abs(root)
	if err != nil {
		return nil, err
	}
	data, err := os.ReadFile(filepath.Join(root, PointerName)) //nolint:gosec // the install root's own pointer
	if errors.Is(err, fs.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	if !json.Valid(data) {
		return nil, fmt.Errorf("%s is not JSON", PointerName)
	}
	if !jsTruthy(data, true) {
		return nil, nil
	}
	invalid := corrupt(KindPointer, PointerName+" is invalid")
	if jsKind(data) != "object" {
		return nil, invalid
	}
	pointer, err := parseObject(data)
	if err != nil {
		return nil, invalid
	}
	version, ok := jsString(pointer.values["version"])
	if !ok || !IsVersion(version) {
		return nil, invalid
	}
	p, ok := jsString(pointer.values["path"])
	if !ok {
		return nil, invalid
	}
	adopted, _ := pointer.get("adopted")
	return &Current{
		Version: version,
		Dir:     pointerDir(root, p),
		Adopted: jsKind(adopted) == "boolean" && jsTruthy(adopted, true),
	}, nil
}

// pointerDir resolves the pointer's path: absolute as written, or POSIX-relative to the root.
func pointerDir(root, p string) string {
	if nodeIsAbsolute(p) {
		return p
	}
	return filepath.Join(append([]string{root}, strings.Split(p, "/")...)...)
}

// nodeIsAbsolute is Node's path.isAbsolute on this platform: on Windows a leading slash or
// backslash, or a drive letter followed by one.
func nodeIsAbsolute(p string) bool {
	if runtime.GOOS != "windows" {
		return strings.HasPrefix(p, "/")
	}
	if strings.HasPrefix(p, "/") || strings.HasPrefix(p, `\`) {
		return true
	}
	return len(p) >= 3 && p[1] == ':' && (p[2] == '/' || p[2] == '\\') &&
		((p[0] >= 'a' && p[0] <= 'z') || (p[0] >= 'A' && p[0] <= 'Z'))
}

func exists(name string) (bool, error) {
	_, err := os.Lstat(name)
	if errors.Is(err, fs.ErrNotExist) {
		return false, nil
	}
	return err == nil, err
}

// TrustedKey is the update key the installed version ships (updater.mjs trustedKey without
// --trust-key): an install without one has updates disabled.
func TrustedKey(versionDir string) (ed25519.PublicKey, error) {
	name := filepath.Join(versionDir, PublicKeyName)
	found, err := exists(name)
	if err != nil {
		return nil, err
	}
	if !found {
		return nil, refuse(KindUpdatesDisabled, "Updates are disabled: the installed version has no update key")
	}
	data, err := os.ReadFile(name) //nolint:gosec // the installed version's own key file
	if err != nil {
		return nil, err
	}
	return LoadPublicKey(data)
}

// Available is the release FindUpdate offers.
type Available struct {
	Version string
	Notes   *string
	Release string // the release folder
}

// Skipped is a release FindUpdate examined and refused, with the refusal message.
type Skipped struct {
	Release string
	Reason  string
}

// Found is FindUpdate's answer: the installed version, the release to offer (nil when none) and
// the releases refused on the way.
type Found struct {
	Installed string
	Available *Available
	Skipped   []Skipped
}

// FindUpdate returns the newest release in source that an update would accept, verified the
// same way (signature with the installed key, newer version, minimum previous, platform, every
// file hash and the package version) without copying anything (updater.mjs findUpdate). source
// is one release folder or a folder of them. Signed manifests are checked first; packages are
// then hashed newest first and the search stops at the first that verifies. An install without
// an update key is refused as a whole.
func FindUpdate(root, source string, host Platform) (*Found, error) {
	root, err := filepath.Abs(root)
	if err != nil {
		return nil, err
	}
	if source, err = filepath.Abs(source); err != nil {
		return nil, err
	}
	current, err := ReadCurrent(root)
	if err != nil {
		return nil, err
	}
	if current == nil {
		return nil, corrupt(KindNotInstalled, "No installed version here")
	}
	key, err := TrustedKey(current.Dir)
	if err != nil {
		return nil, err
	}
	candidates, err := releaseCandidates(source)
	if err != nil {
		return nil, err
	}
	found := &Found{Installed: current.Version, Skipped: []Skipped{}}
	type signedRelease struct {
		dir      string
		manifest *Manifest
	}
	var signed []signedRelease
	for _, dir := range candidates {
		rel, err := ReadRelease(dir, key)
		if err == nil {
			err = CheckTarget(current, rel.Manifest, host)
		}
		if err != nil {
			if !IsRefused(err) {
				return nil, err
			}
			found.Skipped = append(found.Skipped, Skipped{Release: dir, Reason: err.Error()})
			continue
		}
		signed = append(signed, signedRelease{dir, rel.Manifest})
	}
	// Newest first; the same version in two folders is tried in name order.
	sort.SliceStable(signed, func(i, j int) bool {
		if c := CompareVersions(signed[i].manifest.Version, signed[j].manifest.Version); c != 0 {
			return c > 0
		}
		return utf16Less(signed[i].dir, signed[j].dir)
	})
	for _, s := range signed {
		if err := CheckPackage(s.dir, s.manifest); err != nil {
			if !IsRefused(err) {
				return nil, err
			}
			found.Skipped = append(found.Skipped, Skipped{Release: s.dir, Reason: err.Error()})
			continue
		}
		found.Available = &Available{Version: s.manifest.Version, Notes: s.manifest.Notes, Release: s.dir}
		return found, nil
	}
	return found, nil
}

// releaseCandidates is source itself when it holds a release.json, otherwise its real folders
// (not links or junctions) in name order.
func releaseCandidates(source string) ([]string, error) {
	single, err := exists(filepath.Join(source, ManifestName))
	if err != nil {
		return nil, err
	}
	if single {
		return []string{source}, nil
	}
	entries, err := os.ReadDir(source)
	if err != nil {
		return nil, err
	}
	var dirs []string
	for _, e := range entries {
		if e.IsDir() && !isLink(e.Type()) {
			dirs = append(dirs, filepath.Join(source, e.Name()))
		}
	}
	sortUTF16(dirs)
	return dirs, nil
}
