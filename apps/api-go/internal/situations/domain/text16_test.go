package domain

import (
	"encoding/json"
	"testing"
)

func TestSlice16CutsLikeJavaScript(t *testing.T) {
	cases := []struct {
		in   string
		n    int
		want string // JSON.stringify(in.slice(0, n))
	}{
		{"abc", 2, `"ab"`},
		{"ab😀c", 3, `"ab\ud83d"`},
		{"ab😀c", 4, `"ab😀"`},
		{"x😀y😀", 5, `"x😀y\ud83d"`},
	}
	for _, c := range cases {
		got, err := json.Marshal(Slice16(c.in, c.n))
		if err != nil {
			t.Fatal(err)
		}
		if string(got) != c.want {
			t.Errorf("Slice16(%q, %d) = %s, want %s", c.in, c.n, got, c.want)
		}
	}
	got, _ := json.Marshal(Slice16("ab😀c", 3) + "…")
	if string(got) != `"ab\ud83d…"` {
		t.Errorf("a cut surrogate inside the string: %s", got)
	}
}
