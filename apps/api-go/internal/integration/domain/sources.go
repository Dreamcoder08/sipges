//nolint:misspell // Spanish module names, fields and messages, verbatim from the TypeScript API.
package domain

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"regexp"
	"strconv"
	"strings"
	"time"

	records "github.com/Dreamcoder08/sipges/apps/api-go/internal/records/domain"
)

// The Defensoría del Pueblo connector (official-source.ts, authorized-sources.ts) and the
// narratives imported from authorized public sources.

// OfficialHost is the only host the connector reads.
const OfficialHost = "www.defensoria.gob.pe"

// The connector's failures (source_<reason>).
const (
	SourceUnavailable   = "source_unavailable"
	SourceTooLarge      = "source_response_too_large"
	SourceInvalidData   = "source_invalid_data"
	SourceTimeout       = "source_timeout"
	SourceInvalidQuery  = "source_invalid_query"
	SourceInvalidID     = "source_invalid_id"
	SourceNotFound      = "source_not_found"
	SourceCollision     = "source_identity_collision"
	SourcePollFailed    = "source_poll_failed"
	officialAttribution = "Defensoría del Pueblo del Perú"
)

// SourceError is a connector failure with its code.
type SourceError struct{ Code string }

func (e *SourceError) Error() string { return e.Code }

var sourceCode = regexp.MustCompile(`^source_[a-z_]+$`)

// PollErrorCode is the code authorized-sources.ts `poll` stores: the failure's own
// source_<reason>, or source_poll_failed.
func PollErrorCode(err error) string {
	var se *SourceError
	if errors.As(err, &se) && sourceCode.MatchString(se.Code) {
		return se.Code
	}
	return SourcePollFailed
}

// OfficialPost is OfficialSourcePost: the metadata of one publication.
type OfficialPost struct {
	ID          int    `json:"id"`
	URL         string `json:"url"`
	Title       string `json:"title"`
	Excerpt     string `json:"excerpt"`
	PublishedAt string `json:"published_at"`
}

var officialEntity = regexp.MustCompile(`&(#[xX][0-9a-fA-F]+|#[0-9]+|` + ci("amp") + `|` + ci("lt") + `|` + ci("gt") + `|` + ci("quot") + `|` + ci("apos") + `|` + ci("nbsp") + `);`)

