package doctext

import "unicode/utf8"

// DecodeUTF8 is the WHATWG UTF-8 decoder with the "replacement" error mode, as TextDecoder and
// Buffer#toString use it: each maximal ill-formed subpart becomes one U+FFFD (Go's own
// conversion replaces byte by byte). With stripBOM, one leading BOM is dropped (TextDecoder's
// default); without it the BOM stays a U+FEFF.
func DecodeUTF8(b []byte, stripBOM bool) string {
	if stripBOM && len(b) >= 3 && b[0] == 0xef && b[1] == 0xbb && b[2] == 0xbf {
		b = b[3:]
	}
	if utf8.Valid(b) {
		return string(b)
	}
	out := make([]rune, 0, min(len(b), 1<<16))
	var cp rune
	needed, seen := 0, 0
	lower, upper := byte(0x80), byte(0xbf)
	for i := 0; i < len(b); i++ {
		c := b[i]
		if needed == 0 {
			switch {
			case c <= 0x7f:
				out = append(out, rune(c))
			case c >= 0xc2 && c <= 0xdf:
				needed, cp = 1, rune(c&0x1f)
			case c >= 0xe0 && c <= 0xef:
				if c == 0xe0 {
					lower = 0xa0
				}
				if c == 0xed {
					upper = 0x9f
				}
				needed, cp = 2, rune(c&0x0f)
			case c >= 0xf0 && c <= 0xf4:
				if c == 0xf0 {
					lower = 0x90
				}
				if c == 0xf4 {
					upper = 0x8f
				}
				needed, cp = 3, rune(c&0x07)
			default:
				out = append(out, utf8.RuneError)
			}
			continue
		}
		if c < lower || c > upper {
			cp, needed, seen = 0, 0, 0
			lower, upper = 0x80, 0xbf
			out = append(out, utf8.RuneError)
			i-- // the byte starts the next sequence
			continue
		}
		lower, upper = 0x80, 0xbf
		cp = cp<<6 | rune(c&0x3f)
		seen++
		if seen == needed {
			out = append(out, cp)
			cp, needed, seen = 0, 0, 0
		}
	}
	if needed != 0 {
		out = append(out, utf8.RuneError)
	}
	return string(out)
}
