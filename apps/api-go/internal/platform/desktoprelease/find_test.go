package desktoprelease

import (
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

type finder struct {
	root, source string
	key          ed25519.PrivateKey
}

// newFinder installs 1.0.0 trusting a fresh key, with an empty folder of releases.
func newFinder(t *testing.T) *finder {
	t.Helper()
	dir := t.TempDir()
	f := &finder{root: filepath.Join(dir, "install"), source: filepath.Join(dir, "releases"), key: newKey(t)}
	installed(t, f.root, "1.0.0", publicPEM(t, f.key.Public().(ed25519.PublicKey)))
	mkdirAll(t, f.source)
	return f
}

func (f *finder) release(t *testing.T, version string) string {
	t.Helper()
	return signedRelease(t, filepath.Join(f.source, "release-"+version), f.key, version)
}

// The golden release, signed by release.mjs, found through FindUpdate by an install that trusts
// its key, with its signed notes.
func TestFindUpdateOffersTheGoldenRelease(t *testing.T) {
	dir := t.TempDir()
	root := filepath.Join(dir, "install")
	installed(t, root, "1.0.0", goldenKeyPEM(t))
	release := copyGolden(t, filepath.Join(dir, "releases", "golden"))
	found, err := FindUpdate(root, filepath.Join(dir, "releases"), testHost)
	if err != nil {
		t.Fatal(err)
	}
	want := &Available{Version: "1.1.0", Notes: strp("Corrige el filtro.\nNuevo resumen: año ✓."), Release: release}
	if found.Installed != "1.0.0" || !reflect.DeepEqual(found.Available, want) || len(found.Skipped) != 0 {
		t.Fatalf("found %+v / %+v", found, found.Available)
	}
	// One release directory given directly works the same.
	found, err = FindUpdate(root, release, testHost)
	if err != nil || !reflect.DeepEqual(found.Available, want) {
		t.Fatalf("found %+v, %v", found, err)
	}
	// An install whose minimum previous is not met skips it.
	installed(t, filepath.Join(dir, "old"), "0.9.0", goldenKeyPEM(t))
	found, err = FindUpdate(filepath.Join(dir, "old"), release, testHost)
	if err != nil || found.Available != nil {
		t.Fatalf("found %+v, %v", found, err)
	}
	wantSkipped(t, found, [][2]string{{release, "Version 1.1.0 requires at least 1.0.0 installed; found 0.9.0"}})
}

// launcher.test.mjs "the check tries the newest release first and stops at the first that
// verifies".
func TestFindUpdateTriesTheNewestFirst(t *testing.T) {
	f := newFinder(t)
	oldest := f.release(t, "1.1.0")
	middle := f.release(t, "1.2.0")
	newest := f.release(t, "1.3.0")
	put(t, filepath.Join(oldest, "package", "start.mjs"), "// changed after signing\n")
	put(t, filepath.Join(newest, "package", "start.mjs"), "// changed after signing\n")
	found, err := FindUpdate(f.root, f.source, testHost)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(found.Available, &Available{Version: "1.2.0", Release: middle}) {
		t.Fatalf("available %+v", found.Available)
	}
	wantSkipped(t, found, [][2]string{{newest, "File does not match the signed release: start.mjs"}})
}

// updater.mjs findUpdate: signatures and targets are checked for every candidate first (skipped
// in folder order), then packages newest first; the same version in two folders is tried in name
// order; folder links and loose files are not candidates.
func TestFindUpdateOrderAndSkips(t *testing.T) {
	f := newFinder(t)
	f.release(t, "1.0.0")
	foreign := signedRelease(t, filepath.Join(f.source, "release-foreign"), newKey(t), "9.0.0")
	twinB := signedRelease(t, filepath.Join(f.source, "twin-b"), f.key, "1.5.0")
	twinA := signedRelease(t, filepath.Join(f.source, "twin-a"), f.key, "1.5.0")
	put(t, filepath.Join(twinA, "package", "web", "index.html"), "changed\n")
	put(t, filepath.Join(f.source, "notes.txt"), "not a release\n")
	if err := os.Symlink(twinB, filepath.Join(f.source, "z-link")); err != nil {
		t.Fatal(err)
	}
	found, err := FindUpdate(f.root, f.source, testHost)
	if err != nil {
		t.Fatal(err)
	}
	if found.Available == nil || found.Available.Release != twinB {
		t.Fatalf("available %+v", found.Available)
	}
	wantSkipped(t, found, [][2]string{
		{filepath.Join(f.source, "release-1.0.0"), "Version 1.0.0 is not newer than the installed 1.0.0"},
		{foreign, "The release signature does not match the trusted update key"},
		{twinA, "File does not match the signed release: web/index.html"},
	})
}

// updater.test.mjs "rule 1: a signed release whose metadata.json names another version is
// refused".
func TestFindUpdateRefusesAMetadataVersionMismatch(t *testing.T) {
	f := newFinder(t)
	release := f.release(t, "1.1.0")
	meta := filepath.Join(release, "package", "metadata.json")
	put(t, meta, "{\n  \"version\": \"1.2.0\"\n}\n")
	sum := sha256.Sum256(mustRead(t, meta))
	resign(t, release, f.key, func(m map[string]any) {
		m["files"].(map[string]any)["metadata.json"] = hex.EncodeToString(sum[:])
	})
	found, err := FindUpdate(f.root, release, testHost)
	if err != nil || found.Available != nil {
		t.Fatalf("found %+v, %v", found, err)
	}
	wantSkipped(t, found, [][2]string{{release, "metadata.json says 1.2.0 but the signed release is 1.1.0"}})
	err = CheckPackage(release, mustManifest(t, release, f.key))
	wantRefused(t, err, KindMetadata, "metadata.json says 1.2.0 but the signed release is 1.1.0")
	for content, says := range map[string]string{"not json": "nothing", "{}": "nothing", `{"version":null}`: "nothing", `{"version":7}`: "7"} {
		put(t, meta, content)
		err = CheckMetadata(filepath.Join(release, "package"), &Manifest{Version: "1.1.0"})
		wantRefused(t, err, KindMetadata, "metadata.json says "+says+" but the signed release is 1.1.0")
	}
}

// verifier-launcher.test.mjs "D4: a newer release with <damage> is never offered; the older intact
// one is", and nothing in the install or the releases changes while looking.
func TestFindUpdateNeverOffersADamagedPackage(t *testing.T) {
	cases := []struct {
		name   string
		damage func(t *testing.T, pkg, dir string)
		kind   Kind
		reason string
	}{
		{"a same-size change in one file", func(t *testing.T, pkg, _ string) {
			put(t, filepath.Join(pkg, "web/index.html"), "<!doctype html><title>SIPGES 9.9.9</title>\n")
		}, KindFileHash, "File does not match the signed release: web/index.html"},
		{"an unlisted file", func(t *testing.T, pkg, _ string) {
			put(t, filepath.Join(pkg, "extra.js"), "x")
		}, KindPackageMismatch, "The release package does not match its manifest: unlisted extra.js"},
		{"a missing file", func(t *testing.T, pkg, _ string) {
			mustRemove(t, filepath.Join(pkg, "api/src/main.js"))
		}, KindPackageMismatch, "The release package does not match its manifest: missing api/src/main.js"},
		{"an unlisted empty folder", func(t *testing.T, pkg, _ string) {
			mkdirAll(t, filepath.Join(pkg, "extra-dir"))
		}, KindPackageMismatch, "The release package does not match its manifest: unlisted extra-dir"},
		{"a missing empty folder", func(t *testing.T, pkg, _ string) {
			mustRemove(t, filepath.Join(pkg, "references"))
		}, KindPackageMismatch, "The release package does not match its manifest: missing references"},
		{"a link replaced by a real folder", func(t *testing.T, pkg, _ string) {
			mustRemove(t, filepath.Join(pkg, "api/node_modules/dep"))
			put(t, filepath.Join(pkg, "api/node_modules/dep/index.js"), "export {};\n")
		}, KindPackageMismatch, "The release package does not match its manifest: unlisted api/node_modules/dep/index.js"},
		{"a file replaced by a link to an identical file", func(t *testing.T, pkg, dir string) {
			put(t, filepath.Join(dir, "same.js"), string(mustRead(t, filepath.Join(pkg, "api/src/main.js"))))
			mustRemove(t, filepath.Join(pkg, "api/src/main.js"))
			if err := os.Symlink(filepath.Join(dir, "same.js"), filepath.Join(pkg, "api/src/main.js")); err != nil {
				t.Fatal(err)
			}
		}, KindPackageMismatch, "The release package does not match its manifest: missing api/src/main.js"},
		{"a package folder that is a link to an identical package", func(t *testing.T, pkg, dir string) {
			if err := os.Rename(pkg, filepath.Join(dir, "moved")); err != nil {
				t.Fatal(err)
			}
			if err := os.Symlink(filepath.Join(dir, "moved"), pkg); err != nil {
				t.Fatal(err)
			}
		}, KindPackageMissing, "The release package is not a folder"},
		{"no package folder", func(t *testing.T, pkg, _ string) {
			mustRemove(t, pkg)
		}, KindPackageMissing, "The release has no package folder"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			f := newFinder(t)
			f.release(t, "1.1.0")
			bad := f.release(t, "1.2.0")
			tc.damage(t, filepath.Join(bad, "package"), filepath.Dir(f.root))
			before := []map[string]string{snapshot(t, f.root), snapshot(t, f.source)}
			found, err := FindUpdate(f.root, f.source, testHost)
			if err != nil {
				t.Fatal(err)
			}
			if found.Available == nil || found.Available.Version != "1.1.0" {
				t.Fatalf("available %+v", found.Available)
			}
			wantSkipped(t, found, [][2]string{{bad, tc.reason}})
			if after := []map[string]string{snapshot(t, f.root), snapshot(t, f.source)}; !reflect.DeepEqual(before, after) {
				t.Fatal("FindUpdate changed the install or the releases")
			}
			wantRefused(t, CheckPackage(bad, mustManifest(t, bad, f.key)), tc.kind, tc.reason)
		})
	}
}

