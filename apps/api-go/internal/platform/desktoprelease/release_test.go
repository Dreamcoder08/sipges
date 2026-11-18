package desktoprelease

import (
	"crypto/ed25519"
	"crypto/rand"
	"crypto/rsa"
	"crypto/x509"
	"encoding/pem"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

// The golden release was created and signed by the real release.mjs; Go must accept it unchanged
// and compute the same key fingerprint keyFingerprint printed.
func TestGoldenReleaseSignedByReleaseMjsVerifies(t *testing.T) {
	dir := copyGolden(t, filepath.Join(t.TempDir(), "golden"))
	key, err := LoadPublicKey([]byte(goldenKeyPEM(t)))
	if err != nil {
		t.Fatal(err)
	}
	want, err := os.ReadFile("testdata/golden-fingerprint.txt")
	if err != nil {
		t.Fatal(err)
	}
	if got := KeyFingerprint(key); got != strings.TrimSpace(string(want)) {
		t.Fatalf("fingerprint %s, release.mjs printed %s", got, want)
	}
	rel, err := ReadRelease(dir, key)
	if err != nil {
		t.Fatal(err)
	}
	m := rel.Manifest
	if m.Version != "1.1.0" || m.MinimumPrevious == nil || *m.MinimumPrevious != "1.0.0" ||
		m.Platform != "linux" || m.Arch != "x64" {
		t.Fatalf("manifest %+v", m)
	}
	if m.Notes == nil || *m.Notes != "Corrige el filtro.\nNuevo resumen: año ✓." {
		t.Fatalf("notes %v", m.Notes)
	}
	if got := m.Links["api/deps/dep"]; got != ".store/dep@1.0.0/dep" {
		t.Fatalf("link %q", got)
	}
	if len(m.Files) != 7 || len(m.FileOrder) != 7 || len(m.Directories) != 8 {
		t.Fatalf("lists %d files, %d directories", len(m.Files), len(m.Directories))
	}
	if !strings.HasSuffix(rel.Signature, "==\n") {
		t.Fatalf("signature text %q", rel.Signature)
	}
	if err := CheckPackage(dir, m); err != nil {
		t.Fatal(err)
	}
}

// When Node is available, a release signed right now by release.mjs (its CLI, with notes and a
// minimum previous version) verifies in Go too, so the golden copy cannot drift from release.mjs.
func TestFreshReleaseFromReleaseMjsVerifies(t *testing.T) {
	node, err := exec.LookPath("node")
	script, _ := filepath.Abs(releaseMjsPath)
	if _, statErr := os.Stat(script); err != nil || statErr != nil {
		t.Skip("node or release.mjs not available; the committed golden release still covers release.mjs")
	}
	dir := t.TempDir()
	host := Platform{OS: "linux", Arch: "x64"}
	makePackage(t, filepath.Join(dir, "pkg"), "2.0.0", host)
	priv := newKey(t)
	der, err := x509.MarshalPKCS8PrivateKey(priv)
	if err != nil {
		t.Fatal(err)
	}
	put(t, filepath.Join(dir, "keys", "synthetic-signer.txt"),
		string(pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: der})))
	out := filepath.Join(dir, "release")
	cmd := exec.Command(node, script, "--package", filepath.Join(dir, "pkg"), "--out", out,
		"--key", filepath.Join(dir, "keys", "synthetic-signer.txt"), "--minimum-previous", "1.5.0", "--notes", "Nota.")
	if output, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("release.mjs: %v\n%s", err, output)
	}
	key, err := LoadPublicKey([]byte(publicPEM(t, priv.Public().(ed25519.PublicKey))))
	if err != nil {
		t.Fatal(err)
	}
	rel, err := ReadRelease(out, key)
	if err != nil {
		t.Fatal(err)
	}
	if rel.Manifest.Notes == nil || *rel.Manifest.Notes != "Nota." || *rel.Manifest.MinimumPrevious != "1.5.0" {
		t.Fatalf("manifest %+v", rel.Manifest)
	}
	if err := CheckPackage(out, rel.Manifest); err != nil {
		t.Fatal(err)
	}
	root := filepath.Join(dir, "install")
	installed(t, root, "1.5.0", publicPEM(t, priv.Public().(ed25519.PublicKey)))
	found, err := FindUpdate(root, out, host)
	if err != nil || found.Available == nil || found.Available.Version != "2.0.0" {
		t.Fatalf("found %+v, %v", found, err)
	}
}

