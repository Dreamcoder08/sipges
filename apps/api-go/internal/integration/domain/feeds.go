//nolint:misspell // Spanish module names, fields and messages, verbatim from the TypeScript API.
package domain

import (
	"errors"
	"net/netip"
	"regexp"
	"strconv"
	"strings"
	"unicode"

	"golang.org/x/text/unicode/norm"

	js "github.com/Dreamcoder08/sipges/apps/api-go/internal/situations/domain"
)

// Public RSS 2.0 / Atom feeds for media monitoring (domain/feeds.ts, docs/adr/0021 §1). Pure: no
// I/O. A small reader on purpose: it never expands entities or follows references, it only keeps
// title, link, id, date and a plain-text summary of each item.

// FeedItem is FeedItem: one entry of a feed.
type FeedItem struct {
	// Key is the guid, Atom id or link: what makes the item the same item on the next poll.
	Key     string
	Title   string
	Link    string
	Summary string
	// PublishedAt is an ISO date-time, or nil when the feed gives none or an unreadable one.
	PublishedAt *string
}

// Feed limits of feeds.ts and media-monitor.ts.
const (
	// MaxFeedItems is MAX_FEED_ITEMS: items read from one feed.
	MaxFeedItems = 50
	// MaxFeedKeywords is MAX_FEED_KEYWORDS.
	MaxFeedKeywords = 30
	// ItemsPerPoll is ITEMS_PER_POLL: new items imported per feed and poll.
	ItemsPerPoll = 20
)

var xmlEntities = map[string]string{"amp": "&", "lt": "<", "gt": ">", "quot": `"`, "apos": "'", "nbsp": " "}

var (
	entity      = regexp.MustCompile(`&(#[xX][0-9a-fA-F]+|#[0-9]+|[a-zA-Z]+);`)
	scriptStyle = regexp.MustCompile(`<(?:` + ci("script") + `\b[^>]*>(?s:.*?)</` + ci("script") + `|` +
		ci("style") + `\b[^>]*>(?s:.*?)</` + ci("style") + `)>`)
	anyTag       = regexp.MustCompile(`<[^>]*>`)
	spaces       = regexp.MustCompile(`[` + jsSpace + `]+`)
	cdata        = regexp.MustCompile(`^[` + jsSpace + `]*<!\[CDATA\[((?s:.*?))\]\]>[` + jsSpace + `]*$`)
	itemOpen     = regexp.MustCompile(`<` + ci("item") + `[` + jsSpace + `>]`)
	entryOpen    = regexp.MustCompile(`<` + ci("entry") + `[` + jsSpace + `>]`)
	itemBlocks   = regexp.MustCompile(`<` + ci("item") + `[` + jsSpace + `>](?s:.*?)</` + ci("item") + `>`)
	entryBlocks  = regexp.MustCompile(`<` + ci("entry") + `[` + jsSpace + `>](?s:.*?)</` + ci("entry") + `>`)
	linkTags     = regexp.MustCompile(`<` + ci("link") + `\b[^>]*>`)
	relAttribute = regexp.MustCompile(`\b` + ci("rel") + `[` + jsSpace + `]*=[` + jsSpace + `]*["']([^"']*)["']`)
	hrefAttr     = regexp.MustCompile(`\b` + ci("href") + `[` + jsSpace + `]*=[` + jsSpace + `]*["']([^"']*)["']`)
	feedRoot     = regexp.MustCompile(`<(?:` + ci("rss") + `|` + ci("feed") + `|` + ci("rdf:RDF") + `)[` + jsSpace + `>]`)
	elements     = map[string]*regexp.Regexp{}
)

func init() {
	for _, name := range []string{"link", "guid", "id", "title", "description", "content:encoded", "summary", "content", "pubDate", "dc:date", "published", "updated"} {
		elements[name] = regexp.MustCompile(`<` + ci(name) + `(?:[` + jsSpace + `][^>]*)?>((?s:.*?))</` + ci(name) + `>`)
	}
}

// decodeEntities decodes the five XML entities, &nbsp; and numeric references; other named
// entities stay as written and out-of-range numbers are dropped.
func decodeEntities(value string) string {
	return entity.ReplaceAllStringFunc(value, func(match string) string {
		e := match[1 : len(match)-1]
		if e[0] != '#' {
			if v, ok := xmlEntities[strings.ToLower(e)]; ok {
				return v
			}
			return match
		}
		var code float64
		if e[1]|0x20 == 'x' {
			code = parseIntHex(e[2:])
		} else {
			code, _ = strconv.ParseFloat(e[1:], 64)
		}
		if code > 0 && code <= 0x10ffff {
			return fromCodePoint(int64(code))
		}
		return ""
	})
}

