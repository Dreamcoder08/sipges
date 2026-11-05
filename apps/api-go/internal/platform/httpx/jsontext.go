package httpx

import (
	"strings"
	"unicode/utf8"
)

// JSONText is the text Hono's c.req.json() hands JSON.parse: the body decoded as WHATWG UTF-8
// (TextDecoder: one U+FFFD per maximal invalid subpart, where Go's own decoding gives one per
// byte) without its leading byte order mark.
func JSONText(body []byte) string {
	return strings.TrimPrefix(decodeWHATWG(body), "\ufeff")
}

func decodeWHATWG(b []byte) string {
	if utf8.Valid(b) {
		return string(b)
	}
	var out strings.Builder
	for i := 0; i < len(b); {
		c := b[i]
		if c < 0x80 {
			out.WriteByte(c)
			i++
			continue
		}
		need, lo, hi := 0, byte(0x80), byte(0xbf)
		switch {
		case c >= 0xc2 && c <= 0xdf:
			need = 1
		case c == 0xe0:
			need, lo = 2, 0xa0
		case c >= 0xe1 && c <= 0xec, c == 0xee, c == 0xef:
			need = 2
		case c == 0xed:
			need, hi = 2, 0x9f
		case c == 0xf0:
			need, lo = 3, 0x90
		case c >= 0xf1 && c <= 0xf3:
			need = 3
		case c == 0xf4:
			need, hi = 3, 0x8f
		}
		j := i + 1
		for k := 0; need > 0 && k < need; k++ {
			if j >= len(b) || b[j] < lo || b[j] > hi {
				need = -1
				break
			}
			lo, hi = 0x80, 0xbf
			j++
		}
		if need <= 0 {
			out.WriteRune(utf8.RuneError)
			i = max(j, i+1)
			continue
		}
		out.Write(b[i:j])
		i = j
	}
	return out.String()
}
