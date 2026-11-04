package http

import "testing"

// Expected values come from new TextDecoder().decode(Uint8Array.from(bytes)) in Node 22, the
// decoder behind Response.text() and so Hono's c.req.json().
func TestDecodeUTF8LikeTextDecoder(t *testing.T) {
	for _, c := range []struct{ in, want string }{
		{"abc", "abc"},
		{"\xff\xff", "��"},
		{"a\xe0\xa4", "a�"},     // a truncated sequence is one maximal subpart
		{"\xe0\x80\x80", "���"}, // overlong: E0 needs A0..BF next
		{"\xed\xa0\x80", "���"}, // a surrogate
		{"\xf0\x9f\x98", "�"},
		{"\xf0\x9f\x98\x80", "😀"},
		{"\xf4\x90\x80\x80", "����"}, // above U+10FFFF
		{"\xc2", "�"},
		{"\xc2a", "�a"},
		{"\x80ñ", "�ñ"},
	} {
		if got := string(decodeUTF8([]byte(c.in))); got != c.want {
			t.Errorf("decodeUTF8(%q) = %q, want %q", c.in, got, c.want)
		}
	}
}
