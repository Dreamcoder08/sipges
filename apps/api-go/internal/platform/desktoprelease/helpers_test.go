package desktoprelease

import (
	"bytes"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"encoding/pem"
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"
)

// The host every test pretends to be, so the committed golden release (linux/x64) matches on any
// machine that runs the tests.
var testHost = Platform{OS: "linux", Arch: "x64"}

// goldenDir is a release created and signed by deploy/desktop/updater/release.mjs with a throwaway
// key that was discarded; only its public key ships, inside the package.
const goldenDir = "testdata/golden-release"

// releaseMjsPath is the Node release module, from this package folder.
const releaseMjsPath = "../../../../../deploy/desktop/updater/release.mjs"

// copyGolden copies the golden release into a scratch folder. Git keeps no empty folders, so the
// package's empty `references` folder, listed in the signed manifest, is recreated here.
func copyGolden(t *testing.T, dst string) string {
	t.Helper()
	copyTree(t, goldenDir, dst)
	mkdirAll(t, filepath.Join(dst, "package", "references"))
	return dst
}

func copyTree(t *testing.T, src, dst string) {
	t.Helper()
	err := filepath.WalkDir(src, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		rel, err := filepath.Rel(src, path)
		if err != nil {
			return err
		}
		target := filepath.Join(dst, rel)
		switch {
		case d.Type()&fs.ModeSymlink != 0:
			link, err := os.Readlink(path)
			if err != nil {
				return err
			}
			return os.Symlink(link, target)
		case d.IsDir():
			return os.MkdirAll(target, 0o755)
		default:
			data, err := os.ReadFile(path)
			if err != nil {
				return err
			}
			return os.WriteFile(target, data, 0o644)
		}
	})
	if err != nil {
		t.Fatal(err)
	}
}

func mkdirAll(t *testing.T, path string) {
	t.Helper()
	if err := os.MkdirAll(path, 0o755); err != nil {
		t.Fatal(err)
	}
}

func put(t *testing.T, path, content string) {
	t.Helper()
	mkdirAll(t, filepath.Dir(path))
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}

func newKey(t *testing.T) ed25519.PrivateKey {
	t.Helper()
	_, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	return priv
}

func publicPEM(t *testing.T, pub ed25519.PublicKey) string {
	t.Helper()
	der, err := x509.MarshalPKIXPublicKey(pub)
	if err != nil {
		t.Fatal(err)
	}
	return string(pem.EncodeToMemory(&pem.Block{Type: "PUBLIC KEY", Bytes: der}))
}

// makePackage writes a synthetic package shaped like the builder output, with one internal
// directory link and one empty folder, as updater.test.mjs makePackage does.
func makePackage(t *testing.T, dir, version string, host Platform) {
	t.Helper()
	meta, _ := json.MarshalIndent(map[string]string{
		"version": version, "platform": host.OS, "arch": host.Arch, "entry": "start.mjs",
	}, "", "  ")
	put(t, filepath.Join(dir, "metadata.json"), string(meta)+"\n")
	put(t, filepath.Join(dir, ".sipges-desktop-package"), "Generated package.\n")
	put(t, filepath.Join(dir, "start.mjs"), "// synthetic entry "+version+"\n")
	put(t, filepath.Join(dir, "api/src/main.js"), "export const version = '"+version+"';\n")
	put(t, filepath.Join(dir, "web/index.html"), "<!doctype html><title>SIPGES "+version+"</title>\n")
	put(t, filepath.Join(dir, "api/node_modules/.pnpm/dep@1.0.0/node_modules/dep/index.js"), "export {};\n")
	mkdirAll(t, filepath.Join(dir, "references"))
	if err := os.Symlink(".pnpm/dep@1.0.0/node_modules/dep", filepath.Join(dir, "api/node_modules/dep")); err != nil {
		t.Fatal(err)
	}
}

