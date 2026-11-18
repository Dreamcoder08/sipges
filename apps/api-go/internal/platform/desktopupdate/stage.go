package desktopupdate

import (
	"errors"
	"io/fs"
	"os"
	"path"
	"path/filepath"
	"slices"
	"strings"
	"time"
)

func compareLists(found, expected []string) error {
	wanted := map[string]bool{}
	for _, p := range expected {
		wanted[p] = true
	}
	present := map[string]bool{}
	sortedFound := slices.Sorted(slices.Values(found))
	for _, p := range sortedFound {
		present[p] = true
		if !wanted[p] {
			return refuse("The release package does not match its manifest: unlisted %s", p)
		}
	}
	for _, p := range slices.Sorted(slices.Values(expected)) {
		if !present[p] {
			return refuse("The release package does not match its manifest: missing %s", p)
		}
	}
	return nil
}

// checkPackageLists checks that the package's file, link and folder lists equal the signed ones.
func checkPackageLists(source string, release Release) (tree, error) {
	info, err := os.Lstat(source)
	if errors.Is(err, fs.ErrNotExist) {
		return tree{}, refuse("The release has no package folder")
	}
	if err != nil {
		return tree{}, err
	}
	if !info.IsDir() || isLink(info.Mode()) {
		return tree{}, refuse("The release package is not a folder")
	}
	scan, err := scanTree(source)
	if err != nil {
		return tree{}, err
	}
	if err := compareLists(sortedKeys(scan.files), sortedKeys(release.Files)); err != nil {
		return tree{}, err
	}
	if err := compareLists(sortedKeys(scan.links), sortedKeys(release.Links)); err != nil {
		return tree{}, err
	}
	if err := compareLists(scan.directories, release.Directories); err != nil {
		return tree{}, err
	}
	return scan, nil
}

// checkMetadata refuses a package whose metadata.json names another version than the signed one.
func checkMetadata(dir, version string) error {
	if got := metadataVersion(dir); got != version {
		if got == "" {
			got = "nothing"
		}
		return refuse("metadata.json says %s but the signed release is %s", got, version)
	}
	return nil
}

type staged struct{ staging, final string }

func osPath(base, rel string) string {
	return filepath.Join(append([]string{base}, strings.Split(rel, "/")...)...)
}

// stage copies exactly the signed files into a staging folder, hashing the copy, not the source.
func stage(root string, release Release) (result staged, err error) {
	versions := filepath.Join(root, versionsDir)
	if err := os.MkdirAll(versions, 0o700); err != nil {
		return staged{}, err
	}
	result = staged{
		staging: filepath.Join(versions, ".staging-"+newUUID()),
		final:   filepath.Join(versions, release.Version),
	}
	defer func() {
		if err != nil {
			_ = os.RemoveAll(result.staging)
			result = staged{}
		}
	}()
	scan, err := checkPackageLists(release.PackageDir, release)
	if err != nil {
		return result, err
	}
	if err := os.Mkdir(result.staging, 0o700); err != nil {
		return result, err
	}
	for _, directory := range release.Directories {
		if err := os.MkdirAll(osPath(result.staging, directory), 0o755); err != nil { //nolint:gosec // program folders
			return result, err
		}
	}
	for _, rel := range sortedKeys(release.Files) {
		target := osPath(result.staging, rel)
		info, err := os.Stat(scan.files[rel])
		if err != nil {
			return result, err
		}
		if err := copyFile(scan.files[rel], target, info); err != nil {
			return result, err
		}
		hash, err := hashFile(target)
		if err != nil {
			return result, err
		}
		if hash != release.Files[rel] {
			return result, refuse("File does not match the signed release: %s", rel)
		}
	}
	for _, rel := range sortedKeys(release.Links) {
		target := release.Links[rel]
		resolved := path.Clean(path.Join(path.Dir(rel), target))
		if err := makeDirLink(filepath.FromSlash(target), osPath(result.final, resolved), osPath(result.staging, rel)); err != nil {
			return result, err
		}
	}
	if err := checkMetadata(result.staging, release.Version); err != nil {
		return result, err
	}
	if err := writeFileNew(filepath.Join(result.staging, manifestName), release.Manifest, false); err != nil {
		return result, err
	}
	if err := writeFileNew(filepath.Join(result.staging, signatureName), release.Signature, false); err != nil {
		return result, err
	}
	return result, nil
}

// commitStaging moves the staging folder to its version name. A leftover from an earlier failed
// attempt is kept aside for diagnosis, never deleted.
func commitStaging(s staged, now time.Time) error {
	if taken, err := pathExists(s.final); err != nil {
		return err
	} else if taken {
		aside, err := freeName(s.final + ".superseded-" + stamp(now))
		if err != nil {
			return err
		}
		if err := RenameRetry(s.final, aside); err != nil {
			return err
		}
	}
	return RenameRetry(s.staging, s.final)
}
