package cli

import (
	"bytes"
	"context"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"encoding/hex"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

// maxAnswer bounds an answer held in memory. A file goes to disk and is not bounded by this.
const maxAnswer = 64 << 20

// client speaks to one running API over HTTP. Everything goes through the same session, role,
// project and row-level checks a browser goes through: this package has no other way in.
type client struct {
	base    *url.URL
	http    *http.Client
	session *session
	project string
}

type request struct {
	method      string
	path        string
	query       url.Values
	body        []byte
	contentType string
	// output, when set, receives an answer that is not JSON.
	output string
	// anonymous sends no session and keeps nothing from the answer.
	anonymous bool
	// origin replaces the Origin header, to prove a foreign one is refused.
	origin string
	// bearer is the credential of a machine route.
	bearer string
}

type response struct {
	status int
	header http.Header
	// data is the decoded JSON answer; file describes any other answer.
	data any
	file *fileInfo
}

func isLoopback(host string) bool {
	if host == "localhost" {
		return true
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}

// newClient checks the address before anything can be sent to it: a password or a cookie over
// plain HTTP is only acceptable on this machine.
func newClient(address, caFile string, timeout time.Duration, s *session, project string) (*client, error) {
	if address == "" {
		return nil, usageError("no API address: pass --url or set SIPGES_URL")
	}
	base, err := url.Parse(strings.TrimRight(address, "/"))
	if err != nil || base.Host == "" || (base.Scheme != "https" && base.Scheme != "http") || base.Path != "" ||
		base.RawQuery != "" || base.Fragment != "" || base.ForceQuery || base.User != nil {
		return nil, usageError("--url must look like https://host[:port]")
	}
	if base.Scheme == "http" && !isLoopback(base.Hostname()) {
		return nil, usageError("plain http is only allowed on this machine: use https")
	}
	transport := &http.Transport{Proxy: nil, TLSHandshakeTimeout: 10 * time.Second}
	if caFile != "" {
		pem, err := os.ReadFile(caFile) //nolint:gosec // the caller names their own certificate
		if err != nil {
			return nil, localError("read the certificate: %v", err)
		}
		pool := x509.NewCertPool()
		if !pool.AppendCertsFromPEM(pem) {
			return nil, localError("%s holds no certificate", caFile)
		}
		transport.TLSClientConfig = &tls.Config{RootCAs: pool, MinVersion: tls.VersionTLS12}
	}
	if s == nil {
		s = &session{URL: base.String()}
	}
	if s.Cookies == nil {
		s.Cookies = map[string]string{}
	}
	if s.URL != base.String() {
		return nil, usageError("the saved session belongs to %s, not %s: sign in to this one", s.URL, base.String())
	}
	return &client{
		base: base,
		http: &http.Client{
			Transport: transport,
			Timeout:   timeout,
			// A redirect is an answer to report, and following one could carry the cookie away.
			CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
		},
		session: s,
		project: project,
	}, nil
}

// do sends one request. Only a failure to reach the API is an error; every answer, a 500
// included, is a response for the caller to read.
func (c *client) do(ctx context.Context, r request) (*response, error) {
	target, err := url.Parse(c.base.String() + r.path)
	if err != nil {
		return nil, usageError("bad path: %v", err)
	}
	if len(r.query) > 0 {
		target.RawQuery = r.query.Encode()
	}
	var body io.Reader
	if r.body != nil {
		body = bytes.NewReader(r.body)
	}
	outgoing, err := http.NewRequestWithContext(ctx, r.method, target.String(), body)
	if err != nil {
		return nil, usageError("bad request: %v", err)
	}
	outgoing.Header.Set("Accept", "application/json")
	outgoing.Header.Set("Origin", c.base.Scheme+"://"+c.base.Host)
	if r.origin != "" {
		outgoing.Header.Set("Origin", r.origin)
	}
	if r.bearer != "" {
		outgoing.Header.Set("Authorization", "Bearer "+r.bearer)
	}
	if r.contentType != "" {
		outgoing.Header.Set("Content-Type", r.contentType)
	}
	if !r.anonymous {
		if len(c.session.Cookies) > 0 {
			outgoing.Header.Set("Cookie", c.cookieHeader())
		}
		if c.project != "" {
			outgoing.Header.Set("X-SIPGES-Scope", c.project)
		}
	}
	answer, err := c.http.Do(outgoing)
	if err != nil {
		return nil, networkError(scrubURL(err))
	}
	defer func() { _ = answer.Body.Close() }()
	if !r.anonymous {
		c.keepCookies(answer)
	}
	return readAnswer(answer, r.output)
}

// cookieHeader is one line, as a browser sends it: the API reads a single Cookie header.
func (c *client) cookieHeader() string {
	parts := make([]string, 0, len(c.session.Cookies))
	for name, value := range c.session.Cookies {
		parts = append(parts, name+"="+value)
	}
	sort.Strings(parts)
	return strings.Join(parts, "; ")
}

// scrubURL drops the request address from a transport error: a query may name a person.
func scrubURL(err error) error {
	if wrapped, ok := err.(*url.Error); ok { //nolint:errorlint // only the outermost wrapper has the URL
		return wrapped.Err
	}
	return err
}

// keepCookies follows the API's Set-Cookie: a value, or its removal.
func (c *client) keepCookies(answer *http.Response) {
	for _, cookie := range answer.Cookies() {
		if cookie.MaxAge < 0 || cookie.Value == "" {
			delete(c.session.Cookies, cookie.Name)
			continue
		}
		c.session.Cookies[cookie.Name] = cookie.Value
	}
}

func readAnswer(answer *http.Response, output string) (*response, error) {
	result := &response{status: answer.StatusCode, header: answer.Header}
	contentType := answer.Header.Get("Content-Type")
	switch {
	case strings.HasPrefix(contentType, "text/event-stream"):
		// A stream never ends: its first headers are the whole proof it opened.
		result.file = &fileInfo{ContentType: contentType, Stream: true}
		return result, nil
	case strings.HasPrefix(contentType, "application/json") && (output == "" || answer.StatusCode != http.StatusOK):
		body, err := io.ReadAll(io.LimitReader(answer.Body, maxAnswer+1))
		if err != nil {
			return nil, networkError(err)
		}
		if len(body) > maxAnswer {
			return nil, &exitError{exit: ExitFailed, code: "too_large", detail: "the JSON answer is over 64 MiB"}
		}
		if len(bytes.TrimSpace(body)) == 0 {
			return result, nil
		}
		if err := json.Unmarshal(body, &result.data); err != nil {
			return nil, &exitError{exit: ExitFailed, code: "bad_json", detail: "the API answered invalid JSON"}
		}
		return result, nil
	}
	sink := io.Discard
	var finish func(bool) error
	if output != "" && answer.StatusCode == http.StatusOK {
		file, done, err := openOutput(output)
		if err != nil {
			return nil, err
		}
		sink, finish = file, done
	}
	hash := sha256.New()
	size, err := saveBody(io.MultiWriter(sink, hash), answer.Body)
	if finish != nil {
		if doneErr := finish(err == nil); doneErr != nil {
			return nil, doneErr
		}
	}
	if err != nil {
		return nil, err
	}
	result.file = &fileInfo{ContentType: contentType, Bytes: size, SHA256: hex.EncodeToString(hash.Sum(nil))}
	if finish != nil {
		result.file.Path = output
	}
	return result, nil
}

// sinkWriter remembers a failure of the destination, which io.Copy mixes with the source's.
type sinkWriter struct {
	io.Writer
	err error
}

func (s *sinkWriter) Write(p []byte) (int, error) {
	n, err := s.Writer.Write(p)
	if err != nil {
		s.err = err
	}
	return n, err
}

// saveBody copies an answer: a failed write is this machine's, a failed read is the network's.
func saveBody(sink io.Writer, body io.Reader) (int64, error) {
	tracked := &sinkWriter{Writer: sink}
	size, err := io.Copy(tracked, body)
	switch {
	case tracked.err != nil:
		return size, localError("write the output file: %v", tracked.err)
	case err != nil:
		return size, networkError(err)
	}
	return size, nil
}

// openOutput writes beside the target and renames at the end: a broken download leaves nothing,
// and an existing file is never replaced.
func openOutput(path string) (io.Writer, func(bool) error, error) {
	if _, err := os.Lstat(path); err == nil {
		return nil, nil, localError("%s already exists", path)
	}
	temp, err := os.CreateTemp(filepath.Dir(path), ".download-*")
	if err != nil {
		return nil, nil, localError("create the output file: %v", err)
	}
	finish := func(complete bool) error {
		closeErr := temp.Close()
		if !complete || closeErr != nil {
			_ = os.Remove(temp.Name())
			if closeErr != nil {
				return localError("write the output file: %v", closeErr)
			}
			return nil
		}
		// Link, not rename: it fails if the name was taken in the meantime.
		if err := os.Link(temp.Name(), path); err != nil {
			_ = os.Remove(temp.Name())
			return localError("write the output file: %v", err)
		}
		return os.Remove(temp.Name())
	}
	return temp, finish, nil
}
