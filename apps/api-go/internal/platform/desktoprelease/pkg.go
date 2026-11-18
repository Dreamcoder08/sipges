package desktoprelease

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"strconv"
	"sync"
)

// hashConcurrency is how many files are hashed at once (updater.mjs HASH_CONCURRENCY).
const hashConcurrency = 16

// Scan is a package tree listed without following links, by POSIX path.
type Scan struct {
	Files       map[string]string // relative path -> path on disk
	Links       map[string]string // relative path -> path on disk
	Directories []string
}

// ScanTree lists a tree without following links (release.mjs scanTree). A device, pipe or socket
// is refused.
func ScanTree(root string) (*Scan, error) {
	scan := &Scan{Files: map[string]string{}, Links: map[string]string{}}
	var walk func(dir, prefix string) error
	walk = func(dir, prefix string) error {
		entries, err := os.ReadDir(dir)
		if err != nil {
			return err
		}
		for _, entry := range entries {
			rel := entry.Name()
			if prefix != "" {
				rel = prefix + "/" + rel
			}
			full := filepath.Join(dir, entry.Name())
			mode := entry.Type()
			switch {
			case isLink(mode):
				scan.Links[rel] = full
			case mode.IsDir():
				scan.Directories = append(scan.Directories, rel)
				if err := walk(full, rel); err != nil {
					return err
				}
			case mode.IsRegular():
				scan.Files[rel] = full
			default:
				return refuse(KindUnsupportedFile, "Unsupported file type in package: %s", rel)
			}
		}
		return nil
	}
	if err := walk(root, ""); err != nil {
		return nil, err
	}
	return scan, nil
}

// compareLists refuses the first unlisted entry, then the first missing one, each in sorted order.
func compareLists(found, expected []string) error {
	wanted := map[string]bool{}
	for _, p := range expected {
		wanted[p] = true
	}
	actual := append([]string(nil), found...)
	sortUTF16(actual)
	for _, p := range actual {
		if !wanted[p] {
			return refuse(KindPackageMismatch, "The release package does not match its manifest: unlisted %s", p)
		}
	}
	present := map[string]bool{}
	for _, p := range found {
		present[p] = true
	}
	want := append([]string(nil), expected...)
	sortUTF16(want)
	for _, p := range want {
		if !present[p] {
			return refuse(KindPackageMismatch, "The release package does not match its manifest: missing %s", p)
		}
	}
	return nil
}

func keys(m map[string]string) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	return out
}

// CheckPackageLists checks that a package folder's files, links and folders are exactly the
// signed ones (updater.mjs checkPackageLists) and returns its scan.
func CheckPackageLists(source string, m *Manifest) (*Scan, error) {
	info, err := os.Lstat(source)
	if errors.Is(err, fs.ErrNotExist) {
		return nil, refuse(KindPackageMissing, "The release has no package folder")
	}
	if err != nil {
		return nil, err
	}
	if !info.IsDir() || isLink(info.Mode()) {
		return nil, refuse(KindPackageMissing, "The release package is not a folder")
	}
	scan, err := ScanTree(source)
	if err != nil {
		return nil, err
	}
	if err := compareLists(keys(scan.Files), m.FileOrder); err != nil {
		return nil, err
	}
	if err := compareLists(keys(scan.Links), m.LinkOrder); err != nil {
		return nil, err
	}
	if err := compareLists(scan.Directories, m.Directories); err != nil {
		return nil, err
	}
	return scan, nil
}

// CheckMetadata checks that the package's metadata.json names the signed version (updater.mjs
// checkMetadata).
func CheckMetadata(dir string, m *Manifest) error {
	says := "nothing"
	matches := false
	data, err := os.ReadFile(filepath.Join(dir, "metadata.json")) //nolint:gosec // a path inside the package being verified
	if err == nil && json.Valid(data) && jsKind(data) == "object" {
		if obj, err := parseObject(data); err == nil {
			if raw, ok := obj.get("version"); ok && jsKind(raw) != "null" {
				if s, ok := jsString(raw); ok {
					says, matches = s, s == m.Version
				} else if f, ok := jsNumberValue(raw); ok {
					says = strconv.FormatFloat(f, 'g', -1, 64)
				} else {
					says = jsStringify(raw)
				}
			}
		}
	}
	if !matches {
		return refuse(KindMetadata, "metadata.json says %s but the signed release is %s", says, m.Version)
	}
	return nil
}

// HashFile is the SHA-256 of a file in hex.
func HashFile(name string) (string, error) {
	f, err := os.Open(name) //nolint:gosec // a path inside the package being verified
	if err != nil {
		return "", err
	}
	defer f.Close() //nolint:errcheck // read-only
	h := sha256.New()
	if _, err := io.Copy(h, f); err != nil {
		return "", err
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}

// CheckPackage hashes every file of releaseDir/package in place against the signed list, nothing
// copied, then checks metadata.json (updater.mjs checkPackage). Files are hashed in batches of
// sixteen in manifest order; the first mismatch in manifest order of a batch is reported.
func CheckPackage(releaseDir string, m *Manifest) error {
	source := filepath.Join(releaseDir, PackageDir)
	scan, err := CheckPackageLists(source, m)
	if err != nil {
		return err
	}
	for start := 0; start < len(m.FileOrder); start += hashConcurrency {
		batch := m.FileOrder[start:min(start+hashConcurrency, len(m.FileOrder))]
		results := make([]error, len(batch))
		var wg sync.WaitGroup
		for i, rel := range batch {
			wg.Add(1)
			go func() {
				defer wg.Done()
				sum, err := HashFile(scan.Files[rel])
				switch {
				case err != nil:
					results[i] = err
				case sum != m.Files[rel]:
					results[i] = refuse(KindFileHash, "File does not match the signed release: %s", rel)
				}
			}()
		}
		wg.Wait()
		for _, err := range results {
			if err != nil {
				return err
			}
		}
	}
	return CheckMetadata(source, m)
}