func TestLoadPublicKeyRefusesOtherKeys(t *testing.T) {
	rsaKey, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	der, err := x509.MarshalPKIXPublicKey(&rsaKey.PublicKey)
	if err != nil {
		t.Fatal(err)
	}
	_, err = LoadPublicKey(pem.EncodeToMemory(&pem.Block{Type: "PUBLIC KEY", Bytes: der}))
	wantRefused(t, err, KindKey, "The update key is not an Ed25519 key")
	for _, bad := range []string{"", "not a key", "-----BEGIN PUBLIC KEY-----\nAAAA\n-----END PUBLIC KEY-----\n"} {
		_, err = LoadPublicKey([]byte(bad))
		wantRefused(t, err, KindKey, "The update key is not a valid public key")
	}
	pkcs8, err := x509.MarshalPKCS8PrivateKey(newKey(t))
	if err != nil {
		t.Fatal(err)
	}
	_, err = LoadPublicKey(pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: pkcs8}))
	wantRefused(t, err, KindKey, "The update key is not a valid public key")
}

// updater.test.mjs "rule 1: a bad signature or any mismatching file is refused": the signature
// half, plus every way release.mjs readRelease refuses the signature files.
func TestReadReleaseRefusesBadSignatures(t *testing.T) {
	key, err := LoadPublicKey([]byte(goldenKeyPEM(t)))
	if err != nil {
		t.Fatal(err)
	}
	mismatch := "The release signature does not match the trusted update key"
	malformed := "The release signature is malformed"
	cases := []struct {
		name    string
		damage  func(t *testing.T, dir string)
		kind    Kind
		message string
	}{
		{"signed by another key", func(t *testing.T, dir string) {
			writeSigned(t, dir, newKey(t), mustRead(t, filepath.Join(dir, ManifestName)))
		}, KindSignatureMismatch, mismatch},
		{"release.json edited after signing", func(t *testing.T, dir string) {
			text := strings.Replace(string(mustRead(t, filepath.Join(dir, ManifestName))), `"1.1.0"`, `"1.2.0"`, 1)
			put(t, filepath.Join(dir, ManifestName), text)
		}, KindSignatureMismatch, mismatch},
		{"one trailing space added to release.json", func(t *testing.T, dir string) {
			put(t, filepath.Join(dir, ManifestName), string(mustRead(t, filepath.Join(dir, ManifestName)))+" ")
		}, KindSignatureMismatch, mismatch},
		{"no release.sig", func(t *testing.T, dir string) {
			mustRemove(t, filepath.Join(dir, SignatureName))
		}, KindNoSignature, "No release.sig in the release directory"},
		{"no release.json", func(t *testing.T, dir string) {
			mustRemove(t, filepath.Join(dir, ManifestName))
		}, KindNoManifest, "No release.json in the release directory"},
		{"release.json is a folder", func(t *testing.T, dir string) {
			mustRemove(t, filepath.Join(dir, ManifestName))
			mkdirAll(t, filepath.Join(dir, ManifestName))
		}, KindNoManifest, "release.json is not a file or is too large"},
		{"release.json is a link to the real one", func(t *testing.T, dir string) {
			if err := os.Rename(filepath.Join(dir, ManifestName), filepath.Join(dir, "real.json")); err != nil {
				t.Fatal(err)
			}
			if err := os.Symlink("real.json", filepath.Join(dir, ManifestName)); err != nil {
				t.Fatal(err)
			}
		}, KindNoManifest, "release.json is not a file or is too large"},
		{"release.json over 64 MB", func(t *testing.T, dir string) {
			if err := os.Truncate(filepath.Join(dir, ManifestName), MaxManifestBytes+1); err != nil {
				t.Fatal(err)
			}
		}, KindNoManifest, "release.json is not a file or is too large"},
		{"signature not base64", func(t *testing.T, dir string) {
			put(t, filepath.Join(dir, SignatureName), "not base64!\n")
		}, KindSignatureMalformed, malformed},
		{"signature of 63 bytes", func(t *testing.T, dir string) {
			put(t, filepath.Join(dir, SignatureName), strings.Repeat("A", 84)+"\n")
		}, KindSignatureMalformed, malformed},
		{"signature without padding", func(t *testing.T, dir string) {
			sig := strings.TrimSpace(string(mustRead(t, filepath.Join(dir, SignatureName))))
			put(t, filepath.Join(dir, SignatureName), strings.TrimRight(sig, "=")+"\n")
		}, KindSignatureMalformed, malformed},
		{"signature with a line break inside", func(t *testing.T, dir string) {
			sig := strings.TrimSpace(string(mustRead(t, filepath.Join(dir, SignatureName))))
			put(t, filepath.Join(dir, SignatureName), sig[:40]+"\n"+sig[40:]+"\n")
		}, KindSignatureMalformed, malformed},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			dir := copyGolden(t, filepath.Join(t.TempDir(), "release"))
			tc.damage(t, dir)
			_, err := ReadRelease(dir, key)
			wantRefused(t, err, tc.kind, tc.message)
		})
	}
	t.Run("surrounding whitespace around the signature is trimmed as in Node", func(t *testing.T) {
		dir := copyGolden(t, filepath.Join(t.TempDir(), "release"))
		sig := strings.TrimSpace(string(mustRead(t, filepath.Join(dir, SignatureName))))
		put(t, filepath.Join(dir, SignatureName), "\ufeff \t"+sig+"\r\n\r\n")
		if _, err := ReadRelease(dir, key); err != nil {
			t.Fatal(err)
		}
	})
}

