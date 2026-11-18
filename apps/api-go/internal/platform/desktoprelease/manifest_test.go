package desktoprelease

import (
	"crypto/ed25519"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
)

const hashA = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"

// rawManifest builds manifest JSON in release.mjs field order; a field set to "" is left out and
// any other value is raw JSON.
func rawManifest(overrides map[string]string) string {
	fields := []struct{ name, value string }{
		{"format", "1"},
		{"version", `"1.1.0"`},
		{"minimumPrevious", "null"},
		{"platform", `"linux"`},
		{"arch", `"x64"`},
		{"notes", ""},
		{"files", `{"metadata.json":"` + hashA + `","start.mjs":"` + hashA + `","update-public-key.pem":"` + hashA + `","lib/a.js":"` + hashA + `"}`},
		{"links", `{"lib/dep":"../store/dep"}`},
		{"directories", `["lib","store","store/dep"]`},
	}
	parts := []string{}
	for _, f := range fields {
		value := f.value
		if v, ok := overrides[f.name]; ok {
			value = v
		}
		if value != "" {
			parts = append(parts, `"`+f.name+`":`+value)
		}
	}
	return "{" + strings.Join(parts, ",") + "}"
}

func readRaw(t *testing.T, manifest string) (*Release, error) {
	t.Helper()
	key := newKey(t)
	dir := filepath.Join(t.TempDir(), "release")
	writeSigned(t, dir, key, []byte(manifest))
	return ReadRelease(dir, key.Public().(ed25519.PublicKey))
}

type manifestCase struct{ name, manifest, why string }

