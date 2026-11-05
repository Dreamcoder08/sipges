package objectstore

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
	"unicode/utf8"
)

// S3Options configures S3 (s3-object-storage.ts S3Options).
type S3Options struct {
	// Endpoint is the base URL of the S3-compatible API, e.g. https://<account>.r2.cloudflarestorage.com.
	Endpoint    string
	Region      string
	Bucket      string
	Credentials Credentials
	// Client is injected by tests; nil means a client of its own.
	Client *http.Client
	// Now is injected by tests; nil means time.Now.
	Now func() time.Time
}

// S3 is the path-style S3 client of s3-object-storage.ts, limited to the three calls evidence
// needs. Objects are private (no ACL headers); downloads always go through the API, which
// checks the tenant first.
type S3 struct {
	scheme, host string
	opts         S3Options
}

// NewS3 validates the endpoint (an absolute http(s) URL) and returns the client.
func NewS3(opts S3Options) (*S3, error) {
	u, err := url.Parse(opts.Endpoint)
	if err != nil || u.Host == "" || (u.Scheme != "https" && u.Scheme != "http") {
		return nil, fmt.Errorf("SIPGES_S3_ENDPOINT must be an absolute URL")
	}
	if opts.Client == nil {
		opts.Client = &http.Client{}
	}
	if opts.Now == nil {
		opts.Now = time.Now
	}
	return &S3{scheme: u.Scheme, host: urlHost(u), opts: opts}, nil
}

// urlHost is WHATWG URL#host: the lower-cased host name, with the port only when it is not the
// scheme's default (fetch sends, and the signature names, that host).
func urlHost(u *url.URL) string {
	host := strings.ToLower(u.Hostname())
	if strings.Contains(host, ":") {
		host = "[" + host + "]"
	}
	defaultPort := u.Scheme == "https" && u.Port() == "443" || u.Scheme == "http" && u.Port() == "80"
	if port := u.Port(); port != "" && !defaultPort {
		host += ":" + port
	}
	return host
}

func (s *S3) send(ctx context.Context, method, key string, body []byte, contentType string) (*http.Response, error) {
	segments := strings.Split(key, "/")
	for i, seg := range segments {
		segments[i] = encodeSegment(seg)
	}
	path := "/" + encodeSegment(s.opts.Bucket) + "/" + strings.Join(segments, "/")
	at := s.opts.Now()
	payloadHash := sha256Hex(body)
	headers := map[string]string{
		"x-amz-content-sha256": payloadHash,
		"x-amz-date":           amzDate(at),
	}
	if contentType != "" {
		headers["content-type"] = contentType
	}
	authorization := sign(signInput{
		Method: method, Path: path, Host: s.host, Region: s.opts.Region, Headers: headers,
		PayloadHash: payloadHash, At: at, Credentials: s.opts.Credentials,
	})
	var reader io.Reader
	if body != nil {
		reader = bytes.NewReader(body)
	}
	req, err := http.NewRequestWithContext(ctx, method, s.scheme+"://"+s.host+path, reader)
	if err != nil {
		return nil, err
	}
	req.Host = s.host
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	req.Header.Set("Authorization", authorization)
	return s.opts.Client.Do(req)
}

// fail is fail of s3-object-storage.ts: the status and up to 300 characters of the body. The
// error is logged by the caller as an event only, never sent to the client.
func fail(action string, res *http.Response) error {
	b, _ := io.ReadAll(io.LimitReader(res.Body, 4096))
	text := string(b)
	if utf8.RuneCountInString(text) > 300 {
		text = string([]rune(text)[:300])
	}
	return fmt.Errorf("S3 %s failed with %d: %s", action, res.StatusCode, text)
}

func ok(status int) bool { return status >= 200 && status < 300 }

// Put stores data under key with its content type.
func (s *S3) Put(ctx context.Context, key string, data []byte, contentType string) error {
	if data == nil {
		data = []byte{}
	}
	res, err := s.send(ctx, http.MethodPut, key, data, contentType)
	if err != nil {
		return err
	}
	defer func() { _ = res.Body.Close() }()
	if !ok(res.StatusCode) {
		return fail("PUT", res)
	}
	return nil
}

// Get reads the object; found=false on 404.
func (s *S3) Get(ctx context.Context, key string) ([]byte, bool, error) {
	res, err := s.send(ctx, http.MethodGet, key, nil, "")
	if err != nil {
		return nil, false, err
	}
	defer func() { _ = res.Body.Close() }()
	if res.StatusCode == http.StatusNotFound {
		return nil, false, nil
	}
	if !ok(res.StatusCode) {
		return nil, false, fail("GET", res)
	}
	data, err := io.ReadAll(res.Body)
	if err != nil {
		return nil, false, err
	}
	return data, true, nil
}

// Delete removes the object; a missing one (404) is not an error.
func (s *S3) Delete(ctx context.Context, key string) error {
	res, err := s.send(ctx, http.MethodDelete, key, nil, "")
	if err != nil {
		return err
	}
	defer func() { _ = res.Body.Close() }()
	if !ok(res.StatusCode) && res.StatusCode != http.StatusNotFound {
		return fail("DELETE", res)
	}
	return nil
}