// officialPlain is `plain` of official-source.ts: like PlainText, but entities are decoded after
// the tags are removed and before spaces collapse, and only the six named ones.
func officialPlain(value string) string {
	value = anyTag.ReplaceAllString(scriptStyle.ReplaceAllString(value, ""), " ")
	value = officialEntity.ReplaceAllStringFunc(value, func(match string) string {
		e := match[1 : len(match)-1]
		if e[0] != '#' {
			return xmlEntities[strings.ToLower(e)]
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
	return TrimJS(spaces.ReplaceAllString(value, " "))
}

var dateGMT = regexp.MustCompile(`^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$`)

// OfficialPostFrom checks one row of the WordPress answer as official-source.ts does: the link on
// the official host over https, a real UTC date, title and excerpt as plain text. ok is false for
// source_invalid_data.
func OfficialPostFrom(id int, link, date, title, excerpt string) (OfficialPost, bool) {
	u, parses := ParseURL(link)
	if !parses || !dateGMT.MatchString(date) {
		return OfficialPost{}, false
	}
	t, err := time.Parse("2006-01-02T15:04:05", date)
	if !strings.HasPrefix(link, "https://"+OfficialHost+"/") || u.Protocol != "https:" ||
		u.Hostname != OfficialHost || u.Port != "" || u.Username != "" || u.Password != "" ||
		err != nil || t.Format("2006-01-02T15:04:05") != date {
		return OfficialPost{}, false
	}
	return OfficialPost{
		ID: id, URL: u.Href,
		Title:       Slice16(officialPlain(title), 500),
		Excerpt:     Slice16(officialPlain(excerpt), 1500),
		PublishedAt: ISOString(t),
	}, true
}

// OfficialQuery is the WordPress query URLSearchParams serializes (keys in insertion order).
func OfficialQuery(pairs ...string) string {
	var b strings.Builder
	for i := 0; i+1 < len(pairs); i += 2 {
		if i > 0 {
			b.WriteByte('&')
		}
		b.WriteString(formEncode(pairs[i]) + "=" + formEncode(pairs[i+1]))
	}
	return b.String()
}

// formEncode is the application/x-www-form-urlencoded serializer: space as '+', every byte but
// ASCII alphanumerics and *-._ percent-encoded.
func formEncode(s string) string {
	var b strings.Builder
	for i := 0; i < len(s); i++ {
		c := s[i]
		switch {
		case c == ' ':
			b.WriteByte('+')
		case c >= 'a' && c <= 'z', c >= 'A' && c <= 'Z', c >= '0' && c <= '9', strings.IndexByte("*-._", c) >= 0:
			b.WriteByte(c)
		default:
			b.WriteString("%" + strings.ToUpper(hex.EncodeToString([]byte{c})))
		}
	}
	return b.String()
}

func sha256Hex(s string) string {
	sum := sha256.Sum256([]byte(s))
	return hex.EncodeToString(sum[:])
}

// stringify is JSON.stringify of an array of strings and numbers.
func stringify(values ...any) string { return string(records.Stringify(values)) }

// OfficialNarrative is importMetadata of authorized-sources.ts: the narrative's canonical id and
// payload for a publication; territory is the trimmed one or "".
func OfficialNarrative(post OfficialPost, territory string, observedAt time.Time) (string, *records.Object) {
	fingerprint := sha256Hex(stringify(float64(post.ID), post.URL, post.Title, post.Excerpt, post.PublishedAt))
	p := records.NewObject()
	p.Set("Descripcion", post.Title+"\n\n"+post.Excerpt)
	p.Set("URL_Publicacion", post.URL)
	p.Set("Plataforma/Fuente", officialAttribution)
	p.Set("Tipo_Fuente", "Publicación digital")
	p.Set("Fuente_Integracion", "defensoria")
	p.Set("Fuente_Huella_SHA256", fingerprint)
	p.Set("Fuente_ID_Externo", strconv.Itoa(post.ID))
	p.Set("Fuente_Publicada_En", post.PublishedAt)
	p.Set("Fuente_Observada_En", ISOString(observedAt))
	if t := TrimJS(territory); t != "" {
		p.Set("Territorio", t)
	}
	return "SRC-DEF-" + strconv.Itoa(post.ID) + "-" + fingerprint[:16], p
}

// limaDay is the calendar day in Peru (America/Lima has kept UTC-5 without daylight saving
// since 1994), as Intl.DateTimeFormat('en-CA', { timeZone: 'America/Lima' }) formats it.
var lima = time.FixedZone("America/Lima", -5*60*60)

// FeedNarrative is importItem of media-monitor.ts: one narrative per item and source, its id
// from the feed URL and the item's key.
func FeedNarrative(feedURL, feedName, feedTerritory string, item FeedItem, matched []string, observed time.Time) (string, *records.Object) {
	identity := sha256Hex(feedURL + "\n" + item.Key)
	day := observed
	if item.PublishedAt != nil {
		if t, ok := ParseDateJS(*item.PublishedAt); ok {
			day = t
		}
	}
	p := records.NewObject()
	if item.Summary != "" {
		p.Set("Descripcion", item.Title+"\n\n"+item.Summary)
	} else {
		p.Set("Descripcion", item.Title)
	}
	if len(matched) > 0 {
		p.Set("Tema", matched[0])
	}
	p.Set("URL_Publicacion", item.Link)
	p.Set("Plataforma/Fuente", feedName)
	p.Set("Tipo_Fuente", "Medio digital (RSS)")
	p.Set("Fecha_Observacion", day.In(lima).Format("2006-01-02"))
	if len(matched) > 0 {
		p.Set("Palabras_Clave", strings.Join(matched, ", "))
	}
	if feedTerritory != "" {
		p.Set("Territorio", feedTerritory)
	}
	p.Set("Fuente_Integracion", "rss")
	p.Set("Fuente_Huella_SHA256", identity)
	p.Set("Fuente_ID_Externo", item.Key)
	published := ""
	if item.PublishedAt != nil {
		published = *item.PublishedAt
	}
	p.Set("Fuente_Publicada_En", published)
	p.Set("Fuente_Observada_En", ISOString(observed))
	return "SRC-RSS-" + identity[:24], p
}

// SignalNarrative is the body signal-routes.ts ingests, with its fingerprint (the default
// idempotency key is "signal-" and the fingerprint).
func SignalNarrative(s Signal) (string, *records.Object) {
	observed, _ := ParseDateJS(s.ObservedAt)
	territory := ""
	if s.Territory != nil {
		territory = *s.Territory
	}
	fingerprint := sha256Hex(stringify(s.SourceName, s.SourceURL, s.ExternalID, s.Text, ISOString(observed), territory))
	p := records.NewObject()
	p.Set("Descripcion", s.Text)
	p.Set("URL_Publicacion", s.SourceURL)
	p.Set("Plataforma/Fuente", s.SourceName)
	p.Set("Tipo_Fuente", "Publicación digital")
	p.Set("Fuente_Integracion", "structured-hook")
	p.Set("Fuente_ID_Externo", s.ExternalID)
	p.Set("Fuente_Huella_SHA256", fingerprint)
	p.Set("Fuente_Observada_En", s.ObservedAt)
	if territory != "" {
		p.Set("Territorio", territory)
	}
	return fingerprint, p
}