// manifestCases are the valid manifests and the invalid ones with the rule each breaks, shared by
// the Go test and the differential test against release.mjs.
func manifestCases() (valid, invalid []manifestCase) {
	bom := string(rune(0xFEFF))
	long := strings.Repeat("x", 4001)
	emoji2000 := strings.Repeat(string(rune(0x1F600)), 2000)
	valid = []manifestCase{
		{"notes null", rawManifest(map[string]string{"notes": "null"}), ""},
		{"notes of 4000 characters", rawManifest(map[string]string{"notes": `"` + strings.Repeat("x", 4000) + `"`}), ""},
		{"notes of 2000 emoji (4000 UTF-16 units)", rawManifest(map[string]string{"notes": `"` + emoji2000 + `"`}), ""},
		{"format written as 1.0", rawManifest(map[string]string{"format": "1.0"}), ""},
		{"a pre-release with build metadata", rawManifest(map[string]string{"version": `"2.0.0-rc.1+build.5"`}), ""},
		{"links given as an empty array", rawManifest(map[string]string{"links": "[]"}), ""},
		{"a top-level link", rawManifest(map[string]string{"links": `{"dep":"store/dep"}`}), ""},
		{"unknown fields are ignored", rawManifest(map[string]string{"format": `1,"extra":{"a":[1,2]}`}), ""},
		{"a duplicated key keeps its last value, as JSON.parse does", `{"version":"x",` + rawManifest(nil)[1:], ""},
	}
	invalid = []manifestCase{
		{"not JSON", "{", "not JSON"},
		{"trailing data", rawManifest(nil) + "{}", "not JSON"},
		{"a byte order mark", bom + rawManifest(nil), "not JSON"},
		{"an array", "[]", "not an object"},
		{"null", "null", "not an object"},
		{"a string", `"x"`, "not an object"},
		{"format 2", rawManifest(map[string]string{"format": "2"}), "unknown format"},
		{"format as text", rawManifest(map[string]string{"format": `"1"`}), "unknown format"},
		{"no format", rawManifest(map[string]string{"format": ""}), "unknown format"},
		{"no version", rawManifest(map[string]string{"version": ""}), "version"},
		{"version 1.0", rawManifest(map[string]string{"version": `"1.0"`}), "version"},
		{"version as a number", rawManifest(map[string]string{"version": "1"}), "version"},
		{"capitalised Version only", strings.Replace(rawManifest(nil), `"version"`, `"Version"`, 1), "version"},
		{"no minimumPrevious", rawManifest(map[string]string{"minimumPrevious": ""}), "minimum previous version"},
		{"minimumPrevious invalid", rawManifest(map[string]string{"minimumPrevious": `"1"`}), "minimum previous version"},
		{"platform missing", rawManifest(map[string]string{"platform": ""}), "platform"},
		{"arch as a number", rawManifest(map[string]string{"arch": "64"}), "platform"},
		{"notes blank", rawManifest(map[string]string{"notes": `"  \n "`}), "notes"},
		{"notes empty", rawManifest(map[string]string{"notes": `""`}), "notes"},
		{"notes of 4001 characters", rawManifest(map[string]string{"notes": `"` + long + `"`}), "notes"},
		{"notes of 2000 emoji and one letter", rawManifest(map[string]string{"notes": `"` + emoji2000 + `x"`}), "notes"},
		{"notes as an object", rawManifest(map[string]string{"notes": `{"text":"x"}`}), "notes"},
		{"notes only a BOM, which JavaScript trims", rawManifest(map[string]string{"notes": `"` + bom + `"`}), "notes"},
		{"files missing", rawManifest(map[string]string{"files": ""}), "lists"},
		{"files null", rawManifest(map[string]string{"files": "null"}), "lists"},
		{"links as text", rawManifest(map[string]string{"links": `"x"`}), "lists"},
		{"directories as an object", rawManifest(map[string]string{"directories": "{}"}), "directories"},
		{"files as an array", rawManifest(map[string]string{"files": `["metadata.json"]`}), "missing metadata.json"},
		{"a parent path", rawManifest(map[string]string{"directories": `["lib","store","store/dep","../x"]`}), `unsafe path "../x"`},
		{"a dot segment", rawManifest(map[string]string{"directories": `["lib","store","store/dep","a/./b"]`}), `unsafe path "a/./b"`},
		{"an empty segment", rawManifest(map[string]string{"directories": `["lib","store","store/dep","a//b"]`}), `unsafe path "a//b"`},
		{"a leading slash", rawManifest(map[string]string{"directories": `["lib","store","store/dep","/a"]`}), `unsafe path "/a"`},
		{"a backslash", rawManifest(map[string]string{"directories": `["lib","store","store/dep","a\\b"]`}), `unsafe path "a\\b"`},
		{"a colon", rawManifest(map[string]string{"directories": `["lib","store","store/dep","c:x"]`}), `unsafe path "c:x"`},
		{"a trailing dot", rawManifest(map[string]string{"directories": `["lib","store","store/dep","a."]`}), `unsafe path "a."`},
		{"a trailing space", rawManifest(map[string]string{"directories": `["lib","store","store/dep","a "]`}), `unsafe path "a "`},
		{"a control character", rawManifest(map[string]string{"directories": `["lib","store","store/dep","a\u001fb"]`}), `unsafe path "a\u001fb"`},
		{"an empty path", rawManifest(map[string]string{"directories": `["lib","store","store/dep",""]`}), `unsafe path ""`},
		{"a path over 1024 characters", rawManifest(map[string]string{"directories": `["lib","store","store/dep","` + strings.Repeat("a", 1025) + `"]`}), `unsafe path "` + strings.Repeat("a", 1025) + `"`},
		{"a directory that is not text", rawManifest(map[string]string{"directories": `["lib","store","store/dep",5]`}), `unsafe path 5`},
		{"a case-insensitive duplicate", rawManifest(map[string]string{"directories": `["lib","store","store/dep","LIB"]`}), "duplicate path LIB"},
		{"a duplicate only under full Unicode lower-casing", rawManifest(map[string]string{"directories": `["lib","store","store/dep","ΟΔΟΣ","οδος"]`}), "duplicate path οδος"},
		{"a reserved name", rawManifest(map[string]string{"directories": `["lib","store","store/dep","Release.json"]`}), "reserved name release.json"},
		{"start.mjs missing", strings.Replace(rawManifest(nil), `"start.mjs"`, `"other.mjs"`, 1), "missing start.mjs"},
		{"update key missing", strings.Replace(rawManifest(nil), `"update-public-key.pem"`, `"key.pem"`, 1), "missing update-public-key.pem"},
		{"an upper-case hash", strings.Replace(rawManifest(nil), hashA, strings.ToUpper(hashA), 1), "hash"},
		{"a short hash", strings.Replace(rawManifest(nil), hashA, hashA[:63], 1), "hash"},
		{"a hash that is a number", strings.Replace(rawManifest(nil), `"`+hashA+`"`, "1", 1), "hash"},
		{"an absolute link", rawManifest(map[string]string{"links": `{"lib/dep":"/store/dep"}`}), "link lib/dep"},
		{"an empty link", rawManifest(map[string]string{"links": `{"lib/dep":""}`}), "link lib/dep"},
		{"a link with a backslash", rawManifest(map[string]string{"links": `{"lib/dep":"..\\store\\dep"}`}), "link lib/dep"},
		{"a link that is not text", rawManifest(map[string]string{"links": `{"lib/dep":1}`}), "link lib/dep"},
		{"a link out of the package", rawManifest(map[string]string{"links": `{"lib/dep":"../../outside"}`}), "link lib/dep leaves the package"},
		{"a link to the package root", rawManifest(map[string]string{"links": `{"lib/dep":".."}`}), "link lib/dep leaves the package"},
		{"a link to an unlisted folder", rawManifest(map[string]string{"links": `{"lib/dep":"other"}`}), "link lib/dep leaves the package"},
		{"a link with a trailing slash", rawManifest(map[string]string{"links": `{"lib/dep":"../store/dep/"}`}), "link lib/dep leaves the package"},
		{"a path under a link", strings.Replace(rawManifest(nil), `"lib/a.js"`, `"lib/dep/a.js"`, 1), "path lib/dep/a.js under link lib/dep"},
	}
	return valid, invalid
}

