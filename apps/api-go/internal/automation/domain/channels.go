package domain

import (
	"regexp"
	"strconv"
	"strings"

	situations "github.com/Dreamcoder08/sipges/apps/api-go/internal/situations/domain"
)

// Outbound destinations an administrator configures: domain/channels.ts (docs/adr/0014 §5).

// ChannelKinds is CHANNEL_KINDS.
var ChannelKinds = []string{"webhook", "slack", "teams", "discord", "gchat", "telegram", "email"}

// ChannelConfig is the secret configuration, sealed at rest; JSON as channels.ts writes it.
type ChannelConfig struct {
	Kind     string   `json:"kind"`
	URL      string   `json:"url,omitempty"`
	Secret   string   `json:"secret,omitempty"`
	BotToken string   `json:"botToken,omitempty"`
	ChatID   string   `json:"chatId,omitempty"`
	APIKey   string   `json:"apiKey,omitempty"`
	From     string   `json:"from,omitempty"`
	To       []string `json:"to,omitempty"`
}

// ChannelError is ChannelError.
type ChannelError string

// Channel errors, as validateChannel names them.
const (
	InvalidURL      ChannelError = "invalid_url"
	PrivateHost     ChannelError = "private_host"
	WrongHost       ChannelError = "wrong_host"
	InvalidSettings ChannelError = "invalid_settings"
)

var chatHosts = map[string]*regexp.Regexp{
	"slack":   regexp.MustCompile(`^hooks\.slack\.com$`),
	"discord": regexp.MustCompile(`^(discord\.com|discordapp\.com)$`),
	"gchat":   regexp.MustCompile(`^chat\.googleapis\.com$`),
}

var privateV4 = []*regexp.Regexp{
	regexp.MustCompile(`^0\.`),
	regexp.MustCompile(`^10\.`),
	regexp.MustCompile(`^127\.`),
	regexp.MustCompile(`^169\.254\.`),
	regexp.MustCompile(`^172\.(1[6-9]|2[0-9]|3[01])\.`),
	regexp.MustCompile(`^192\.168\.`),
	regexp.MustCompile(`^100\.(6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])\.`),
}

var (
	dottedQuad = regexp.MustCompile(`^[0-9]{1,3}(\.[0-9]{1,3}){3}$`)
	uniqueV6   = regexp.MustCompile(`^f[cd]`)
	linkV6     = regexp.MustCompile(`^fe[89ab]`)
)

// IsPrivateHost is isPrivateHost: literal loopback, link-local, private or reserved addresses
// and local names.
func IsPrivateHost(hostname string) bool {
	host := strings.ToLower(hostname)
	host = strings.TrimSuffix(strings.TrimPrefix(host, "["), "]")
	if host == "localhost" || strings.HasSuffix(host, ".localhost") || strings.HasSuffix(host, ".local") ||
		strings.HasSuffix(host, ".internal") {
		return true
	}
	if dottedQuad.MatchString(host) {
		for _, re := range privateV4 {
			if re.MatchString(host) {
				return true
			}
		}
		return false
	}
	if strings.Contains(host, ":") {
		return host == "::" || host == "::1" || uniqueV6.MatchString(host) || linkV6.MatchString(host) ||
			strings.HasPrefix(host, "::ffff:")
	}
	return !strings.Contains(host, ".")
}

func checkURL(raw string, expected *regexp.Regexp) (httpsURL, ChannelError) {
	u, ok := parseHTTPS(raw)
	if !ok || u.userinfo || Len16(raw) > 1000 {
		return u, InvalidURL
	}
	if IsPrivateHost(u.hostname) {
		return u, PrivateHost
	}
	if expected != nil && !expected.MatchString(u.hostname) {
		return u, WrongHost
	}
	return u, ""
}

// Setting is one value of ChannelIn.settings: a string, or a list of strings.
type Setting struct {
	Text   string
	List   []string
	IsList bool
}

// text is text() of channels.ts: a trimmed string, ” for anything else.
func (s Setting) text() string {
	if s.IsList {
		return ""
	}
	return situations.TrimJS(s.Text)
}

var (
	telegramToken = regexp.MustCompile(`^[0-9]{5,15}:[A-Za-z0-9_-]{30,50}$`)
	telegramChat  = regexp.MustCompile(`^(-?[0-9]{1,20}|@[A-Za-z0-9_]{5,32})$`)
	resendKey     = regexp.MustCompile(`^re_[A-Za-z0-9_]{10,120}$`)
)

