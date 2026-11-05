// Package objectstore holds the evidence file storage adapters of
// apps/api/src/contexts/evidence/infrastructure: Cloudflare R2 (or any S3-compatible API)
// signed with SigV4, a local directory, and an in-memory fake for tests. The adapter is chosen
// from the same environment variables as apps/api/src/platform/config.ts; credentials come
// only from there, never from code or tests.
package objectstore

import (
	"context"
	"errors"
	"fmt"
	"net/url"
	"regexp"
	"strconv"
	"strings"
)

// Storage is what every adapter provides (the application.ObjectStorage port).
type Storage interface {
	Put(ctx context.Context, key string, data []byte, contentType string) error
	Get(ctx context.Context, key string) ([]byte, bool, error)
	Delete(ctx context.Context, key string) error
}

// Lookup reads one environment variable; os.LookupEnv satisfies it.
type Lookup func(key string) (string, bool)

// Upload size limits of config.ts (SIPGES_MAX_UPLOAD_BYTES, docs/adr/0008 #9).
const (
	DefaultMaxUploadBytes = 10 * 1024 * 1024
	maxUploadCeiling      = 100 * 1024 * 1024
)

var digits = regexp.MustCompile(`^\d+$`)

// MaxUploadBytes is parseMaxUpload: unset means 10 MiB; otherwise digits only, 1..100 MiB.
func MaxUploadBytes(lookup Lookup) (int, error) {
	v, ok := lookup("SIPGES_MAX_UPLOAD_BYTES")
	if !ok {
		return DefaultMaxUploadBytes, nil
	}
	n, err := strconv.Atoi(v)
	if !digits.MatchString(v) || err != nil || n < 1 || n > maxUploadCeiling {
		return 0, fmt.Errorf("SIPGES_MAX_UPLOAD_BYTES must be an integer between 1 and %d", maxUploadCeiling)
	}
	return n, nil
}

// localHosts are LOCAL_HOSTS: the only hosts an http (not https) endpoint may name.
var localHosts = map[string]bool{"localhost": true, "127.0.0.1": true, "::1": true}

// FromEnv is parseStorage plus createObjectStorage: SIPGES_STORAGE `local` (default, directory
// SIPGES_UPLOAD_DIR, default .data/uploads) or `s3` (SIPGES_S3_ENDPOINT, SIPGES_S3_REGION
// default `auto`, SIPGES_S3_BUCKET, SIPGES_S3_ACCESS_KEY_ID, SIPGES_S3_SECRET_ACCESS_KEY).
// Errors name the variable, never its value.
func FromEnv(lookup Lookup) (Storage, error) {
	kind, ok := lookup("SIPGES_STORAGE")
	if !ok {
		kind = "local"
	}
	switch kind {
	case "local":
		dir, ok := lookup("SIPGES_UPLOAD_DIR")
		if !ok {
			dir = ".data/uploads"
		}
		return NewLocal(dir)
	case "s3":
	default:
		return nil, errors.New("SIPGES_STORAGE must be 'local' or 's3'")
	}
	required := func(name string) (string, error) {
		v, _ := lookup(name)
		if v == "" {
			return "", fmt.Errorf("%s is required when SIPGES_STORAGE=s3", name)
		}
		return v, nil
	}
	endpoint, err := required("SIPGES_S3_ENDPOINT")
	if err != nil {
		return nil, err
	}
	u, err := url.Parse(endpoint)
	if err != nil || u.Scheme == "" || u.Host == "" {
		return nil, errors.New("SIPGES_S3_ENDPOINT must be an absolute URL")
	}
	scheme := strings.ToLower(u.Scheme)
	if local := scheme == "http" && localHosts[strings.ToLower(u.Hostname())]; scheme != "https" && !local {
		return nil, errors.New("SIPGES_S3_ENDPOINT must use https (http only for a local test server)")
	}
	region, ok := lookup("SIPGES_S3_REGION")
	if !ok {
		region = "auto"
	}
	opts := S3Options{Endpoint: endpoint, Region: region}
	for _, f := range []struct {
		name string
		to   *string
	}{
		{"SIPGES_S3_BUCKET", &opts.Bucket},
		{"SIPGES_S3_ACCESS_KEY_ID", &opts.Credentials.AccessKeyID},
		{"SIPGES_S3_SECRET_ACCESS_KEY", &opts.Credentials.SecretAccessKey},
	} {
		if *f.to, err = required(f.name); err != nil {
			return nil, err
		}
	}
	return NewS3(opts)
}