// updater.test.mjs "rule 2: a release that is not newer, or needs a newer installed version, is
// refused", and the platform check of updater.mjs checkTarget.
func TestCheckTarget(t *testing.T) {
	current := &Current{Version: "1.0.0"}
	for _, version := range []string{"1.0.0", "0.9.9", "1.0.0-rc.1", "1.0.0+build.2"} {
		err := CheckTarget(current, &Manifest{Version: version, Platform: "linux", Arch: "x64"}, testHost)
		wantRefused(t, err, KindNotNewer, "Version "+version+" is not newer than the installed 1.0.0")
	}
	err := CheckTarget(current, &Manifest{Version: "1.1.0", MinimumPrevious: strp("1.0.1"), Platform: "linux", Arch: "x64"}, testHost)
	wantRefused(t, err, KindMinimumPrevious, "Version 1.1.0 requires at least 1.0.1 installed; found 1.0.0")
	if err := CheckTarget(current, &Manifest{Version: "1.0.1-local.1", Platform: "linux", Arch: "x64"}, testHost); err != nil {
		t.Fatal(err)
	}
	if err := CheckTarget(current, &Manifest{Version: "1.1.0", MinimumPrevious: strp("1.0.0"), Platform: "linux", Arch: "x64"}, testHost); err != nil {
		t.Fatal(err)
	}
	err = CheckTarget(current, &Manifest{Version: "1.1.0", Platform: "linux", Arch: "x64"}, Platform{OS: "win32", Arch: "x64"})
	wantRefused(t, err, KindPlatform, "Release is for linux/x64; this computer is win32/x64")
	err = CheckTarget(nil, &Manifest{Version: "0.0.1", Platform: "win32", Arch: "arm64"}, Platform{OS: "win32", Arch: "x64"})
	wantRefused(t, err, KindPlatform, "Release is for win32/arm64; this computer is win32/x64")
	if err := CheckTarget(nil, &Manifest{Version: "0.0.1", Platform: "linux", Arch: "x64"}, testHost); err != nil {
		t.Fatal(err)
	}
}

// Node's process.platform and process.arch names for the Go targets the desktop ships on.
func TestNodePlatformNames(t *testing.T) {
	for _, tc := range []struct{ goos, goarch, os, arch string }{
		{"windows", "amd64", "win32", "x64"},
		{"windows", "arm64", "win32", "arm64"},
		{"linux", "amd64", "linux", "x64"},
		{"linux", "arm64", "linux", "arm64"},
		{"darwin", "arm64", "darwin", "arm64"},
		{"linux", "386", "linux", "ia32"},
	} {
		if got := NodePlatform(tc.goos, tc.goarch); got != (Platform{OS: tc.os, Arch: tc.arch}) {
			t.Fatalf("%s/%s -> %+v", tc.goos, tc.goarch, got)
		}
	}
}

// release.mjs compareVersions: Semantic Versioning 2.0 precedence, build metadata ignored.
func TestCompareVersions(t *testing.T) {
	ordered := []string{
		"1.0.0-alpha", "1.0.0-alpha.1", "1.0.0-alpha.beta", "1.0.0-beta", "1.0.0-beta.2",
		"1.0.0-beta.11", "1.0.0-rc.1", "1.0.0", "1.0.1-local.1", "1.0.1", "1.2.0", "1.10.0", "2.0.0",
	}
	for i := range ordered {
		for j := range ordered {
			want := 0
			if i < j {
				want = -1
			} else if i > j {
				want = 1
			}
			if got := CompareVersions(ordered[i], ordered[j]); got != want {
				t.Fatalf("compare(%s, %s) = %d, want %d", ordered[i], ordered[j], got, want)
			}
		}
	}
	if CompareVersions("1.0.0+build.2", "1.0.0") != 0 || CompareVersions("1.0.0-rc.1+a", "1.0.0-rc.1+b") != 0 {
		t.Fatal("build metadata must be ignored")
	}
	for _, v := range []string{"1.0", "01.0.0", "1.0.0-", "1.0.0-01", "v1.0.0", "1.0.0\n", " 1.0.0"} {
		if IsVersion(v) {
			t.Fatalf("%q accepted", v)
		}
	}
}

func mustRead(t *testing.T, path string) []byte {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return data
}

func mustRemove(t *testing.T, path string) {
	t.Helper()
	if err := os.RemoveAll(path); err != nil {
		t.Fatal(err)
	}
}
