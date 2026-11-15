package config

import (
	"errors"
	"net/url"
	"strings"
)

// LoadDefensoriaURL reads SIPGES_DEFENSORIA_URL as parseDefensoriaUrl of
// apps/api/src/platform/config.ts: the endpoint the Defensoría connector asks. Unset or empty
// returns "", the official https://www.defensoria.gob.pe/wp-json/wp/v2/posts. Only a synthetic
// double needs another one; imported posts must still link to the official host.
func LoadDefensoriaURL(lookup Lookup) (string, error) {
	value, _ := lookup("SIPGES_DEFENSORIA_URL")
	if value == "" {
		return "", nil
	}
	invalid := errors.New("SIPGES_DEFENSORIA_URL must be an absolute http or https URL without a query")
	parsed, err := url.Parse(value)
	if err != nil || (parsed.Scheme != "http" && parsed.Scheme != "https") || parsed.Host == "" ||
		strings.ContainsAny(value, "?#") {
		return "", invalid
	}
	return value, nil
}
