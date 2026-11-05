package config

import (
	"errors"
	"net/url"
)

// The defaults of apps/api/src/platform/config.ts.
const (
	defaultOllamaURL   = "http://127.0.0.1:11434"
	defaultOllamaModel = "nomic-embed-text"
)

// Ollama is the embeddings server, read as parseOllama of apps/api/src/platform/config.ts.
type Ollama struct {
	// BaseURL is SIPGES_OLLAMA_URL, or the loopback default.
	BaseURL string
	// Model is SIPGES_OLLAMA_EMBED_MODEL, or the default when unset or empty.
	Model string
	// Configured says SIPGES_OLLAMA_URL was set.
	Configured bool
	// SemanticSearch is SIPGES_SEMANTIC_SEARCH, off by default.
	SemanticSearch bool
}

// LoadOllama validates the embeddings settings; a malformed value stops the start, as in apps/api.
func LoadOllama(lookup Lookup) (Ollama, error) {
	cfg := Ollama{BaseURL: defaultOllamaURL, Model: defaultOllamaModel}
	if v, ok := lookup("SIPGES_OLLAMA_URL"); ok {
		cfg.BaseURL, cfg.Configured = v, true
	}
	if err := checkOllamaURL(cfg.BaseURL); err != nil {
		return Ollama{}, err
	}
	if v, _ := lookup("SIPGES_OLLAMA_EMBED_MODEL"); v != "" {
		cfg.Model = v
	}
	var err error
	cfg.SemanticSearch, err = parseSwitch(lookup, "SIPGES_SEMANTIC_SEARCH", false)
	if err != nil {
		return Ollama{}, err
	}
	return cfg, nil
}

func checkOllamaURL(raw string) error {
	notAbsolute := errors.New("SIPGES_OLLAMA_URL must be an absolute URL")
	parsed, err := url.Parse(raw)
	if err != nil || parsed.Scheme == "" {
		return notAbsolute
	}
	if parsed.Scheme != "http" && parsed.Scheme != "https" {
		return errors.New("SIPGES_OLLAMA_URL must use http or https")
	}
	if parsed.Hostname() == "" {
		return notAbsolute
	}
	return nil
}