// ValidateChannel is validateChannel: the configuration to seal and a safe hint, or an error.
func ValidateChannel(kind string, settings map[string]Setting) (ChannelConfig, string, ChannelError) {
	switch kind {
	case "webhook":
		u, bad := checkURL(settings["url"].text(), nil)
		if bad != "" {
			return ChannelConfig{}, "", bad
		}
		secret := settings["secret"].text()
		if n := Len16(secret); n < 24 || n > 200 {
			return ChannelConfig{}, "", InvalidSettings
		}
		return ChannelConfig{Kind: kind, URL: u.href, Secret: secret}, u.host, ""
	case "slack", "discord", "gchat", "teams":
		u, bad := checkURL(settings["url"].text(), chatHosts[kind])
		if bad != "" {
			return ChannelConfig{}, "", bad
		}
		return ChannelConfig{Kind: kind, URL: u.href}, u.host, ""
	case "telegram":
		token, chat := settings["bot_token"].text(), settings["chat_id"].text()
		if !telegramToken.MatchString(token) || !telegramChat.MatchString(chat) {
			return ChannelConfig{}, "", InvalidSettings
		}
		return ChannelConfig{Kind: kind, BotToken: token, ChatID: chat}, "chat " + chat, ""
	case "email":
		apiKey, from := settings["api_key"].text(), settings["from"].text()
		var to []string
		raw := settings["to"]
		parts := raw.List
		if !raw.IsList {
			parts = strings.Split(raw.text(), ",")
		}
		for _, p := range parts {
			if t := situations.TrimJS(p); t != "" {
				to = append(to, t)
			}
		}
		if !resendKey.MatchString(apiKey) || !validSender(from) {
			return ChannelConfig{}, "", InvalidSettings
		}
		if len(to) == 0 || len(to) > 20 {
			return ChannelConfig{}, "", InvalidSettings
		}
		for _, a := range to {
			if !validEmail(a) {
				return ChannelConfig{}, "", InvalidSettings
			}
		}
		return ChannelConfig{Kind: kind, APIKey: apiKey, From: from, To: to}, maskList(to), ""
	}
	return ChannelConfig{}, "", InvalidSettings // unreachable: the schema allows only these kinds
}

// validEmail is EMAIL: /^[^\s@<>()]{1,64}@[a-z0-9.-]{1,190}\.[a-z]{2,24}$/i, with JavaScript's
// \s and UTF-16 counts.
func validEmail(s string) bool {
	local, domain, ok := strings.Cut(s, "@")
	if !ok || !validLocal(local) {
		return false
	}
	dot := strings.LastIndexByte(domain, '.')
	if dot < 1 || dot > 190 {
		return false
	}
	tld := domain[dot+1:]
	if len(tld) < 2 || len(tld) > 24 {
		return false
	}
	for i := 0; i < len(domain); i++ {
		c := domain[i] | 0x20
		letter := c >= 'a' && c <= 'z'
		if i > dot && !letter || i < dot && !letter && (domain[i] < '0' || domain[i] > '9') && domain[i] != '.' && domain[i] != '-' {
			return false
		}
	}
	return true
}

func validLocal(local string) bool {
	if n := Len16(local); n < 1 || n > 64 {
		return false
	}
	for _, r := range local {
		if situations.IsJSSpace(r) || strings.ContainsRune("@<>()", r) {
			return false
		}
	}
	return true
}

// validSender is SENDER: an address, optionally after `Name <` and before `>`.
func validSender(s string) bool {
	if i := strings.IndexByte(s, '<'); i >= 0 {
		name := s[:i]
		if n := Len16(name); n < 1 || n > 80 || strings.ContainsRune(name, '>') {
			return false
		}
		s = s[i+1:]
	}
	return validEmail(strings.TrimSuffix(s, ">"))
}

func maskList(addresses []string) string {
	user, domain, _ := strings.Cut(addresses[0], "@")
	if i := strings.IndexByte(domain, '@'); i >= 0 {
		domain = domain[:i]
	}
	masked := Slice16(user, 2) + "…@" + domain
	if len(addresses) > 1 {
		return masked + " y " + strconv.Itoa(len(addresses)-1) + " más"
	}
	return masked
}
