package http

// len16 is a JavaScript string's length: UTF-16 code units.
func len16(s string) int {
	n := 0
	for _, r := range s {
		n++
		if r > 0xFFFF {
			n++
		}
	}
	return n
}
