package config

import (
	"errors"
	"regexp"
)

const defaultAnalystModel = "claude-opus-5-5"

var modelID = regexp.MustCompile(`^[a-z0-9][a-z0-9.-]{1,63}\z`)

// Analyst is the assisted briefing's narrator, read as parseAnalyst of
// apps/api/src/platform/config.ts: off unless SIPGES_ANALYST_PROVIDER=anthropic. The credential
// stays in the environment, where the Anthropic SDK reads it; nothing here keeps it.
type Analyst struct {
	Enabled bool
	// Model is SIPGES_ANALYST_MODEL, or the default when unset or empty.
	Model string
}

// LoadAnalyst validates the narrator's settings; a malformed value stops the start, as in apps/api.
func LoadAnalyst(lookup Lookup) (Analyst, error) {
	provider, _ := lookup("SIPGES_ANALYST_PROVIDER")
	if provider == "" || provider == "none" {
		return Analyst{}, nil
	}
	if provider != "anthropic" {
		return Analyst{}, errors.New("SIPGES_ANALYST_PROVIDER must be unset, 'none' or 'anthropic'")
	}
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
	return Analyst{Enabled: true, Model: model}, nil
}