// verifier-launcher.test.mjs "D4 note: a source link that points elsewhere is offered": the
// verifier checks link names, not where a source link points; the install gets the signed link.
func TestFindUpdateOffersARepointedSourceLink(t *testing.T) {
	f := newFinder(t)
	release := f.release(t, "1.1.0")
	link := filepath.Join(release, "package/api/node_modules/dep")
	mustRemove(t, link)
	if err := os.Symlink(".pnpm", link); err != nil {
		t.Fatal(err)
	}
	found, err := FindUpdate(f.root, f.source, testHost)
	if err != nil || found.Available == nil || found.Available.Version != "1.1.0" {
		t.Fatalf("found %+v, %v", found, err)
	}
}

func TestFindUpdateRefusesAnInstallItCannotTrust(t *testing.T) {
	dir := t.TempDir()
	source := filepath.Join(dir, "releases")
	mkdirAll(t, source)

	_, err := FindUpdate(filepath.Join(dir, "none"), source, testHost)
	wantCorrupt(t, err, KindNotInstalled, "No installed version here")

	put(t, filepath.Join(dir, "null", "current.json"), "null")
	_, err = FindUpdate(filepath.Join(dir, "null"), source, testHost)
	wantCorrupt(t, err, KindNotInstalled, "No installed version here")

	for name, pointer := range map[string]string{
		"bad-version": `{"format":1,"version":"1.0","path":"versions/1.0"}`,
		"no-path":     `{"format":1,"version":"1.0.0"}`,
		"number":      `5`,
	} {
		put(t, filepath.Join(dir, name, "current.json"), pointer)
		_, err = FindUpdate(filepath.Join(dir, name), source, testHost)
		wantCorrupt(t, err, KindPointer, "current.json is invalid")
	}

	put(t, filepath.Join(dir, "broken", "current.json"), "{")
	if _, err = FindUpdate(filepath.Join(dir, "broken"), source, testHost); err == nil || IsRefused(err) {
		t.Fatalf("an unreadable pointer is an error, not a refusal: %v", err)
	}

	installed(t, filepath.Join(dir, "keyless"), "1.0.0", "")
	_, err = FindUpdate(filepath.Join(dir, "keyless"), source, testHost)
	wantRefused(t, err, KindUpdatesDisabled, "Updates are disabled: the installed version has no update key")

	installed(t, filepath.Join(dir, "badkey"), "1.0.0", "not a key\n")
	_, err = FindUpdate(filepath.Join(dir, "badkey"), source, testHost)
	wantRefused(t, err, KindKey, "The update key is not a valid public key")

	installed(t, filepath.Join(dir, "ok"), "1.0.0", goldenKeyPEM(t))
	if _, err = FindUpdate(filepath.Join(dir, "ok"), filepath.Join(dir, "missing"), testHost); err == nil || IsRefused(err) {
		t.Fatalf("a missing source is an error, not a refusal: %v", err)
	}
	found, err := FindUpdate(filepath.Join(dir, "ok"), source, testHost)
	if err != nil || found.Available != nil || len(found.Skipped) != 0 || found.Installed != "1.0.0" {
		t.Fatalf("found %+v, %v", found, err)
	}
}

