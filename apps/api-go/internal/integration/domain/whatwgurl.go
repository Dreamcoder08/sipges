package domain

import (
	"errors"
	"strconv"
	"strings"
	"unicode/utf8"
)

// URL is what the integration rules read from JavaScript's `new URL(value)`: the WHATWG URL
// Standard parser as Node implements it, without a base URL.
//
// The port covers the special schemes the feeds and webhooks use (http, https, plus ws, wss and
// ftp, parsed the same way) and only decides whether any other scheme parses. It fails closed
// where it reads less than the standard: a host with non-ASCII characters (Node maps it through
// IDNA to punycode) is reported as unparseable, so such a URL is refused instead of fetched.
type URL struct {
	// Protocol is url.protocol: the lower-case scheme and ":".
	Protocol string
	Username string
	Password string
	// Hostname is url.hostname: a lower-case domain, a dotted IPv4 address or a bracketed IPv6
	// address. Empty for a non-special URL without a host.
	Hostname string
	// Port is url.port: empty when absent or the scheme's default.
	Port string
	// Href is url.href, the serialized URL.
	Href string
}

var defaultPorts = map[string]string{"http": "80", "https": "443", "ws": "80", "wss": "443", "ftp": "21"}

// ParseURL is `new URL(input)`; ok is false where it throws.
func ParseURL(input string) (URL, bool) {
	s := strings.TrimFunc(input, func(r rune) bool { return r <= 0x20 })
	s = strings.Map(func(r rune) rune {
		if r == '\t' || r == '\n' || r == '\r' {
			return -1
		}
		return r
	}, s)
	colon := strings.IndexByte(s, ':')
	if colon <= 0 || !isScheme(s[:colon]) {
		return URL{}, false
	}
	scheme := strings.ToLower(s[:colon])
	rest := s[colon+1:]
	if scheme == "file" {
		return URL{Protocol: "file:", Href: "file:" + rest}, true // only parse success matters
	}
	if _, special := defaultPorts[scheme]; !special {
		return parseOpaque(scheme, rest)
	}
	// special authority ignore slashes: any run of '/' and '\' before the authority
	rest = strings.TrimLeft(rest, `/\`)
	end := strings.IndexAny(rest, `/\?#`)
	if end < 0 {
		end = len(rest)
	}
	authority, tail := rest[:end], rest[end:]
	u := URL{Protocol: scheme + ":"}
	if at := strings.LastIndexByte(authority, '@'); at >= 0 {
		userinfo := authority[:at]
		authority = authority[at+1:]
		user, pass, _ := strings.Cut(userinfo, ":")
		u.Username = percentEncode(user, userinfoSet)
		u.Password = percentEncode(pass, userinfoSet)
		if authority == "" {
			return URL{}, false
		}
	}
	hostPart, port, ok := splitHostPort(authority)
	if !ok || hostPart == "" {
		return URL{}, false
	}
	host, ok := parseSpecialHost(hostPart)
	if !ok {
		return URL{}, false
	}
	u.Hostname = host
	if port != "" {
		n, err := strconv.Atoi(port)
		if err != nil || n > 65535 {
			return URL{}, false
		}
		if p := strconv.Itoa(n); p != defaultPorts[scheme] {
			u.Port = p
		}
	}
	path, query, fragment := splitTail(tail)
	var b strings.Builder
	b.WriteString(u.Protocol + "//")
	if u.Username != "" || u.Password != "" {
		b.WriteString(u.Username)
		if u.Password != "" {
			b.WriteString(":" + u.Password)
		}
		b.WriteByte('@')
	}
	b.WriteString(u.Hostname)
	if u.Port != "" {
		b.WriteString(":" + u.Port)
	}
	b.WriteString(specialPath(path))
	if query != nil {
		b.WriteString("?" + percentEncode(*query, specialQuerySet))
	}
	if fragment != nil {
		b.WriteString("#" + percentEncode(*fragment, fragmentSet))
	}
	u.Href = b.String()
	return u, true
}

func isScheme(s string) bool {
	for i := 0; i < len(s); i++ {
		c := s[i]
		alpha := c|0x20 >= 'a' && c|0x20 <= 'z'
		if !alpha && (i == 0 || (c < '0' || c > '9') && c != '+' && c != '-' && c != '.') {
			return false
		}
	}
	return s != ""
}

// parseOpaque decides whether a URL of a non-special scheme parses; only its authority can make
// it fail (an invalid host or port).
func parseOpaque(scheme, rest string) (URL, bool) {
	u := URL{Protocol: scheme + ":", Href: scheme + ":" + rest}
	if !strings.HasPrefix(rest, "//") {
		return u, true
	}
	authority := rest[2:]
	if end := strings.IndexAny(authority, "/?#"); end >= 0 {
		authority = authority[:end]
	}
	if at := strings.LastIndexByte(authority, '@'); at >= 0 {
		authority = authority[at+1:]
		if authority == "" {
			return URL{}, false
		}
	}
	host, port, ok := splitHostPort(authority)
	if !ok {
		return URL{}, false
	}
	if port != "" {
		if n, err := strconv.Atoi(port); err != nil || n > 65535 {
			return URL{}, false
		}
	}
	if strings.HasPrefix(host, "[") {
		if _, ok := parseIPv6(host); !ok {
			return URL{}, false
		}
		return u, true
	}
	for _, r := range host {
		if strings.ContainsRune("\x00\t\n\r #/:<>?@[\\]^|", r) {
			return URL{}, false
		}
	}
	return u, true
}

// splitHostPort splits at the first ':' outside brackets; the port must be ASCII digits.
func splitHostPort(authority string) (host, port string, ok bool) {
	inBrackets := false
	for i := 0; i < len(authority); i++ {
		switch authority[i] {
		case '[':
			inBrackets = true
		case ']':
			inBrackets = false
		case ':':
			if !inBrackets {
				port = authority[i+1:]
				for j := 0; j < len(port); j++ {
					if port[j] < '0' || port[j] > '9' {
						return "", "", false
					}
				}
				return authority[:i], port, true
			}
		}
	}
	return authority, "", true
}

// splitTail splits what follows the authority into path, query and fragment (nil when absent).
func splitTail(tail string) (path string, query, fragment *string) {
	if i := strings.IndexByte(tail, '#'); i >= 0 {
		f := tail[i+1:]
		fragment, tail = &f, tail[:i]
	}
	if i := strings.IndexByte(tail, '?'); i >= 0 {
		q := tail[i+1:]
		query, tail = &q, tail[:i]
	}
	return tail, query, fragment
}

// specialPath is the path state of a special URL: '\' is '/', dot segments are resolved, each
// segment is percent-encoded, and the empty path is "/".
func specialPath(path string) string {
	path = strings.ReplaceAll(path, `\`, "/")
	if path == "" {
		return "/"
	}
	segments := strings.Split(path[1:], "/")
	out := make([]string, 0, len(segments))
	for i, seg := range segments {
		last := i == len(segments)-1
		switch lower := strings.ToLower(seg); lower {
		case "..", ".%2e", "%2e.", "%2e%2e":
			if len(out) > 0 {
				out = out[:len(out)-1]
			}
			if last {
				out = append(out, "")
			}
		case ".", "%2e":
			if last {
				out = append(out, "")
			}
		default:
			out = append(out, percentEncode(seg, pathSet))
		}
	}
	return "/" + strings.Join(out, "/")
}

// Percent-encode sets of the URL Standard, beyond the C0 control set (C0 controls and every code
// point above U+007E, which percentEncode always encodes).
const (
	fragmentSet     = " \"<>`"
	specialQuerySet = " \"#<>'"
	pathSet         = " \"#<>?`{}"
	userinfoSet     = pathSet + "/:;=@[\\]^|"
)

func percentEncode(s, set string) string {
	var b strings.Builder
	for i := 0; i < len(s); i++ {
		c := s[i]
		if c < 0x20 || c > 0x7e || strings.IndexByte(set, c) >= 0 {
			b.WriteString("%" + strings.ToUpper(strconv.FormatInt(int64(c)>>4, 16)+strconv.FormatInt(int64(c)&15, 16)))
			continue
		}
		b.WriteByte(c)
	}
	return b.String()
}

// parseSpecialHost is the host parser for a special URL: an IPv6 literal, else the percent-decoded
// domain, lower-cased, refused when it holds a forbidden code point, and read as IPv4 when its
// last label is a number.
func parseSpecialHost(input string) (string, bool) {
	if strings.HasPrefix(input, "[") {
		if !strings.HasSuffix(input, "]") {
			return "", false
		}
		return parseIPv6(input)
	}
	decoded := percentDecode(input)
	if !utf8.ValidString(decoded) {
		decoded = strings.ToValidUTF8(decoded, "�")
	}
	for i := 0; i < len(decoded); i++ {
		if decoded[i] >= 0x80 {
			return "", false // IDNA: not ported, fails closed
		}
	}
	domain := strings.ToLower(decoded)
	if domain == "" {
		return "", false
	}
	for i := 0; i < len(domain); i++ {
		c := domain[i]
		if c <= 0x20 || c == 0x7f || strings.IndexByte("#%/:<>?@[\\]^|", c) >= 0 {
			return "", false
		}
	}
	if endsInNumber(domain) {
		return parseIPv4(domain)
	}
	return domain, true
}

func percentDecode(s string) string {
	if !strings.Contains(s, "%") {
		return s
	}
	var b strings.Builder
	for i := 0; i < len(s); i++ {
		if s[i] == '%' && i+2 < len(s) && isHex(s[i+1]) && isHex(s[i+2]) {
			v, _ := strconv.ParseUint(s[i+1:i+3], 16, 8)
			b.WriteByte(byte(v))
			i += 2
			continue
		}
		b.WriteByte(s[i])
	}
	return b.String()
}

func isHex(c byte) bool { return c >= '0' && c <= '9' || c|0x20 >= 'a' && c|0x20 <= 'f' }

func endsInNumber(domain string) bool {
	parts := strings.Split(domain, ".")
	if parts[len(parts)-1] == "" {
		if len(parts) == 1 {
			return false
		}
		parts = parts[:len(parts)-1]
	}
	last := parts[len(parts)-1]
	if last != "" && strings.Trim(last, "0123456789") == "" {
		return true
	}
	if len(last) >= 2 && last[0] == '0' && last[1]|0x20 == 'x' {
		for i := 2; i < len(last); i++ {
			if !isHex(last[i]) {
				return false
			}
		}
		return true
	}
	return false
}

// parseIPv4 is the IPv4 parser: up to four parts, each decimal, octal (leading 0) or hexadecimal
// (0x), the last one filling the remaining bytes.
func parseIPv4(s string) (string, bool) {
	parts := strings.Split(s, ".")
	if parts[len(parts)-1] == "" && len(parts) > 1 {
		parts = parts[:len(parts)-1]
	}
	if len(parts) > 4 {
		return "", false
	}
	numbers := make([]uint64, len(parts))
	for i, p := range parts {
		n, ok := ipv4Number(p)
		if !ok {
			return "", false
		}
		numbers[i] = n
	}
	for _, n := range numbers[:len(numbers)-1] {
		if n > 255 {
			return "", false
		}
	}
	last := numbers[len(numbers)-1]
	if last >= 1<<(8*(5-len(numbers))) {
		return "", false
	}
	addr := last
	for i, n := range numbers[:len(numbers)-1] {
		addr += n << (8 * (3 - i))
	}
	return strconv.FormatUint(addr>>24, 10) + "." + strconv.FormatUint(addr>>16&255, 10) + "." +
		strconv.FormatUint(addr>>8&255, 10) + "." + strconv.FormatUint(addr&255, 10), true
}

func ipv4Number(p string) (uint64, bool) {
	if p == "" {
		return 0, false
	}
	base := 10
	switch {
	case len(p) >= 2 && p[0] == '0' && p[1]|0x20 == 'x':
		p, base = p[2:], 16
	case len(p) >= 2 && p[0] == '0':
		p, base = p[1:], 8
	}
	if p == "" {
		return 0, true
	}
	n, err := strconv.ParseUint(p, base, 64)
	if err != nil {
		// Out of range digits are still a number: larger than any address.
		if errors.Is(err, strconv.ErrRange) {
			return 1 << 40, true
		}
		return 0, false
	}
	return n, true
}

// parseIPv6 parses "[…]" as the URL Standard does and serializes it: lower-case hexadecimal, the
// first longest run of two or more zero pieces compressed, an embedded IPv4 written as two pieces.
func parseIPv6(bracketed string) (string, bool) {
	s := bracketed[1 : len(bracketed)-1]
	var pieces [8]uint16
	piece, compress := 0, -1
	i := 0
	if strings.HasPrefix(s, ":") {
		if !strings.HasPrefix(s, "::") {
			return "", false
		}
		i, piece, compress = 2, 1, 1
	}
	for i < len(s) {
		if piece == 8 {
			return "", false
		}
		if s[i] == ':' {
			if compress >= 0 {
				return "", false
			}
			i++
			piece++
			compress = piece
			continue
		}
		value, length := 0, 0
		for length < 4 && i < len(s) && isHex(s[i]) {
			v, _ := strconv.ParseUint(s[i:i+1], 16, 8)
			value = value*16 + int(v)
			i++
			length++
		}
		if i < len(s) && s[i] == '.' {
			if length == 0 || piece > 6 {
				return "", false
			}
			i -= length
			seen := 0
			for i < len(s) {
				v := -1
				if seen > 0 {
					if s[i] != '.' || seen >= 4 {
						return "", false
					}
					i++
				}
				if i >= len(s) || s[i] < '0' || s[i] > '9' {
					return "", false
				}
				for i < len(s) && s[i] >= '0' && s[i] <= '9' {
					n := int(s[i] - '0')
					switch v {
					case -1:
						v = n
					case 0:
						return "", false
					default:
						v = v*10 + n
					}
					if v > 255 {
						return "", false
					}
					i++
				}
				pieces[piece] = pieces[piece]*0x100 + uint16(v) //nolint:gosec // v is checked to be at most 255
				seen++
				if seen == 2 || seen == 4 {
					piece++
				}
			}
			if seen != 4 {
				return "", false
			}
			break
		}
		if i < len(s) && s[i] == ':' {
			i++
			if i >= len(s) {
				return "", false
			}
		} else if i < len(s) {
			return "", false
		}
		pieces[piece] = uint16(value)
		piece++
	}
	if compress >= 0 {
		swaps := piece - compress
		piece = 7
		for piece != 0 && swaps > 0 {
			pieces[piece], pieces[compress+swaps-1] = pieces[compress+swaps-1], pieces[piece]
			piece--
			swaps--
		}
	} else if piece != 8 {
		return "", false
	}
	return "[" + serializeIPv6(pieces) + "]", true
}

func serializeIPv6(p [8]uint16) string {
	start, length := -1, 1
	for i := 0; i < 8; {
		if p[i] != 0 {
			i++
			continue
		}
		j := i
		for j < 8 && p[j] == 0 {
			j++
		}
		if j-i > length {
			start, length = i, j-i
		}
		i = j
	}
	var b strings.Builder
	ignore0 := false
	for i := 0; i < 8; i++ {
		if ignore0 && p[i] == 0 {
			continue
		}
		ignore0 = false
		if i == start {
			if i == 0 {
				b.WriteString("::")
			} else {
				b.WriteString(":")
			}
			ignore0 = true
			continue
		}
		b.WriteString(strconv.FormatUint(uint64(p[i]), 16))
		if i != 7 {
			b.WriteString(":")
		}
	}
	return b.String()
}