// release.mjs validateManifest: every rule, checked after the signature, refused with the same
// message the Node updater logs.
func TestManifestValidation(t *testing.T) {
	if _, err := readRaw(t, rawManifest(nil)); err != nil {
		t.Fatalf("the base manifest must be valid: %v", err)
	}
	valid, invalid := manifestCases()
	for _, tc := range valid {
		t.Run("valid: "+tc.name, func(t *testing.T) {
			if _, err := readRaw(t, tc.manifest); err != nil {
				t.Fatal(err)
			}
		})
	}
	for _, tc := range invalid {
		t.Run("invalid: "+tc.name, func(t *testing.T) {
			_, err := readRaw(t, tc.manifest)
			wantRefused(t, err, KindManifestInvalid, "The release manifest is invalid: "+tc.why)
		})
	}
}

// release.mjs isSafeRelative, directly.
func TestIsSafeRelative(t *testing.T) {
	for _, ok := range []string{"a", "a/b.c", ".hidden/x", "dep@1.0.0/node_modules", "año/ñ"} {
		if !IsSafeRelative(ok) {
			t.Fatalf("%q refused", ok)
		}
	}
	for _, bad := range []string{"", ".", "..", "a/", "/a", "a/../b", `a\b`, "a:b", "a*b", "a?b", `a"b`, "a<b", "a>b", "a|b", "a\x00b", "a\tb", "x.", "x ", strings.Repeat("a", 1025)} {
		if IsSafeRelative(bad) {
			t.Fatalf("%q accepted", bad)
		}
	}
	// 512 two-unit characters are 1024 UTF-16 units: the most JavaScript accepts.
	if !IsSafeRelative(strings.Repeat(string(rune(0x1F600)), 512)) || IsSafeRelative(strings.Repeat(string(rune(0x1F600)), 513)) {
		t.Fatal("path length must count UTF-16 units")
	}
}

// When Node is available, every manifest case is also read by the real release.mjs readRelease:
// Go must accept and refuse the same manifests with the same messages.
func TestManifestValidationMatchesReleaseMjs(t *testing.T) {
	node, err := exec.LookPath("node")
	script, _ := filepath.Abs(releaseMjsPath)
	if _, statErr := os.Stat(script); err != nil || statErr != nil {
		t.Skip("node or release.mjs not available; TestManifestValidation still pins the messages")
	}
	key := newKey(t)
	dir := t.TempDir()
	keyFile := filepath.Join(dir, "key.pem")
	put(t, keyFile, publicPEM(t, key.Public().(ed25519.PublicKey)))
	valid, invalid := manifestCases()
	all := append(append([]manifestCase{}, valid...), invalid...)
	args := []string{"testdata/read-release.mjs", script, keyFile}
	goMessages := make([]string, len(all))
	for i, tc := range all {
		release := filepath.Join(dir, strconv.Itoa(i))
		writeSigned(t, release, key, []byte(tc.manifest))
		args = append(args, release)
		goMessages[i] = "OK"
		if _, err := ReadRelease(release, key.Public().(ed25519.PublicKey)); err != nil {
			goMessages[i] = err.Error()
		}
	}
	output, err := exec.Command(node, args...).Output()
	if err != nil {
		t.Fatalf("node: %v", err)
	}
	var nodeMessages []string
	if err := json.Unmarshal(output, &nodeMessages); err != nil {
		t.Fatalf("node output %q: %v", output, err)
	}
	if len(nodeMessages) != len(all) {
		t.Fatalf("node read %d releases, want %d", len(nodeMessages), len(all))
	}
	for i, tc := range all {
		if nodeMessages[i] != goMessages[i] {
			t.Errorf("%s: node %q, go %q", tc.name, nodeMessages[i], goMessages[i])
		}
	}
}
