package desktopupdate

import (
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"runtime"
	"slices"
	"strconv"
	"strings"
)

const (
	pointerName    = "current.json"
	installName    = "install.json"
	lockName       = "update.lock"
	journalName    = "update-journal.json"
	logName        = "update.log"
	firstStartName = "first-start.json"
	versionsDir    = "versions"
	manifestName   = "release.json"
	signatureName  = "release.sig"
	metadataName   = "metadata.json"
	entryName      = "start.mjs"
	// entryOverhead is the room counted per file or folder of the state on top of its bytes.
	entryOverhead = 4096
)

var semver = regexp.MustCompile(`^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+[0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*)?$`)

func isVersion(v string) bool { return semver.MatchString(v) }

// pointer is current.json.
type pointer struct {
	Format  int    `json:"format"`
	Version string `json:"version"`
	Path    string `json:"path"`
	Adopted bool   `json:"adopted"`
}

// Current is the installed version: its directory, and whether it is an adopted plain package.
type Current struct {
	Version string
	Dir     string
	Adopted bool
}

func pointerDir(root, p string) string {
	if filepath.IsAbs(p) {
		return p
	}
	return filepath.Join(append([]string{root}, strings.Split(p, "/")...)...)
}

// ReadCurrent returns the current version, or nil when nothing is installed.
func ReadCurrent(root string) (*Current, error) {
	root, err := filepath.Abs(root)
	if err != nil {
		return nil, err
	}
	var raw map[string]any
	found, err := readJSON(filepath.Join(root, pointerName), &raw)
	if err != nil || !found {
		return nil, err
	}
	version, _ := raw["version"].(string)
	p, isString := raw["path"].(string)
	if !isVersion(version) || !isString {
		return nil, newError(CodeCorrupt, "%s is invalid", pointerName)
	}
	adopted, _ := raw["adopted"].(bool)
	return &Current{Version: version, Dir: pointerDir(root, p), Adopted: adopted}, nil
}

func writePointer(root, version, p string, adopted bool) error {
	return writeJSONAtomic(filepath.Join(root, pointerName), pointer{Format: 1, Version: version, Path: p, Adopted: adopted})
}

// Inspection is the result of InspectInstall.
type Inspection struct {
	Current
	Complete bool
	Reason   string
}

type manifestLists struct {
	Version     string            `json:"version"`
	Files       map[string]string `json:"files"`
	Links       map[string]string `json:"links"`
	Directories []string          `json:"directories"`
}

func metadataVersion(dir string) string {
	var metadata struct {
		Version string `json:"version"`
	}
	if found, err := readJSON(filepath.Join(dir, metadataName), &metadata); err != nil || !found {
		return ""
	}
	return metadata.Version
}

// InspectInstall re-checks the current version: metadata, entry and, for managed copies, every
// signed hash, link and folder.
func InspectInstall(root string) (Inspection, error) {
	current, err := ReadCurrent(root)
	if err != nil {
		return Inspection{}, err
	}
	if current == nil {
		return Inspection{Reason: "nothing installed"}, nil
	}
	reason, err := inspect(current)
	if err != nil {
		return Inspection{}, err
	}
	return Inspection{Current: *current, Complete: reason == "", Reason: reason}, nil
}

func inspect(current *Current) (string, error) {
	if metadataVersion(current.Dir) != current.Version {
		return "metadata.json does not match", nil
	}
	if ok, err := pathExists(filepath.Join(current.Dir, entryName)); err != nil || !ok {
		return entryName + " is missing", err
	}
	if current.Adopted {
		return "", nil
	}
	var manifest manifestLists
	if found, err := readJSON(filepath.Join(current.Dir, manifestName), &manifest); err != nil || !found || manifest.Version != current.Version {
		return manifestName + " is missing", nil //nolint:nilerr // an unreadable manifest is a reason, as in Node
	}
	scan, err := scanTree(current.Dir)
	if err != nil {
		return "", err
	}
	expected := append(sortedKeys(manifest.Files), manifestName, signatureName)
	slices.Sort(expected)
	if !slices.Equal(sortedKeys(scan.files), expected) {
		return "the file list differs from the release", nil
	}
	for _, rel := range sortedKeys(manifest.Files) {
		hash, err := hashFile(scan.files[rel])
		if err != nil {
			return "", err
		}
		if hash != manifest.Files[rel] {
			return rel + " differs", nil
		}
	}
	if !slices.Equal(sortedKeys(scan.links), sortedKeys(manifest.Links)) {
		return "the links differ from the release", nil
	}
	if runtime.GOOS != "windows" {
		for _, rel := range sortedKeys(manifest.Links) {
			if target, err := os.Readlink(scan.links[rel]); err != nil || target != manifest.Links[rel] {
				return "link " + rel + " differs", nil //nolint:nilerr // reported as a reason
			}
		}
	}
	for _, directory := range manifest.Directories {
		if ok, err := pathExists(filepath.Join(append([]string{current.Dir}, strings.Split(directory, "/")...)...)); err != nil || !ok {
			return directory + " is missing", err
		}
	}
	return "", nil
}

// installFile is install.json.
type installFile struct {
	Format   int    `json:"format"`
	StateDir string `json:"stateDir"`
}

// ReadStateDir returns the absolute state folder recorded at install or adoption.
func ReadStateDir(root string) (string, error) {
	root, err := filepath.Abs(root)
	if err != nil {
		return "", err
	}
	return stateDirOf(root)
}

