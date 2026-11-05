package domain

import (
	"net/netip"
	"strconv"
	"strings"
)

// httpsURL is what checkUrl of channels.ts reads from `new URL(raw)`.
type httpsURL struct {
	href     string
	host     string // hostname[:port], as URL.host
	hostname string // as URL.hostname: IPv6 in brackets
	userinfo bool
}

// parseHTTPS reads an absolute https URL the way the WHATWG URL parser does, for the subset of
// inputs whose serialization it can reproduce exactly: printable ASCII without backslashes,
// ASCII host names (no punycode), canonical dotted IPv4 and bracketed IPv6. Anything else fails,
// so the Go API refuses (422 invalid_url) a few unusual URLs the TypeScript API would accept
// and normalize (an IDN host, `https://0x7f.1/`, `https://@host`), and never stores a
// destination it serializes differently. ok is false when the input is not an https URL here.
func parseHTTPS(raw string) (httpsURL, bool) {
	for i := 0; i < len(raw); i++ {
		if c := raw[i]; c <= ' ' || c >= 0x7f || c == '\\' || c == '"' || c == '<' || c == '>' || c == '`' ||
			c == '{' || c == '}' || c == '|' || c == '^' {
			return httpsURL{}, false
		}
	}
	scheme, rest, ok := strings.Cut(raw, ":")
	if !ok || !strings.EqualFold(scheme, "https") || !strings.HasPrefix(rest, "//") {
		// Other schemes parse in WHATWG too, but checkUrl refuses them with the same error.
		return httpsURL{}, false
	}
	rest = rest[2:]
	end := strings.IndexAny(rest, "/?#")
	if end < 0 {
		end = len(rest)
	}
	authority, tail := rest[:end], rest[end:]
	u := httpsURL{}
	if strings.Contains(authority, "@") {
		// WHATWG reads credentials here; checkUrl refuses any, and an empty one is refused too.
		u.userinfo = true
		return u, true
	}
	hostPart, port, ok := splitPort(authority)
	if !ok {
		return httpsURL{}, false
	}
	hostname, ok := canonicalHost(hostPart)
	if !ok {
		return httpsURL{}, false
	}
	u.hostname = hostname
	u.host = hostname
	if port != "" {
		u.host += ":" + port
	}
	path, query, fragment := tail, "", ""
	if i := strings.IndexByte(path, '#'); i >= 0 {
		path, fragment = path[:i], path[i:]
	}
	if i := strings.IndexByte(path, '?'); i >= 0 {
		path, query = path[:i], path[i:]
	}
	if strings.ContainsRune(query, '\'') {
		return httpsURL{}, false // percent-encoded in special-scheme queries
	}
	path, ok = canonicalPath(path)
	if !ok {
		return httpsURL{}, false
	}
	u.href = "https://" + u.host + path + query + fragment
	return u, true
}

// splitPort separates host and port; the default port 443 and an empty port are dropped.
func splitPort(authority string) (string, string, bool) {
	host, port := authority, ""
	if strings.HasPrefix(authority, "[") {
		end := strings.IndexByte(authority, ']')
		if end < 0 {
			return "", "", false
		}
		host = authority[:end+1]
		switch after := authority[end+1:]; {
		case after == "":
		case strings.HasPrefix(after, ":"):
			port = after[1:]
		default:
			return "", "", false
		}
	} else if i := strings.IndexByte(authority, ':'); i >= 0 {
		host, port = authority[:i], authority[i+1:]
	}
	if port == "" {
		return host, "", true
	}
	if strings.Trim(port, "0123456789") != "" {
		return "", "", false
	}
	n, err := strconv.Atoi(strings.TrimLeft(port, "0") + "0")
	if err != nil || n/10 > 65535 {
		return "", "", false
	}
	n /= 10
	if n == 443 {
		return host, "", true
	}
	return host, strconv.Itoa(n), true
}

// canonicalHost is the WHATWG host serialization for ASCII names, dotted IPv4 and IPv6.
func canonicalHost(host string) (string, bool) {
	if host == "" {
		return "", false
	}
	if strings.HasPrefix(host, "[") {
		addr, err := netip.ParseAddr(host[1 : len(host)-1])
		if err != nil || !addr.Is6() || addr.Zone() != "" || strings.Contains(host, ".") {
			return "", false // IPv4-embedded forms serialize differently in WHATWG
		}
		return "[" + ipv6(addr.As16()) + "]", true
	}
	host = strings.ToLower(host)
	for i := 0; i < len(host); i++ {
		if c := host[i]; (c < 'a' || c > 'z') && (c < '0' || c > '9') && c != '-' && c != '.' {
			return "", false
		}
	}
	labels := strings.Split(strings.TrimSuffix(host, "."), ".")
	for _, label := range labels {
		if label == "" && len(labels) > 1 || strings.HasPrefix(label, "xn--") {
			return "", false
		}
	}
	if last := labels[len(labels)-1]; numericLabel(last) {
		// WHATWG parses a host ending in a number as IPv4; only the canonical form is kept.
		if len(labels) != 4 || strings.HasSuffix(host, ".") {
			return "", false
		}
		for _, label := range labels {
			n, err := strconv.Atoi(label)
			if err != nil || n > 255 || strconv.Itoa(n) != label {
				return "", false
			}
		}
	}
	return host, true
}

func numericLabel(label string) bool {
	if label == "" {
		return false
	}
	if strings.Trim(label, "0123456789") == "" {
		return true
	}
	return strings.HasPrefix(label, "0x") && strings.Trim(label[2:], "0123456789abcdef") == ""
}

// ipv6 is the WHATWG IPv6 serializer: lower-case hex pieces, the first longest run of two or
// more zero pieces compressed.
func ipv6(b [16]byte) string {
	var pieces [8]uint16
	for i := range pieces {
		pieces[i] = uint16(b[2*i])<<8 | uint16(b[2*i+1])
	}
	start, length := -1, 1
	for i := 0; i < 8; {
		if pieces[i] != 0 {
			i++
			continue
		}
		j := i
		for j < 8 && pieces[j] == 0 {
			j++
		}
		if j-i > length {
			start, length = i, j-i
		}
		i = j
	}
	var sb strings.Builder
	for i := 0; i < 8; i++ {
		if i == start {
			if i == 0 {
				sb.WriteString("::")
			} else {
				sb.WriteString(":")
			}
			i += length - 1
			continue
		}
		sb.WriteString(strconv.FormatUint(uint64(pieces[i]), 16))
		if i < 7 {
			sb.WriteString(":")
		}
	}
	return sb.String()
}

// canonicalPath resolves dot segments as WHATWG does; an empty path is "/".
func canonicalPath(path string) (string, bool) {
	if strings.Contains(strings.ToLower(path), "%2e") {
		return "", false // percent-encoded dot segments: not reproduced here
	}
	if path == "" {
		return "/", true
	}
	segments := strings.Split(path[1:], "/")
	var out []string
	for i, s := range segments {
		last := i == len(segments)-1
		switch s {
		case ".":
			if last {
				out = append(out, "")
			}
		case "..":
			if len(out) > 0 {
				out = out[:len(out)-1]
			}
			if last {
				out = append(out, "")
			}
		default:
			out = append(out, s)
		}
	}
	return "/" + strings.Join(out, "/"), true
}