// signedRelease is a Go port of release.mjs createRelease for tests: package copied in with the
// public key embedded, manifest written as JSON.stringify(manifest, null, 2) + "\n", then signed.
func signedRelease(t *testing.T, dir string, key ed25519.PrivateKey, version string) string {
	t.Helper()
	host := testHost
	pkg := filepath.Join(dir, "package")
	makePackage(t, pkg, version, host)
	put(t, filepath.Join(pkg, PublicKeyName), publicPEM(t, key.Public().(ed25519.PublicKey)))
	files := map[string]string{}
	links := map[string]string{}
	directories := []string{}
	err := filepath.WalkDir(pkg, func(path string, d fs.DirEntry, err error) error {
		if err != nil || path == pkg {
			return err
		}
		rel, _ := filepath.Rel(pkg, path)
		rel = filepath.ToSlash(rel)
		switch {
		case d.Type()&fs.ModeSymlink != 0:
			target, err := os.Readlink(path)
			links[rel] = target
			return err
		case d.IsDir():
			directories = append(directories, rel)
		default:
			data, err := os.ReadFile(path)
			sum := sha256.Sum256(data)
			files[rel] = hex.EncodeToString(sum[:])
			return err
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	sort.Strings(directories)
	fields := []string{
		jsonField("format", 1),
		jsonField("version", version),
		jsonField("minimumPrevious", nil),
		jsonField("platform", host.OS),
		jsonField("arch", host.Arch),
	}
	fields = append(fields, jsonField("files", files), jsonField("links", links), jsonField("directories", directories))
	writeSigned(t, dir, key, []byte(indentJSON(t, "{"+strings.Join(fields, ",")+"}")))
	return dir
}

func jsonField(name string, value any) string {
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	_ = enc.Encode(value)
	return `"` + name + `":` + strings.TrimSpace(buf.String())
}

func indentJSON(t *testing.T, compact string) string {
	t.Helper()
	var out bytes.Buffer
	if err := json.Indent(&out, []byte(compact), "", "  "); err != nil {
		t.Fatal(err)
	}
	return out.String() + "\n"
}

// writeSigned writes these exact manifest bytes and their base64 Ed25519 signature.
func writeSigned(t *testing.T, dir string, key ed25519.PrivateKey, manifest []byte) {
	t.Helper()
	mkdirAll(t, dir)
	if err := os.WriteFile(filepath.Join(dir, ManifestName), manifest, 0o644); err != nil {
		t.Fatal(err)
	}
	sig := base64.StdEncoding.EncodeToString(ed25519.Sign(key, manifest)) + "\n"
	if err := os.WriteFile(filepath.Join(dir, SignatureName), []byte(sig), 0o644); err != nil {
		t.Fatal(err)
	}
}

// resign rewrites a release's manifest through edit and signs it again with key.
func resign(t *testing.T, dir string, key ed25519.PrivateKey, edit func(m map[string]any)) {
	t.Helper()
	data, err := os.ReadFile(filepath.Join(dir, ManifestName))
	if err != nil {
		t.Fatal(err)
	}
	m := map[string]any{}
	if err := json.Unmarshal(data, &m); err != nil {
		t.Fatal(err)
	}
	edit(m)
	out, err := json.MarshalIndent(m, "", "  ")
	if err != nil {
		t.Fatal(err)
	}
	writeSigned(t, dir, key, append(out, '\n'))
}

// installed writes an install root as the Node updater leaves it: versions/<v> holding the
// trusted key and current.json pointing at it.
func installed(t *testing.T, root, version, keyPEM string) {
	t.Helper()
	if keyPEM != "" {
		put(t, filepath.Join(root, "versions", version, PublicKeyName), keyPEM)
	} else {
		mkdirAll(t, filepath.Join(root, "versions", version))
	}
	put(t, filepath.Join(root, "current.json"),
		`{"format":1,"version":"`+version+`","path":"versions/`+version+`","adopted":false}`)
}

func goldenKeyPEM(t *testing.T) string {
	t.Helper()
	data, err := os.ReadFile(filepath.Join(goldenDir, "package", PublicKeyName))
	if err != nil {
		t.Fatal(err)
	}
	return string(data)
}

// wantRefused asserts a typed refusal of this kind with exactly this message.
func wantRefused(t *testing.T, err error, kind Kind, message string) {
	t.Helper()
	var re *Error
	if !errors.As(err, &re) {
		t.Fatalf("want a refusal %q, got %v", message, err)
	}
	if re.Code != CodeRefused || re.Kind != kind || re.Message != message {
		t.Fatalf("got %s/%s %q, want REFUSED/%s %q", re.Code, re.Kind, re.Message, kind, message)
	}
}

// snapshot lists a tree without following links: path -> type and content.
func snapshot(t *testing.T, root string) map[string]string {
	t.Helper()
	out := map[string]string{}
	err := filepath.WalkDir(root, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		info, err := d.Info()
		if err != nil {
			return err
		}
		switch {
		case d.Type()&fs.ModeSymlink != 0:
			link, err := os.Readlink(path)
			out[path] = "link " + link
			return err
		case d.IsDir():
			out[path] = "dir " + info.Mode().String()
		default:
			data, err := os.ReadFile(path)
			out[path] = "file " + info.Mode().String() + " " + string(data)
			return err
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	return out
}

func strp(s string) *string { return &s }