// parseIntHex is parseInt(s, 16) for hexadecimal digits, as a float that keeps growing.
func parseIntHex(s string) float64 {
	f := 0.0
	for i := 0; i < len(s); i++ {
		d, _ := strconv.ParseUint(s[i:i+1], 16, 8)
		f = f*16 + float64(d)
	}
	return f
}

// PlainText is plainText: HTML or text to one line of plain text.
func PlainText(value string) string {
	value = anyTag.ReplaceAllString(scriptStyle.ReplaceAllString(value, ""), " ")
	return TrimJS(spaces.ReplaceAllString(decodeEntities(value), " "))
}

// content is the text of an element: CDATA as is, otherwise XML-decoded (it may hold escaped HTML).
func content(raw string) string {
	if m := cdata.FindStringSubmatch(raw); m != nil {
		return PlainText(m[1])
	}
	return PlainText(decodeEntities(raw))
}

func element(block string, names ...string) string {
	for _, name := range names {
		if m := elements[name].FindStringSubmatch(block); m != nil {
			return content(m[1])
		}
	}
	return ""
}

// httpURL is the href of an http or https URL, or "" when it is neither.
func httpURL(value string) string {
	u, ok := ParseURL(TrimJS(value))
	if !ok || u.Protocol != "https:" && u.Protocol != "http:" {
		return ""
	}
	return u.Href
}

// atomLink is the alternate link, or the first link without rel.
func atomLink(block string) string {
	for _, tag := range linkTags.FindAllString(block, -1) {
		rel := "alternate"
		if m := relAttribute.FindStringSubmatch(tag); m != nil {
			rel = m[1]
		}
		if m := hrefAttr.FindStringSubmatch(tag); m != nil && rel == "alternate" && m[1] != "" {
			return httpURL(decodeEntities(m[1]))
		}
	}
	return ""
}

// ParseFeed is parseFeed: the items of an RSS 2.0, RSS 1.0 or Atom document; none when it is
// none of them.
func ParseFeed(xml string) []FeedItem {
	atom := !itemOpen.MatchString(xml) && entryOpen.MatchString(xml)
	blocks := itemBlocks
	if atom {
		blocks = entryBlocks
	}
	items := []FeedItem{}
	for _, block := range blocks.FindAllString(xml, MaxFeedItems) {
		var link, id string
		if atom {
			link, id = atomLink(block), element(block, "id")
		} else {
			link, id = httpURL(element(block, "link")), element(block, "guid")
		}
		key := id
		if key == "" {
			key = link
		}
		key = Slice16(key, 500)
		title := Slice16(element(block, "title"), 500)
		if key == "" || link == "" || title == "" {
			continue
		}
		summaryNames, dateNames := []string{"description", "content:encoded"}, []string{"pubDate", "dc:date"}
		if atom {
			summaryNames, dateNames = []string{"summary", "content"}, []string{"published", "updated"}
		}
		items = append(items, FeedItem{
			Key: key, Title: title, Link: link,
			Summary:     Slice16(element(block, summaryNames...), 1500),
			PublishedAt: isoDate(element(block, dateNames...)),
		})
	}
	return items
}

// IsFeedDocument is the gateway's check that an empty result still came from an RSS, Atom or
// RDF document.
func IsFeedDocument(text string) bool { return feedRoot.MatchString(text) }

func isoDate(value string) *string {
	if value == "" {
		return nil
	}
	t, ok := ParseDateJS(value)
	if !ok {
		return nil
	}
	s := ISOString(t)
	return &s
}

// Fold is fold: lower case without accents, so «Contaminación» matches «contaminacion».
func Fold(value string) string {
	decomposed := norm.NFD.String(value)
	var b strings.Builder
	for _, r := range decomposed {
		if !unicode.Is(unicode.M, r) {
			b.WriteRune(r)
		}
	}
	return js.LowerJS(b.String())
}

// words replaces each run of characters that are neither letters nor numbers with one space.
func words(s string) string {
	var b strings.Builder
	gap := false
	for _, r := range s {
		if unicode.IsLetter(r) || unicode.Is(unicode.N, r) {
			if gap {
				b.WriteByte(' ')
				gap = false
			}
			b.WriteRune(r)
			continue
		}
		gap = true
	}
	if gap {
		b.WriteByte(' ')
	}
	return b.String()
}

// MatchedKeywords is matchedKeywords: the keywords the item mentions as whole words.
func MatchedKeywords(item FeedItem, keywords []string) []string {
	text := " " + words(Fold(item.Title+" "+item.Summary)) + " "
	matched := []string{}
	for _, keyword := range keywords {
		w := TrimJS(words(Fold(keyword)))
		if w != "" && strings.Contains(text, " "+w+" ") {
			matched = append(matched, keyword)
		}
	}
	return matched
}

var internalSuffixes = []string{".local", ".localhost", ".internal", ".lan", ".home", ".corp", ".intranet"}