func stateDirOf(root string) (string, error) {
	var config struct {
		StateDir any `json:"stateDir"`
	}
	found, err := readJSON(filepath.Join(root, installName), &config)
	if err != nil {
		return "", err
	}
	dir, ok := config.StateDir.(string)
	if !found || !ok || !filepath.IsAbs(dir) {
		return "", newError(CodeCorrupt, "%s is missing or invalid", installName)
	}
	return dir, nil
}

// canonicalState is the real path of a state folder: a link (or Windows junction) is resolved,
// so the pre-update copy holds the data and not a second way into the live folder. A folder not
// created yet is resolved through its parent.
func canonicalState(stateDir string) (string, error) {
	resolved, err := realPath(stateDir)
	if err == nil {
		return resolved, nil
	}
	if !errors.Is(err, fs.ErrNotExist) {
		return "", err
	}
	parent, err := realPath(filepath.Dir(stateDir))
	if err == nil {
		return filepath.Join(parent, filepath.Base(stateDir)), nil
	}
	if !errors.Is(err, fs.ErrNotExist) {
		return "", err
	}
	return stateDir, nil
}

func checkStateDir(root, stateDir string) error {
	if !filepath.IsAbs(stateDir) {
		return refuse("The state folder must be an absolute path")
	}
	if inside(filepath.Join(root, versionsDir), stateDir) || inside(stateDir, root) {
		return refuse("The state folder must be outside the install root versions and must not contain it")
	}
	return nil
}

func recordStateDir(root, stateDir string) error {
	if err := checkStateDir(root, stateDir); err != nil {
		return err
	}
	var existing installFile
	found, err := readJSON(filepath.Join(root, installName), &existing)
	if err != nil {
		return err
	}
	if found && existing.StateDir != stateDir {
		return refuse("This install already uses the state folder %s", existing.StateDir)
	}
	if found {
		return nil
	}
	return writeJSONAtomic(filepath.Join(root, installName), installFile{Format: 1, StateDir: stateDir})
}

// Disk is the free room a file system reports: available blocks and their size.
type Disk struct {
	Avail     uint64
	BlockSize uint64
}

// checkStateRoom refuses a state folder that cannot be copied faithfully (a link, or a link or
// special file inside) and an update without room beside it for the copies it takes: the
// pre-update copy, one restore and, for an adopted install, the rehearsal copy. Nothing is written.
func checkStateRoom(stateDir string, copies uint64, statfs func(string) (Disk, error)) error {
	info, err := os.Lstat(stateDir)
	if errors.Is(err, fs.ErrNotExist) {
		return refuse("The state folder does not exist: %s", stateDir)
	}
	if err != nil {
		return err
	}
	if isLink(info.Mode()) {
		return refuse("The state folder %s is a link; record the real folder instead", stateDir)
	}
	if !info.IsDir() {
		return refuse("The state folder is not a folder: %s", stateDir)
	}
	if pid, ok := runningCluster(stateDir); ok {
		return refuse("PostgreSQL is still running on %s (process %d): close SIPGES so it stops, then try again; a copy of a running database can be incomplete", filepath.Join(stateDir, clusterDir), pid)
	}
	var bytes, entries uint64 = 0, 1
	var walk func(dir, prefix string) error
	walk = func(dir, prefix string) error {
		list, err := os.ReadDir(dir)
		if err != nil {
			return err
		}
		for _, entry := range list {
			rel := path.Join(prefix, entry.Name())
			full := filepath.Join(dir, entry.Name())
			entries++
			mode := entry.Type()
			switch {
			case mode.IsDir() && !isLink(mode):
				if err := walk(full, rel); err != nil {
					return err
				}
			case mode.IsRegular():
				info, err := os.Lstat(full)
				if err != nil {
					return err
				}
				bytes += uint64(info.Size()) //nolint:gosec // a size is never negative
			default:
				return refuse("The state folder holds a link or special file (%s); it cannot be copied safely", rel)
			}
		}
		return nil
	}
	if err := walk(stateDir, ""); err != nil {
		return err
	}
	needed := copies * (bytes + entries*entryOverhead)
	disk, err := statfs(filepath.Dir(stateDir))
	if err != nil {
		return err
	}
	free := disk.Avail * disk.BlockSize
	if free < needed {
		return refuse("Not enough free disk beside the state folder for the pre-update copy and one restore: %d bytes needed, %d free", needed, free)
	}
	return nil
}

// refuseLinkedState refuses a state folder given as a link or junction, before anything is
// created: it would be recorded as its target, and the first start would migrate that one in
// place. A folder under a linked parent is still accepted.
func refuseLinkedState(stateDir string) error {
	if !filepath.IsAbs(stateDir) {
		return nil // checkStateDir refuses it
	}
	info, err := os.Lstat(filepath.Clean(stateDir))
	if errors.Is(err, fs.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	if isLink(info.Mode()) {
		return refuse("The state folder %s is a link or junction: pass the real folder of the copy, never a link to it", stateDir)
	}
	return nil
}

func versionPath(version string) string { return fmt.Sprintf("%s/%s", versionsDir, version) }

// clusterDir is the PostgreSQL data folder inside the state folder (ADR 0036 §3).
const clusterDir = "pg18"

// runningCluster reports the live process named on the first line of <state>/pg18/postmaster.pid.
// A file left by a server that crashed names a process that no longer exists and does not count.
func runningCluster(stateDir string) (int, bool) {
	data, err := os.ReadFile(filepath.Join(stateDir, clusterDir, "postmaster.pid")) //nolint:gosec // inside the recorded state folder
	if err != nil {
		return 0, false
	}
	first, _, _ := strings.Cut(string(data), "\n")
	pid, err := strconv.Atoi(strings.TrimSpace(first))
	if err != nil || pid <= 0 {
		return 0, false
	}
	return pid, alive(pid)
}
