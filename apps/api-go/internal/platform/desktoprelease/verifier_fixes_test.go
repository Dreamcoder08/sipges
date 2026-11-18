package desktoprelease

import (
	"io/fs"
	"testing"
)

// T72d1 verifier blocker 2: since Go 1.23 a Windows junction has ModeIrregular and no ModeDir, and
// the Node updater (libuv) sees every reparse point as a link. Elsewhere irregular is not a link.
func TestAJunctionIsALinkOnWindowsOnly(t *testing.T) {
	cases := []struct {
		mode fs.FileMode
		goos string
		want bool
	}{
		{fs.ModeIrregular, "windows", true},
		{fs.ModeDir | fs.ModeIrregular, "windows", true},
		{fs.ModeSymlink, "windows", true},
		{fs.ModeDir, "windows", false},
		{0, "windows", false},
		{fs.ModeIrregular, "linux", false},
		{fs.ModeSymlink, "linux", true},
		{fs.ModeDir, "linux", false},
	}
	for _, c := range cases {
		if got := isLinkOn(c.mode, c.goos); got != c.want {
			t.Errorf("isLinkOn(%v, %s) = %v, want %v", c.mode, c.goos, got, c.want)
		}
	}
}

// T72d1 verifier blocker 1: JSON.parse keeps a lone UTF-16 surrogate, encoding/json turns it into
// U+FFFD, so two JS keys could become one in Go. A manifest with an unpaired surrogate escape is
// refused before parsing; a proper pair, an escaped backslash before "u" and plain text pass.
func TestALoneSurrogateEscapeIsRefused(t *testing.T) {
	for raw, want := range map[string]bool{
		`{"files":{"x\ud800":"a"}}`: true,
		`{"files":{"x\udc00":"a"}}`: true,
		`{"a":"\ud800A"}`:           true,
		`{"a":"\ud800"}`:            true,
		`{"a":"􏿿"}`:                 false,
		`{"a":"😀 ok"}`:              false,
		`{"a":"\\ud800"}`:           false,
		`{"a":"é plain é"}`:         false,
		`{"a":"𐀀","b":"\uDFFF"}`:    true,
	} {
		if got := hasLoneSurrogateEscape([]byte(raw)); got != want {
			t.Errorf("hasLoneSurrogateEscape(%s) = %v, want %v", raw, got, want)
		}
	}
	if _, err := parseManifest([]byte(`{"format":1,"files":{"x\ud800":"a"}}`)); err == nil {
		t.Fatal("a manifest with a lone surrogate escape was accepted")
	}
}