var digitsAndDots = regexp.MustCompile(`^[\d.]+$`)

// FeedURLProblem is feedUrlProblem: why a feed URL may not be polled, or "" when it may (https
// on a public host name, without credentials or a port). Addresses are checked again after DNS
// resolution.
func FeedURLProblem(value string) string {
	if Len16(value) > 500 {
		return "La URL es demasiado larga"
	}
	u, ok := ParseURL(value)
	if !ok {
		return "La URL no es válida"
	}
	if u.Protocol != "https:" {
		return "La URL debe empezar con https://"
	}
	if u.Username != "" || u.Password != "" {
		return "La URL no puede incluir usuario ni contraseña"
	}
	if u.Port != "" {
		return "La URL no puede indicar un puerto"
	}
	host := strings.ToLower(u.Hostname)
	if digitsAndDots.MatchString(host) || strings.Contains(host, ":") || strings.HasPrefix(host, "[") {
		return "Usa el nombre del sitio, no una dirección IP"
	}
	if !strings.Contains(host, ".") || host == "localhost" {
		return "La URL debe ser de un sitio público"
	}
	for _, suffix := range internalSuffixes {
		if strings.HasSuffix(host, suffix) {
			return "La URL debe ser de un sitio público"
		}
	}
	return ""
}

var (
	cgnat     = netip.MustParsePrefix("100.64.0.0/10")
	benchmark = netip.MustParsePrefix("198.18.0.0/15")
	thisNet   = netip.MustParsePrefix("0.0.0.0/8")
	uniqueV6  = netip.MustParsePrefix("fc00::/7")
	linkV6    = netip.MustParsePrefix("fe80::/10")
	nat64     = netip.MustParsePrefix("64:ff9b::/96")
)

// IsPrivateAddress is isPrivateAddress: addresses a public feed may never resolve to (loopback,
// private, link-local, shared, benchmarking, multicast and reserved). It reads the address, not
// its text, so every spelling of an IPv4-mapped IPv6 address counts as the IPv4 one, and it also
// refuses NAT64 addresses, which reach IPv4 through a translator: stricter than the TypeScript
// text match, never looser.
func IsPrivateAddress(addr netip.Addr) bool {
	addr = addr.Unmap()
	if b := addr.As16(); addr.Is6() && [12]byte(b[:12]) == [12]byte{} && !addr.IsLoopback() && !addr.IsUnspecified() {
		addr = netip.AddrFrom4([4]byte(b[12:])) // IPv4-compatible (::a.b.c.d)
	}
	if nat64.Contains(addr) {
		return true
	}
	if addr.Is4() {
		b := addr.As4()
		return thisNet.Contains(addr) || b[0] == 10 || b[0] == 127 || cgnat.Contains(addr) ||
			b[0] == 169 && b[1] == 254 || b[0] == 172 && b[1] >= 16 && b[1] <= 31 ||
			b[0] == 192 && b[1] == 168 || benchmark.Contains(addr) || b[0] >= 224
	}
	return !addr.IsValid() || addr.IsUnspecified() || addr.IsLoopback() || uniqueV6.Contains(addr) ||
		linkV6.Contains(addr) || addr.IsMulticast()
}

// The feed gateway's failures (feed_<reason> of rss-feed-gateway.ts).
const (
	FeedTimeout         = "feed_timeout"
	FeedUnavailable     = "feed_unavailable"
	FeedRedirect        = "feed_redirect"
	FeedTooLarge        = "feed_too_large"
	FeedNotAFeed        = "feed_not_a_feed"
	FeedBlockedAddress  = "feed_blocked_address"
	FeedUnresolved      = "feed_unresolved"
	FeedInvalidURL      = "feed_invalid_url"
	feedFallbackMessage = "No se pudo leer la fuente."
)

var feedErrors = map[string]string{
	FeedTimeout:        "La fuente no respondió a tiempo.",
	FeedUnavailable:    "La fuente respondió con un error.",
	FeedRedirect:       "La fuente redirige a otra dirección; registra la URL final.",
	FeedTooLarge:       "La respuesta de la fuente supera 1 MB.",
	FeedNotAFeed:       "La dirección no devolvió un RSS o Atom legible.",
	FeedBlockedAddress: "La dirección apunta a una red privada y no se consulta.",
	FeedUnresolved:     "No se encontró el sitio de la fuente.",
	FeedInvalidURL:     "La URL de la fuente no es válida.",
}

// FeedError is a gateway failure with its code.
type FeedError struct{ Code string }

func (e *FeedError) Error() string { return e.Code }

// FeedErrorMessage is feedErrorMessage: the Spanish text of a gateway failure.
func FeedErrorMessage(err error) string {
	var fe *FeedError
	if errors.As(err, &fe) {
		if m, ok := feedErrors[fe.Code]; ok {
			return m
		}
	}
	return feedFallbackMessage
}
