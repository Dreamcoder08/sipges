package config

import (
	"errors"
	"net"
	"net/url"
	"regexp"
	"strings"
	"unicode"
)

const (
	defaultAnalystModel = "claude-opus-5-5"

	// The values of SIPGES_ANALYST_PROVIDER that switch the narrator on.
	ProviderAnthropic        = "anthropic"
	ProviderOpenAICompatible = "openai-compatible"
)

var (
	modelID = regexp.MustCompile(`^[a-z0-9][a-z0-9.-]{1,63}\z`)
	// compatibleModelID admits what providers name their models: deepseek-chat, deepseek/deepseek-chat, llama3.1:8b.
	compatibleModelID = regexp.MustCompile(`^[A-Za-z0-9._:/-]{1,128}\z`)
)

// Analyst is the assisted briefing's narrator, read as parseAnalyst of
// apps/api/src/platform/config.ts: off unless SIPGES_ANALYST_PROVIDER names a provider. The
// credentials stay in the environment, where the narrator reads them; nothing here keeps them.
type Analyst struct {
	Enabled bool
	// Provider is ProviderAnthropic or ProviderOpenAICompatible once Enabled.
	Provider string
	// Model is SIPGES_ANALYST_MODEL, or the default of anthropic when unset or empty.
	Model string
}

// LoadAnalyst validates the narrator's settings; a malformed value stops the start, as in apps/api.
func LoadAnalyst(lookup Lookup) (Analyst, error) {
	provider, _ := lookup("SIPGES_ANALYST_PROVIDER")
	switch provider {
	case "", "none":
		return Analyst{}, nil
	case ProviderAnthropic:
		return loadAnthropicAnalyst(lookup)
	case ProviderOpenAICompatible:
		return loadCompatibleAnalyst(lookup)
	}
	return Analyst{}, errors.New("SIPGES_ANALYST_PROVIDER must be unset, 'none', 'anthropic' or 'openai-compatible'")
}

func loadAnthropicAnalyst(lookup Lookup) (Analyst, error) {
	key, _ := lookup("ANTHROPIC_API_KEY")
	token, _ := lookup("ANTHROPIC_AUTH_TOKEN")
	if key == "" && token == "" {
		return Analyst{}, errors.New("SIPGES_ANALYST_PROVIDER=anthropic requires ANTHROPIC_API_KEY")
	}
	model, _ := lookup("SIPGES_ANALYST_MODEL")
	if model == "" {
		model = defaultAnalystModel
	}
	if !modelID.MatchString(model) {
		return Analyst{}, errors.New("SIPGES_ANALYST_MODEL is not a valid model id")
	}
	return Analyst{Enabled: true, Provider: ProviderAnthropic, Model: model}, nil
}

// loadCompatibleAnalyst checks the OpenAI-compatible provider in the order of its messages: base
// URL, key, model. The key is optional only for a loopback server such as Ollama.
func loadCompatibleAnalyst(lookup Lookup) (Analyst, error) {
	base, _ := lookup("SIPGES_ANALYST_BASE_URL")
	base = trimJS(base)
	if base == "" {
		return Analyst{}, errors.New("SIPGES_ANALYST_PROVIDER=openai-compatible requires SIPGES_ANALYST_BASE_URL")
	}
	loopback, ok := analystBaseURL(base)
	if !ok {
		return Analyst{}, errors.New("SIPGES_ANALYST_BASE_URL must be https, or http on a loopback host")
	}
	key, _ := lookup("SIPGES_ANALYST_API_KEY")
	if trimJS(key) == "" && !loopback {
		return Analyst{}, errors.New("SIPGES_ANALYST_PROVIDER=openai-compatible requires SIPGES_ANALYST_API_KEY")
	}
	model, _ := lookup("SIPGES_ANALYST_MODEL")
	if model == "" {
		return Analyst{}, errors.New("SIPGES_ANALYST_PROVIDER=openai-compatible requires SIPGES_ANALYST_MODEL")
	}
	if !compatibleModelID.MatchString(model) {
		return Analyst{}, errors.New("SIPGES_ANALYST_MODEL is not a valid model id")
	}
	return Analyst{Enabled: true, Provider: ProviderOpenAICompatible, Model: model}, nil
}

// analystBaseURL says whether the URL is https, or http on a loopback host, and whether its host
// is loopback.
func analystBaseURL(raw string) (loopback, ok bool) {
	parsed, err := url.Parse(raw)
	if err != nil || parsed.Hostname() == "" {
		return false, false
	}
	loopback = isLoopbackHost(parsed.Hostname())
	switch parsed.Scheme {
	case "https":
		return loopback, true
	case "http":
		return loopback, loopback
	}
	return false, false
}

func isLoopbackHost(host string) bool {
	if strings.EqualFold(host, "localhost") {
		return true
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}

// trimJS is String.prototype.trim: white space as JavaScript counts it, which has the byte order
// mark and lacks U+0085.
func trimJS(s string) string {
	return strings.TrimFunc(s, func(r rune) bool { return r == '\ufeff' || (r != '\u0085' && unicode.IsSpace(r)) })
}