// readCurrent resolves a relative pointer under the root and keeps an absolute one.
func TestReadCurrent(t *testing.T) {
	root := t.TempDir()
	put(t, filepath.Join(root, "current.json"), `{"format":1,"version":"1.2.3","path":"versions/1.2.3","adopted":true}`)
	current, err := ReadCurrent(root)
	if err != nil {
		t.Fatal(err)
	}
	want := &Current{Version: "1.2.3", Dir: filepath.Join(root, "versions", "1.2.3"), Adopted: true}
	if !reflect.DeepEqual(current, want) {
		t.Fatalf("current %+v", current)
	}
	elsewhere := filepath.Join(t.TempDir(), "old-install")
	put(t, filepath.Join(root, "current.json"), `{"version":"1.2.3","path":`+jsonString(elsewhere)+`,"adopted":"yes"}`)
	current, err = ReadCurrent(root)
	if err != nil || current.Dir != elsewhere || current.Adopted {
		t.Fatalf("current %+v, %v", current, err)
	}
}

func jsonString(s string) string {
	return jsonField("x", s)[4:]
}

func mustManifest(t *testing.T, release string, key ed25519.PrivateKey) *Manifest {
	t.Helper()
	rel, err := ReadRelease(release, key.Public().(ed25519.PublicKey))
	if err != nil {
		t.Fatal(err)
	}
	return rel.Manifest
}

func wantSkipped(t *testing.T, found *Found, want [][2]string) {
	t.Helper()
	got := [][2]string{}
	for _, s := range found.Skipped {
		got = append(got, [2]string{s.Release, s.Reason})
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("skipped %q, want %q", got, want)
	}
}

func wantCorrupt(t *testing.T, err error, kind Kind, message string) {
	t.Helper()
	var re *Error
	if !errors.As(err, &re) || re.Code != CodeCorrupt || re.Kind != kind || re.Message != message {
		t.Fatalf("got %v, want CORRUPT/%s %q", err, kind, message)
	}
}
