// Package config reads the API settings from the environment once, at start. Names match the
// TypeScript API (apps/api/src/platform/config.ts) where both read the same setting.
package config

import (
	"errors"
	"fmt"
	"regexp"
	"strconv"
	"strings"
)

// Lookup reads one environment variable; os.LookupEnv satisfies it.
type Lookup func(key string) (string, bool)

// Config is the validated configuration of the Go API.
type Config struct {
	// Host is the listen address (SIPGES_HOST, default 127.0.0.1; 0.0.0.0 in a container).
	Host string
	// Port is SIPGES_PORT, default 8000.
	Port int
	// DatabaseURL is SIPGES_DATABASE_URL. Required: unlike the TypeScript API there is no
	// embedded PGlite fallback. Never logged or echoed in errors.
	DatabaseURL string
	// AllowedHosts is SIPGES_ALLOWED_HOSTS: host names without port; empty disables the check.
	AllowedHosts []string
	// AccessLog writes one JSON line per request (SIPGES_ACCESS_LOG, default on).
	AccessLog bool
}

// Load validates the environment and reports every invalid variable at once.
func Load(lookup Lookup) (Config, error) {
	var errs []error
	cfg := Config{Host: "127.0.0.1"}
	if v, ok := lookup("SIPGES_HOST"); ok {
		cfg.Host = v
	}
	if v, _ := lookup("SIPGES_DATABASE_URL"); v != "" {
		cfg.DatabaseURL = v
	} else {
		errs = append(errs, errors.New("SIPGES_DATABASE_URL is required"))
	}
	port, err := parsePort(lookup)
	errs = append(errs, err)
	cfg.Port = port
	cfg.AccessLog, err = parseSwitch(lookup, "SIPGES_ACCESS_LOG", true)
	errs = append(errs, err)
	cfg.AllowedHosts, err = parseAllowedHosts(lookup)
	errs = append(errs, err)
	if err := errors.Join(errs...); err != nil {
		return Config{}, fmt.Errorf("invalid configuration: %w", err)
	}
	return cfg, nil
}

var digits = regexp.MustCompile(`^\d+$`)

func parsePort(lookup Lookup) (int, error) {
	v, ok := lookup("SIPGES_PORT")
	if !ok {
		return 8000, nil
	}
	port, err := strconv.Atoi(v)
	if !digits.MatchString(v) || err != nil || port < 1 || port > 65535 {
		return 0, errors.New("SIPGES_PORT must be an integer between 1 and 65535")
	}
	return port, nil
}

// parseSwitch accepts unset or exactly '0' / '1', as the TypeScript API does.
func parseSwitch(lookup Lookup, name string, fallback bool) (bool, error) {
	v, ok := lookup(name)
	if !ok {
		return fallback, nil
	}
	if v != "0" && v != "1" {
		return false, fmt.Errorf("%s must be unset or exactly '0' or '1'", name)
	}
	return v == "1", nil
}

var hostname = regexp.MustCompile(`^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$`)

// parseAllowedHosts reads comma-separated host names without port, e.g. `sipges.example.org,localhost`.
func parseAllowedHosts(lookup Lookup) ([]string, error) {
	v, _ := lookup("SIPGES_ALLOWED_HOSTS")
	var hosts []string
	for part := range strings.SplitSeq(v, ",") {
		host := strings.ToLower(strings.TrimSpace(part))
		if host == "" {
			continue
		}
		if len(host) > 253 || !hostname.MatchString(host) {
			return nil, fmt.Errorf("SIPGES_ALLOWED_HOSTS has an invalid host name: %s", host)
		}
		hosts = append(hosts, host)
	}
	return hosts, nil
}
